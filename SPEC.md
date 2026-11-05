# SPEC: Live traffic dashboard for proxy.py

Status: **draft, revision 3.** Merges our first spec with the ideas from our
partner's draft ("Session Viewer"). Python standard library only, nothing to
install. **`proxy.py` stays exactly as provided by the course, unmodified**;
the dashboard is a separate program (D9).
Section 3 lists decisions, section 4 what is still open, section 5 the
acceptance checks. Section 6 records what changed since the last build.

## 1. Goal and guiding principle

While `proxy.py` is running, I open a page in the browser. It updates live and
shows the conversation between Claude Code and the model: every prompt, every
reply, every tool call and every tool result. Sessions, permissions and the
raw API traffic are also available, but they are visually secondary.

**Readability first.** The main view is a cleaned-up, human-friendly rendering
of the conversation, *not* a dump of the data as sent. At a glance I must be
able to tell apart:

- my prompt (what I typed),
- the model's reply (assistant text),
- a tool call (`tool_use`),
- that tool's result (`tool_result`),

and follow the conversation as it grows.

**Fidelity is never lost.** Everything the main view hides or shortens stays
reachable: every item can be expanded to its full content, and every item has
a `raw` link to the exact exchange it came from (D14). When readability and
faithfulness conflict, the main view chooses readability and the raw view
keeps the fidelity.

### 1.1 Build priority

Each build implements **Tier 1 first**, makes it work, and only then Tier 2.
A build that runs out of time should deliver a working Tier 1, not a broken
Tier 1 + 2.

- **Tier 1 (core):** D1–D12, D14, D15, D16.
- **Tier 2 (extended):** D17 (sessions and persistence), D18 (permissions),
  D19 (optional hooks).

## 2. Context: what the proxy sees today

`proxy.py` is a stdlib-only reverse proxy on `127.0.0.1:8041` that prints and
forwards traffic unchanged to `https://api.anthropic.com` (or `--upstream`).
Facts the design must account for:

1. **Each request resends the whole conversation.** `POST /v1/messages` carries
   the full `messages` array plus `system` and `tools`, so turn N repeats turns
   1..N-1. Showing raw requests in sequence would show the same history
   over and over.
2. **Replies are SSE streams** (`message_start`, `content_block_start`,
   `content_block_delta`, `content_block_stop`, `message_delta`,
   `message_stop`). The proxy relays them chunk by chunk, and a reply has to be
   put back together from its deltas.
3. **Not all traffic is the main conversation.** Side calls happen too (for
   example title or summary generation on a small model, token counting,
   subagents with their own histories), and `ThreadingHTTPServer` means
   requests can overlap.
4. **Content kinds beyond the four above** appear: `thinking` blocks (possibly
   empty or redacted), a long system prompt, a large `tools` list, system
   reminders and environment context injected into user messages, and block
   types the dashboard may not know (the last build saw `tool_addition`).
5. **Secrets pass through.** `authorization` / `x-api-key` headers are
   currently truncated when printed.
6. **Other upstreams.** `--upstream` can point at Codex, which uses a
   different API format.
7. Traffic must keep flowing **byte for byte, unchanged**. The dashboard
   only observes.
8. **`proxy.py` is not modified in any way.** No line of it is added, removed
   or changed, and the dashboard does not import it or depend on how it
   prints. It runs exactly as before: `python3 proxy.py --port 8041`.

## 3. Decisions

### D1. Conversation model: reconstructed thread with exchange markers

- The main view is **one chat-style timeline per conversation**, rebuilt from
  the traffic. Each request adds only what is new compared with the previous
  request in the same conversation: new user / `tool_result` messages, then
  the streamed reply. History is never shown twice.
- **Thin dividers mark each HTTP exchange** (e.g. `─ req #13 · 14:02:10 · 1.8s ─`)
  where the new request's content starts, so wire boundaries stay visible
  without breaking the reading flow.

```
[YOU]    fix the failing test
─ req #12 · 14:02:07 · 1.8s ─
[MODEL]  Let me look at it.
▸ Bash · Run the tests  ✓
─ req #13 · 14:02:10 ─
[MODEL]  The bug is in parse()…
```

### D1a. Rewritten history: divider, same thread

- If a request's `messages` is not the previous request's history plus new
  messages (context compaction, rewind, edited earlier message), the thread
  **continues** (detected by D2a's rule 2), and a prominent divider is
  inserted that is visually distinct from an exchange marker:
  `══ history rewritten (compacted: 84 → 3 msgs) [show] ══`
- The previous history stays above the divider. `[show]` reveals what the new
  request's history looks like in its place (e.g. the compaction summary)
  without expanding it inline by default.

```
[MODEL]  Done with step 3.
══ history rewritten (compacted: 84 → 3 msgs) [show] ══
[MODEL]  Continuing with step 4.
```

### D2. Threads: sidebar, with subagents also nested under their call

- A **left sidebar lists threads** of the selected session (D17): the main
  conversation, each subagent as its own thread, and side calls
  (title/summary generation, token counting, etc.) grouped under one
  "side calls" entry with a count.
- The **main thread is selected by default**. Clicking an entry switches the
  main pane to that thread.
- Threads with **live or unread activity** show an indicator (e.g. `●`).
- **Subagents are also reachable from the main thread:** the `Agent` tool card
  (D4) expands into a nested, indented mini-timeline of that subagent's
  thread, and has an `open thread` link that selects it in the sidebar.

```
┌ threads ──────┐┌ main ─────────────────────────────
│● main         ││[YOU]    fix the test
│  subagent 1 ● ││▸ Agent · Find parse()  running…
│  side calls 7 ││    ↳ subagent 1 (12 items) [open thread]
│  other 1      ││
└───────────────┘└───────────────────────────────────
```

### D2a. Thread assignment: match the start of the message history

Each `/v1/messages` request is assigned by the first of these rules that
applies:

1. **Prefix match.** The request joins a thread if that thread's history
   (the `messages` of its most recent request) is a prefix of the new
   request's `messages`. What follows the prefix is the new content that D1
   appends. If **several threads match, the longest match wins**.
2. **Rewrite fallback.** If no thread matches by prefix, the request joins the
   **most recently active thread with the same system prompt and the same
   tools list**. A "history rewritten" divider (D1a) is inserted.
3. **New thread.** Otherwise the request starts a new thread.

**What "matching" means.** Messages are compared on **`role` and `content`
only**. `cache_control` and similar annotation fields, which change from turn
to turn without changing what a message says, are ignored, including inside
content blocks. "Same system prompt and tools list" is compared the same way.

"Most recently active" means the thread whose latest exchange started or
received data most recently. Matching only considers threads of the same
session (D17).

```
thread A (sys S, tools T) history:  [u1, a1, u2]
thread B (sys S, tools T) history:  [u1]

new [u1, a1, u2, a2, u3]            → A (longest prefix), appends a2, u3
new [summary, u7], sys S, tools T   → no prefix match → most recent S+T
                                      thread, "history rewritten" divider
new [u9], sys S2                    → no match → new thread
```

### D3. Visual language: chat layout + color, never color alone

- **My prompt** (typed user text): right-aligned bubble, labelled `YOU`, in
  large readable text.
- **Model reply** (assistant text): left, full-width prose, labelled `MODEL`,
  Markdown rendered (headings, lists, tables, code blocks).
- **Tool call + result:** one compact card per call (D4), with a colored left
  rule. A call and its result share the card and the hue.
- Every kind has a **text label or icon as well as color**, so the
  distinction survives color blindness and grayscale.
- On the wire, `tool_result` blocks travel in `role: "user"` messages. They
  must **never** be rendered as `YOU`.

### D3a. Injected text: never in my bubble

My `YOU` bubble contains **only what I typed**. Everything else that arrives
in a user message is injected context and is moved out of the bubble into a
small grey chip, collapsed by default: `▸ injected: <kind> (n)`. Expanding the
chip shows the full injected text.

**Detection rule (closes the old D3b).** A user message is split into its text
blocks, and each block is classified:

1. A block is **injected** if any of these holds:
   - it is wrapped in, or consists only of, XML-like tags that Claude Code
     adds, such as `<system-reminder>`, `<command-name>`, `<command-message>`,
     `<command-args>`, `<local-command-stdout>`, `<user-prompt-submit-hook>`;
   - it starts with an environment/context header, such as `# Environment`,
     `You have been invoked in the following environment`, or
     `Caveat: The messages below were generated`;
   - it is the content of an attached file or memory file that Claude Code
     added (e.g. contents of `CLAUDE.md`).
   Tags embedded **inside** a typed block are cut out of it the same way, and
   the remaining text stays in the bubble.
2. Every other text block is **typed** and goes in the bubble.
3. The chip's `<kind>` is the tag name or the header (`system-reminder`,
   `environment`, `command`, `file`, …). Unrecognized injected text uses
   `context`.
4. If a user message turns out to have **no typed text at all**, no empty
   `YOU` bubble is drawn, only the chip.

The patterns live in **one list in one place** in the code, so a new kind of
injected text is a one-line change.

```
                 ┌─────────────────────┐
                 │ YOU  fix the test   │
                 └─────────────────────┘
                 ▸ injected: system-reminder (2) · environment (1)
```

### D3b. Thinking, unknown blocks, errors

- **Thinking** blocks with text: a dim, italic, collapsed
  `▸ thinking (14 lines)` block before the reply it belongs to.
  **Empty thinking blocks are not shown at all.** Redacted thinking shows as
  a single `▸ thinking (redacted)` chip.
- **`tool_addition` blocks** (tools added mid-conversation) are not shown as
  cards. They update the thread's Tools header (D7) and add a thin divider:
  `─ tools added: Foo, Bar ─`, expandable to the definitions.
- **Any other unknown block type** is shown as a single collapsed grey chip
  `▸ <type>` that expands to its pretty-printed JSON. Unknown blocks never
  appear expanded in the main view.
- **API errors / non-200 responses**: a red full-width banner with status and
  message (e.g. `529 overloaded`).
- All of these keep a text label (D3's "never color alone" rule).

### D4. Tool calls: one-line card, full detail one click away

Each `tool_use` gets **one card**. Its `tool_result` (matched by
`tool_use_id`) **fills into that card** when it arrives, even though on the
wire it comes in the next request.

**Collapsed (default), one line:**
`▸ <tool name> · <summary>  <status>`

- `<summary>` is the call's `description` field when present (Bash has one).
  Otherwise a short summary of the key input: the path for Read/Edit/Write,
  the pattern for Grep/Glob, the task for Agent, else the first input value.
- `<status>` is `running…` → `✓` / `✗ error` / `denied` (D18).
- The command or input appears **once** in the card. The one-line summary
  never repeats what the expanded part shows twice.

**Expanded (click the card):**
- the **full input, untruncated**: the full command for Bash, otherwise every
  input field pretty-printed as JSON;
- the **full result**: if it is longer than the D5 threshold it shows the
  first lines plus `▸ show all (N lines)`, and `show all` reveals every line
  of it, untruncated;
- a `copy` button for the input and one for the result;
- the item's `raw` link (D14), which opens the exact `tool_use` and
  `tool_result` JSON as sent on the wire.

So any tool call can always be read **in full**, not only as a summary.

- **Errors** (`is_error`) are tinted red and **auto-expanded**.
- Parallel calls are separate cards in the order the model issued them, each
  filled independently.
- The result appears inside the call's card, *above* the exchange marker of
  the request that carried it.

```
MODEL  Checking both files.
▸ Read · src/util.py  ✓
▾ Bash · Run the tests  ✗ error
    command:  pytest -x tests/
    result:   1 failed: test_parse
              ...
              ▸ show all (48 lines)          [copy] [raw]
▸ Read · tests/test_util.py  running…
```

### D5. Long content: any block over ~15 lines collapses

- **Every block kind** (my prompts, model prose, tool results, injected text)
  collapses when it is longer than **about 15 lines**.
- A collapsed block shows **the first few lines as a preview** plus the
  **number of hidden lines** as the expander: `▸ show all (117 more lines)`.
- Expanding always shows the complete content.

### D6. Live streaming: token-by-token, sticky scroll

- Before the first token of a reply arrives, a single `MODEL is responding…`
  row is shown. Then the reply text **grows live** as `content_block_delta`
  events arrive. Tool-call arguments (`input_json_delta`) stream into their
  card's expanded view.
- **Sticky auto-scroll**: the page follows new content only while I am at
  the bottom. If I scroll up to read, it stops following and shows a
  `↓ N new` pill that jumps back down and resumes following.
- A block that grows past the D5 threshold while streaming collapses under
  the same rule.

### D7. System prompt and tools: thread header, on demand

- Each thread starts with a **collapsed header**:
  `▸ System prompt (412 lines) · ▸ Tools (23)`. Clicking opens the full
  system prompt, or the list of tools (each tool's description and schema
  expandable in turn).
- They are never repeated per request. If either one **changes mid-thread**,
  a small divider notes it (`system prompt changed` / `tools changed` /
  `tools added: …`) with a diff on demand.

### D8. Metadata: minimal in the marker, the rest on hover

- The exchange marker (D1) shows **request number, time, duration and
  output tokens**: `─ req #13 · 14:02:10 · 1.8s · 240 out ─`.
- **Hovering or clicking** the marker reveals model, input tokens, cache
  read / cache write tokens, output tokens, stop reason and HTTP status.

### D9. Architecture: a separate monitor in front of the unchanged proxy.py

- `proxy.py` is **left exactly as it is** (section 2, fact 8). The dashboard
  is a **new, separate program, `monitor.py`**, plus the page it serves.
- `monitor.py` sits **in front of** `proxy.py` in the chain. It listens on
  `127.0.0.1:8040`, records each exchange, and forwards it unchanged to
  `proxy.py` on `127.0.0.1:8041`, which forwards it to the API as before:

```
Claude Code → monitor.py :8040 → proxy.py :8041 → api.anthropic.com
                   │
                   └─ records → dashboard page :8042 (SSE) → browser
```

- The dashboard page is served by `monitor.py` on a **separate local port**,
  `8042`, so no dashboard path ever overlaps the forwarded traffic.
- Ports and target are command-line flags: `--port` (default 8040),
  `--dashboard-port` (default 8042), `--target` (default
  `http://127.0.0.1:8041`). Pointing `--target` at `https://api.anthropic.com`
  lets the monitor run without `proxy.py` if needed.
- Claude Code is pointed at the monitor:
  `ANTHROPIC_BASE_URL=http://127.0.0.1:8040 claude`.
- The page receives live updates over **Server-Sent Events**.
- Startup prints:

```
python3 monitor.py
  monitor    http://127.0.0.1:8040 -> http://127.0.0.1:8041
  dashboard  http://127.0.0.1:8042
```

- If `proxy.py` is not running, the monitor returns a clear `502` error to
  the agent and shows it as a red banner (D3b), instead of hanging.
- **Constraint:** observing must never affect forwarding. Bytes are relayed
  unchanged and as they arrive, including the real auth headers and the SSE
  stream chunk by chunk. A slow or disconnected browser, a storage failure,
  or a parsing failure in the dashboard code must not delay, alter or break
  the agent's request.

### D9a. Division of work: monitor stores raw, browser rebuilds

- The monitor **only stores and streams raw traffic** (redacted, D15). For each
  exchange: the request (method, path, headers, body) and the response
  (status, headers, the raw SSE / body chunks as they arrive), plus
  timestamps and an exchange id. It does not parse messages, assign threads
  or render anything.
- The **browser does all reconstruction**: parsing bodies and SSE events,
  grouping into sessions (D17) and threads (D2a), deltas and rewrites (D1,
  D1a), pairing tools (D4), classifying injected text (D3a), and everything
  visual.

```
monitor: agent traffic → redact → [raw event log] → SSE /events
browser: raw events → parse → sessions → threads → render
```

### D10. History: full replay on open

- A newly opened or reloaded page first receives the **full history**, then
  continues live with no gap and no duplicates. Several tabs can be open at
  once.
- What history survives a restart is decided by D17.

### D11. Dependencies: zero install, no build

- The monitor is **Python stdlib only**. Running it needs nothing beyond
  `python3 proxy.py` and `python3 monitor.py`.
- The page is **plain HTML/CSS/JS** served by the monitor: no npm, no build
  step, and **no CDN or other network fetches**, so it works offline.
- Markdown rendering is a **small hand-written subset**: headings, lists,
  tables, emphasis, inline code, fenced code blocks, links.

### D12. Provider scope: Anthropic only, with a raw fallback

- Version one fully renders **Anthropic Messages traffic only**.
- Any other traffic (Codex via `--upstream`, other endpoints, bodies that
  don't parse) **still appears** under an "other traffic" sidebar entry, as
  plain request/response cards with the body pretty-printed. Nothing is
  dropped silently.

### D14. Raw view: one click from every item

- Every item in the main view (prompt, reply, tool card, divider, chip) has a
  small `raw` link that opens the **matching exchange** in a slide-over raw
  panel, scrolled to the relevant block. The raw panel never appears inline.
- The raw panel lists every exchange of the current session, plus side calls
  and other traffic, and for each one shows:
  - request and response headers (secrets `[REDACTED]`, D15),
  - request and response bodies as collapsible, pretty-printed JSON,
  - for streamed replies, both the **reassembled message** and the **raw
    event stream**,
  - model, token counts and duration,
  - a `download JSON` button that saves the exchange.

### D15. Secrets: redacted before storing anything

- Before an exchange is stored, kept in memory, sent to the browser or
  written to disk, these headers are replaced with `[REDACTED]`
  (case-insensitive): `x-api-key`, `authorization`, `proxy-authorization`,
  `cookie`, `set-cookie`.
- Forwarding still uses the real headers; only the observed copy is redacted.
- The monitor's two ports bind to **`127.0.0.1` only**. There is no
  authentication, since access is local only.
- Message bodies are stored verbatim, so file contents Claude reads are
  visible in the dashboard. This is accepted for now.

### D16. Status bar

A thin bar above the main pane shows: session title, working directory,
`● live` if the session is active, and the current permission mode when known
(D18). It is small and visually secondary.

```
fix the failing test · /Users/alon/lab4 · ● live · mode: default
```

### D17. Sessions and persistence (Tier 2)

- **Sessions.** Traffic is grouped into sessions, one per Claude Code run.
  The browser groups by a session identifier found in the request when there
  is one (Claude Code includes a session id in `metadata.user_id`; the build
  must verify where it appears in real traffic). Without an identifier,
  traffic falls into one session per monitor run.
- **Session list.** Above the thread list, a session picker lists sessions by
  most recent activity. Each shows its title (the first typed prompt,
  truncated), working directory (taken from the injected environment
  context), start time and a `●` if active. The current session is selected
  by default.
- **Search.** A search box filters sessions by the text of typed prompts.
- **Persistence.** The monitor appends every redacted raw event to
  `data/traffic.jsonl` (one JSON object per line, stdlib only). On startup it
  loads the file, so past sessions stay browsable after a restart.
  `--no-save` disables writing to disk.
- `data/` is added to `.gitignore` from the first build. The log is never
  committed.
- A write failure is logged to the terminal and ignored; it never affects
  forwarding (D9).

### D18. Permissions (Tier 2)

Visually secondary. Derived from the traffic, and refined by hooks when they
are enabled (D19).

- **Denied tool calls.** A `tool_result` whose content says the user rejected
  the tool use (Claude Code sends text like "The user doesn't want to proceed
  with this tool use") gets status `denied` and a small `asked → denied`
  badge, instead of `✗ error`.
- **Mode changes.** When injected text shows a mode change (for example plan
  mode entered or exited), a thin grey divider appears:
  `— permission mode: default → plan —`, and the status bar updates.
- **Permissions tab.** A tab next to the timeline lists all permission
  events of the session chronologically.
- With hooks enabled (D19), the badges also show `asked → allowed`, and the
  exact mode comes from the hook data.

### D19. Optional hooks (Tier 2, off by default)

The dashboard works fully from traffic alone. Hooks only add data the traffic
does not carry (permission prompts and decisions, exact permission mode).

- The monitor accepts `POST /hooks` on the dashboard port.
- A stdlib Python script, `hooks/forward.py`, POSTs its stdin JSON there with
  a 1-second timeout, **always exits 0 and prints nothing**, so it never
  blocks, alters or delays Claude Code, even when the monitor is down.
- Hooks are installed **only per project**, into `.claude/settings.local.json`
  of the folder where Claude Code runs, by `python3 monitor.py --install-hooks`
  (with a backup of any existing file). **Never** into `~/.claude/settings.json`.
- Events: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `Notification`, `Stop`, `SubagentStop`,
  `SessionStart`, `SessionEnd`. Hook events are attached to sessions by
  `session_id` and to tool cards by `tool_use_id`.

## 4. Open decisions

- D2c. How "main", "subagent" and "side call" are told apart (e.g. by model,
  presence of tools, or the `Agent` call that spawned them).
- D2d. Consequences of D2a's rule 2 to watch for: a fresh subagent with the
  same system prompt and tools as an earlier one would be attached to that
  earlier thread as a "rewrite"; `/clear` would continue the main thread with
  a divider. Whether these need an extra rule is open.
- D2e. The exact list of fields ignored as "similar to `cache_control`" in
  D2a's comparison.
- D3c. How images in messages render.
- D5a. Exact preview length, whether the threshold is user-adjustable, and
  whether there is an expand/collapse-all control.
- D9b. The exact shape of the raw events inside the SSE stream and in
  `data/traffic.jsonl`.
- D10a. A memory and file-size cap for very long sessions, and whether there
  is a "clear" button.
- D20. Search and filtering *within* a thread (e.g. show only tool calls).
- D21. Light/dark theme and the concrete color palette.

## 5. Acceptance criteria

Manual checks to run during the lab. Setup, in three terminals:
`python3 proxy.py --port 8041`, then `python3 monitor.py`, then
`ANTHROPIC_BASE_URL=http://127.0.0.1:8040 claude`. Open
`http://127.0.0.1:8042`. Each check names the decisions it covers.

### Tier 1

- [ ] **Startup (D9, D11).** `python3 monitor.py` prints both URLs. The page
  loads, and the browser's network tab shows no requests outside `127.0.0.1`.
- [ ] **Chain works (D9).** With both programs running, Claude Code behaves
  exactly as without them, including streaming, and `proxy.py` still prints
  the traffic in its own terminal as before.
- [ ] **Proxy down (D9).** Stop `proxy.py` and send a prompt: the agent gets
  an error, not a hang, and the page shows a red `502` banner.
- [ ] **One task with a tool call (D3, D3a, D4).** Ask *"How many files are
  in this folder? Use a shell command."* The page shows a `YOU` bubble with
  only the typed text, `MODEL` text, and one `▸ Bash · <description>` card
  whose status goes from `running…` to `✓`. No tool result is labelled `YOU`.
- [ ] **No injected text in my bubble (D3a).** No `YOU` bubble contains
  `<system-reminder>`, `# Environment` or other injected text. They appear
  only in `injected:` chips, which expand to the full text. There is no empty
  `YOU` bubble.
- [ ] **Full tool call available (D4, D14).** Expanding the Bash card shows
  the full command exactly once and the full result. Ask it to read
  `proxy.py`: the result shows a preview and `show all`, which reveals every
  line. The card's `raw` link opens the exact `tool_use` / `tool_result` JSON.
- [ ] **No raw JSON in the main view (D3b).** `tool_addition` blocks appear
  only as a `tools added` divider and in the Tools header, never as JSON
  cards. Other unknown blocks appear only as collapsed chips.
- [ ] **No empty thinking (D3b).** No `thinking (0 lines)` block appears.
- [ ] **Errors (D3b, D4, D12).** A failing shell command shows a red,
  auto-expanded card. `curl -X POST 127.0.0.1:8040/v1/messages -d '{}'`
  shows a red error banner. `curl 127.0.0.1:8040/v1/models` appears under
  "other traffic" as a plain card with pretty-printed JSON.
- [ ] **No repetition (D1, D8).** After three or more turns, every message
  appears exactly once. Markers show time, duration and output tokens, and
  hovering shows model, usage, stop reason and status.
- [ ] **Live and sticky scroll (D6).** `MODEL is responding…` appears, then a
  long reply grows as it streams. Scrolling up stops following and shows
  `↓ N new`, which jumps back down.
- [ ] **System prompt and tools (D7).** One collapsed header at the top of
  the thread, not repeated anywhere else.
- [ ] **Subagent (D2, D2a).** A task that spawns a subagent creates a sidebar
  entry with an activity indicator. The main thread shows the `Agent` card,
  which expands into the nested mini-timeline and has `open thread`.
- [ ] **Compaction (D1a).** After `/compact` and one more prompt, the same
  thread continues after a `history rewritten` divider.
- [ ] **Raw panel (D14).** Every item has a `raw` link. The panel shows
  headers, bodies, the reassembled reply and the raw stream, tokens and
  duration, and `download JSON` saves a file.
- [ ] **Secrets (D15).** In the raw panel, `authorization` / `x-api-key`
  show `[REDACTED]`. `curl http://<this computer's network IP>:8042` from the
  same machine fails, because the server binds to `127.0.0.1` only.
- [ ] **Reload and second tab (D10).** Reload mid-session and open a second
  tab. Both show the same full history and keep updating live.
- [ ] **Forwarding unaffected (D9).** Close every dashboard tab while a reply
  is streaming. The agent finishes normally.

### Tier 2

- [ ] **Sessions and search (D17).** Run two Claude Code sessions one after
  the other. Both appear in the session list with title, directory and start
  time; the search box finds each one by a word from its prompt.
- [ ] **Persistence (D17).** Restart the monitor: past sessions are still
  listed and readable. `grep -i "sk-ant" data/traffic.jsonl` finds nothing,
  and `git status` does not list `data/`.
- [ ] **Denied tool (D18).** Deny a tool call when Claude Code asks. Its card
  shows `denied` with an `asked → denied` badge, and it appears in the
  Permissions tab.
- [ ] **Mode change (D16, D18).** Enter and leave plan mode. A divider
  appears and the status bar updates.
- [ ] **Hooks (D19).** After `--install-hooks`, only the project's
  `.claude/settings.local.json` changes. Allowed tool calls show
  `asked → allowed`. Stopping the monitor does not interrupt Claude Code's
  hooks.

## 6. Changes since the last build

The last build (from revision 1) showed on live traffic:

1. Injected environment context (`# Environment ...`) was rendered as a
   `YOU` bubble → D3a now has a concrete detection rule.
2. `tool_addition` blocks were shown as large raw JSON cards → D3b.
3. An empty `thinking (0 lines)` block was shown → D3b.
4. The Bash command appeared twice in the tool card → D4 redesigned.

Merged from the partner's draft, adapted to this architecture: one-line tool
summaries with full detail on expand (D4), clean prompts (D3a), raw link on
every item and raw panel (D14), secret redaction and `127.0.0.1` binding
(D15), status bar (D16), sessions, search and persistence (D17),
permissions (D18), optional per-project hooks (D19), `MODEL is responding…`
indicator (D6), auto-expanded red errors (D4).

Kept from our design where the two conflicted: token-by-token streaming
instead of complete-messages-only (D6); stdlib only instead of FastAPI and
SQLite (D11, D17 uses a JSONL file); side calls in the sidebar instead of
raw-only (D2).

**Revision 3:** `proxy.py` must stay exactly as provided. Revision 1 had the
dashboard built into `proxy.py`; it now runs as a separate `monitor.py` in
front of the unchanged proxy (D9), with the agent pointed at port 8040.
Everything the dashboard shows is unchanged.
