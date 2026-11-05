# SPEC: Live traffic dashboard for proxy.py

Status: **draft, partly implemented**. Section 3 lists what has been decided
(D1–D12, D17). `proxy.py` + `dashboard.html` implement D1–D12;
`permissions.py` + `permissions.html` + `hooks/` + `install_hooks.py` implement
D17. Section 4 lists what is still open.

## 1. Goal

While `proxy.py` is running, I open a page in the browser. It updates live and
shows the messages between the agent and the model, formatted to be easy to read.

**Readability is the main requirement.** Messages pile up fast. At a glance I
must be able to tell apart:

- my prompt (user text),
- the model's reply (assistant text),
- a tool call (`tool_use`),
- that tool's result (`tool_result`),

and follow the conversation as it grows.

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
4. **Content kinds beyond the four above** appear in the stream: `thinking`
   blocks, a long system prompt, a large `tools` list, and system reminders
   injected into user messages.
5. **Secrets pass through.** `authorization` / `x-api-key` headers are
   currently truncated when printed.
6. **Other upstreams.** `--upstream` can point at Codex, which uses a
   different API format.
7. The proxy must keep forwarding **byte for byte, unchanged**. The dashboard
   only observes.

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
[TOOL →] Bash: pytest -x
─ req #13 · 14:02:10 ─
[← RES]  1 failed: test_parse
```

### D1a. Rewritten history: divider, same thread

- If a request's `messages` is not the previous request's history plus new
  messages (context compaction, rewind, edited earlier message), the thread
  **continues** (detected by D2a's rule 2), and a prominent divider is inserted that is visually distinct
  from an exchange marker:
  `══ history rewritten (compacted: 84 → 3 msgs) [show] ══`
- The previous history stays above the divider. `[show]` reveals what the new
  request's history looks like in its place (e.g. the compaction summary)
  without expanding it inline by default.

```
[MODEL]  Done with step 3.
══ history rewritten (compacted: 84 → 3 msgs) [show] ══
[YOU]    <summary of earlier work…>
[MODEL]  Continuing with step 4.
```

### D2. Side traffic and multiple conversations: sidebar of threads

- A **left sidebar lists threads**: the main conversation, each subagent as
  its own thread, and side calls (title/summary generation, token counting,
  etc.) grouped under one "side calls" entry with a count.
- The **main thread is selected by default**. Clicking an entry switches the
  main pane to that thread.
- Threads with **live or unread activity** show an indicator (e.g. `●`), so
  activity elsewhere is visible without leaving the current thread.

```
┌ threads ──────┐┌ main ─────────────────────
│● main         ││[YOU]    fix the test
│  subagent 1 ● ││[MODEL]  Spawning explorer…
│  subagent 2   ││[TOOL →] Agent: find parse()
│  side calls 7 ││
└───────────────┘└───────────────────────────
```

### D2a. Thread assignment: match the start of the message history

Each `/v1/messages` request is assigned by the first of these rules that
applies:

1. **Prefix match.** The request joins a thread if that thread's history
   (the `messages` of its most recent request) is a prefix of the new
   request's `messages`. What follows the prefix is the new content that D1
   appends. If **several threads match, the longest match wins**.
2. **Rewrite fallback (resolves D1b).** If no thread matches by prefix, the
   request joins the **most recently active thread with the same system
   prompt and the same tools list**. A "history rewritten" divider (D1a) is
   inserted at that point.
3. **New thread.** Otherwise the request starts a new thread.

**What "matching" means (resolves D2b).** Messages are compared on **`role`
and `content` only**. `cache_control` and similar annotation fields, which
change from turn to turn without changing what a message says, are ignored,
including inside content blocks. Claude Code moves `cache_control` markers
onto the newest messages each turn, so an exact comparison would rarely match.

"Same system prompt and tools list" in rule 2 is compared the same way,
ignoring `cache_control` and similar fields.

"Most recently active" means the thread whose latest exchange started or
received data most recently.

```
thread A (sys S, tools T) history:  [u1, a1, u2]
thread B (sys S, tools T) history:  [u1]

new [u1, a1, u2, a2, u3]            → A (longest prefix), appends a2, u3
new [summary, u7], sys S, tools T   → no prefix match → most recent S+T
                                      thread, "history rewritten" divider
new [u9], sys S2                    → no match → new thread
```

### D3. Visual language: chat layout + color, never color alone

- **My prompt** (user text): right-aligned bubble, labelled `YOU`.
- **Model reply** (assistant text): left, full-width prose, labelled `MODEL`,
  Markdown rendered (headings, lists, code blocks).
- **Tool call** (`tool_use`): compact monospace card with a colored left rule,
  labelled `→ <tool name>`, with the key argument shown first (e.g. the
  command for Bash, the path for Read/Edit).
- **Tool result** (`tool_result`): same card style and **same hue as its
  call**, labelled `←`, with error results (`is_error`) clearly marked.
- Every kind has a **text label or icon as well as color**, so the
  distinction survives color blindness and grayscale.
- Note: on the wire, `tool_result` blocks travel in `role: "user"` messages.
  They must **never** be rendered as `YOU`. Only user `text` blocks are "my
  prompt".

```
                 ┌───────────────────┐
                 │ YOU  fix the test │
                 └───────────────────┘
MODEL  Let me look at it.
┃ → Bash  pytest -x
┃ ← exit 1 · 1 failed: test_parse
MODEL  The bug is in parse()…
```

### D3a. Injected text, thinking, errors: muted and collapsed

- **Injected text** (system reminders, hook output, attached file context:
  anything in a user message that I did not type) is **split out of my
  bubble** into a small grey `▸ injected: <kind> (n)` chip, collapsed by
  default. My `YOU` bubble contains only what I typed.
- **Thinking** blocks: a dim, italic, collapsed `▸ thinking (14 lines)`
  block placed before the reply it belongs to.
- **API errors / non-200 responses**: a red full-width banner with status and
  message (e.g. `529 overloaded`).
- All three keep a text label (D3's "never color alone" rule).

```
                 ┌─────────────────────┐
                 │ YOU  fix the test   │
                 └─────────────────────┘
                 ▸ injected: system-reminder (2)
▸ thinking (14 lines)
MODEL  Let me look at it.
██ 529 overloaded · retrying ██
```

### D4. Tool results attach under their call

- Each `tool_use` gets its own card. Its `tool_result` (matched by
  `tool_use_id`) **fills into that card** when it arrives, even though on the
  wire it comes in the next request.
- Until the result arrives, the card shows `running…`.
- Parallel calls are separate cards in the order the model issued them, each
  filled independently.
- Interaction with D1: the result appears inside the call's card, *above* the
  exchange marker of the request that carried it. That request's marker
  therefore starts with the model's next reply.

```
MODEL  Checking both files.
┃ → Read  src/util.py
┃ ← 120 lines  [expand]
┃ → Read  tests/test_util.py
┃ ← running…
```

### D5. Long content: any block over ~15 lines collapses

- **Every block kind** (my prompts, model prose, tool inputs, tool results)
  collapses when it is longer than **about 15 lines**.
- A collapsed block shows **the first few lines as a preview** plus the
  **number of hidden lines** as the expander: `▸ 117 more lines`.
- A tool card that collapses also keeps its one-line summary (tool name, key
  argument, result size or exit status), so the pair is still readable when
  folded.

```
┃ ← 132 lines
┃   1  import re
┃   2  def parse(s):
┃   3      ...
┃   ▸ 129 more lines
```

### D6. Live streaming: token-by-token, sticky scroll

- Reply text **grows live** as `content_block_delta` events arrive. Tool-call
  arguments (`input_json_delta`) also stream into their card.
- **Sticky auto-scroll**: the page follows new content only while I am at
  the bottom. If I scroll up to read, it stops following and shows a
  `↓ N new messages` button that jumps back down and resumes following.
- A block that grows past the D5 threshold while streaming collapses under
  the same rule.

```
MODEL  The bug is in parse(): it█

            [ ↓ 3 new messages ]
```

### D7. System prompt and tools: thread header, on demand

- Each thread starts with a **collapsed header**:
  `▸ System prompt (412 lines) · ▸ Tools (23)`. Clicking opens the full
  system prompt, or the list of tools (each tool's description and schema
  expandable in turn).
- They are never repeated per request. If either one **changes mid-thread**,
  a small divider notes it (`system prompt changed` / `tools changed`) with a
  diff on demand.

```
┌ main ───────────────────────────────────
│ ▸ System prompt (412 lines) · ▸ Tools (23)
├─────────────────────────────────────────
│                  [YOU  fix the test]
│ MODEL  Let me look at it.
```

### D8. Metadata: minimal in the marker, the rest on hover

- The exchange marker (D1) shows **request number, time, duration and
  output tokens**: `─ req #13 · 14:02:10 · 1.8s · 240 out ─`.
- **Hovering or clicking** the marker reveals model, input tokens, cache
  read / cache write tokens, output tokens, stop reason and HTTP status.
- No running totals for now. They were not chosen and may be added later.

```
─ req #13 · 14:02:10 · 1.8s · 240 out ─
   (hover) model: claude-opus-5-5
           in 12,034 · cache read 11,800
           out 240 · stop: tool_use · 200 OK
```

### D9. Architecture: inside proxy.py, separate port, SSE

- The dashboard is **served by proxy.py itself**, so there is one command to
  run. It uses a **separate local port** (default `8042`, next to the proxy's
  `8041`), so no dashboard path ever overlaps the traffic forwarded to the API.
- The page receives live updates over **Server-Sent Events** (plain HTTP,
  doable with the stdlib).
- Startup prints both URLs:

```
python3 proxy.py
  proxy      http://localhost:8041 -> api.anthropic.com
  dashboard  http://localhost:8042

agent → :8041 → upstream
           ↓ events
browser ← :8042 (SSE)
```

- **Constraint:** observing must never affect forwarding. Bytes are still
  relayed unchanged and as they arrive. A slow or disconnected browser, or a
  parsing failure in the dashboard code, must not delay, alter or break the
  agent's request.

### D9a. Division of work: proxy stores raw, browser rebuilds

- The proxy **only stores and streams raw traffic**. For each exchange that
  means the request (method, path, headers, body) and the response (status,
  headers, the raw SSE / body chunks as they arrive), plus timestamps and an
  exchange id. It does not parse messages, assign threads or render anything.
- The **browser does all reconstruction**: parsing request bodies and SSE
  events, assigning threads (D2a), working out deltas and rewrites (D1, D1a),
  pairing tools (D4), and everything visual.
- Consequences:
  - Reconstruction bugs can never affect forwarding, which supports the D9
    constraint. The proxy-side addition stays small and stdlib-only (D11).
  - On page open, the full-history replay (D10) is a replay of **raw events**.
    The browser rebuilds every thread from them, so each tab rebuilds
    independently.

```
proxy:   agent traffic → [raw event log, in memory] → SSE /events
browser: raw events → parse → threads → render
```

### D10. History: in memory, full replay on open

- The proxy keeps **all traffic since it started, in memory**.
- A newly opened or reloaded page first receives the **full history**, then
  continues live with no gap and no duplicates. Several tabs can be open at
  once.
- **Nothing is written to disk.** Restarting the proxy starts with an empty
  dashboard.

```
14:00 proxy starts
14:05 traffic…
14:20 open page  → sees 14:05–14:20, then live
15:00 restart    → empty
```

### D11. Dependencies: zero install, no build

- The server side remains **Python stdlib only**. `python3 proxy.py` is still
  all you need to run it.
- The page is **plain HTML/CSS/JS** served by the proxy: no npm, no build
  step, and **no CDN or other network fetches**, so it works offline.
- Markdown rendering (D3) is a **small hand-written subset**: headings,
  lists, emphasis, inline code, fenced code blocks, links.

### D12. Provider scope: Anthropic only, with a raw fallback

- Version one fully renders **Anthropic Messages traffic only**
  (`/v1/messages` requests and their SSE replies).
- Any other traffic (Codex via `--upstream`, other endpoints, bodies that
  don't parse) **still appears**, as plain request/response cards with the
  body pretty-printed. Nothing is dropped silently.
- Codex / OpenAI Responses support is **future work**.

```
/v1/messages        → full thread view
anything else       → ┃ POST /responses
                      ┃ { pretty-printed JSON … }
```

### D17. Permissions tracker: hooks into a separate page, proxy untouched

- Goal: while watching a session, see the **permission mode**
  (`default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`, …), **which
  tool calls asked** for permission, and whether each was **allowed or
  denied**. Visually secondary to the conversation: small, grey, text labels.
- The API traffic carries only part of this: denials come back as error
  `tool_result`s, and plan mode shows up in injected reminders. Prompts,
  "allowed" decisions and the exact mode are only in **Claude Code hooks**,
  whose JSON input carries `session_id`, `hook_event_name`,
  `permission_mode`, and for tool events `tool_name`, `tool_input` and (except
  `PermissionRequest`) `tool_use_id`.
- **`proxy.py` is not changed.** The hook receiver is a **separate stdlib
  process**, `permissions.py`, with its own page. Reasons: the proxy stays
  exactly as reviewed (D9: nothing new can ever touch forwarding), and either
  process runs without the other.
- The dashboard (D9, CSP `default-src 'none'`, `connect-src 'self'`) cannot
  fetch from another port, so it **only shows what the traffic shows** (D17c)
  and links to the permissions page. Hook data is never merged into the
  dashboard's threads.

```
claude ─ hooks → forward.sh ─ POST → permissions.py :8043 → page (SSE)
   └── API → proxy.py :8041 → upstream
                   └→ dashboard :8042  (traffic-only hints, link → :8043)
```

### D17a. Hook transport: raw in, never blocking

- `permissions.py` (default port **8043**, `--port`, bound to `127.0.0.1`)
  serves `GET /` (`permissions.html`), `GET /events` (SSE) and
  `POST /hooks`. It follows D9a / D10 exactly: it **stores each hook's raw
  JSON body in memory** with a sequence number and timestamp, streams it,
  replays everything on page open, and interprets nothing.
- `hooks/forward.sh` is the hook command: `curl -s -m 1` posts stdin to
  `$PERMISSIONS_HOOKS_URL` (default `http://127.0.0.1:8043/hooks`), prints
  nothing, and **always exits 0**. If `permissions.py` is down, Claude Code
  behaves exactly as without the hook and waits at most 1 s.
- `install_hooks.py` (stdlib) adds the hook to a settings file: default
  `~/.claude/settings.json`, `--settings PATH`, `--url URL`, `--uninstall`.
  It writes a **timestamped backup** before changing a file, keeps every
  other setting and hook, and is **idempotent** (entries that run its
  `forward.sh` are replaced, never duplicated).
- Events installed: `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
  `PostToolUse`, `PostToolUseFailure`, `Stop` (tool events with matcher
  `*`). A `PermissionDenied` event is understood if it arrives.

### D17b. Inference rules (in the permissions page)

- **Mode**: the latest `permission_mode` seen for the session. A **mode
  change** is a hook whose `permission_mode` differs from the previous one for
  that session. The first value seen is logged as "first seen", not a change.
- **Call**: each `PreToolUse` creates a tool card, keyed by `tool_use_id`.
- **Request → call**: a `PermissionRequest` joins its call by `tool_use_id`
  if present, else the **latest unfinished call in the same session with
  the same tool name and input** (compared ignoring key order and
  `cache_control`) that has no request yet. With no match it gets a card of
  its own.
- **Allowed**: a `PostToolUse` (or a `PostToolUseFailure` that is not a
  denial: the tool ran, then failed) for that call.
- **Denied**: a `PostToolUseFailure` / `PermissionDenied` whose text is a
  denial; or, **inferred**, nothing arrives before the session's next
  `UserPromptSubmit` or `Stop`. Explicit evidence overrides an inference.
- A denial with no prompt before it (deny rule, mode) is shown as `✕ denied`
  without "asked".
- **Sessions, not threads.** The page is organised by `session_id` (sidebar:
  "all sessions" + one entry per session with its mode). Subagent tool calls
  carry the parent's `session_id`, so they appear in that session. Hooks
  that arrive before any traffic, or with no proxy running at all, need no
  mapping.

```
┌ sessions ─────┐┌ permission mode: plan · 2 asked · 1 allowed · 1 denied ─
│ all sessions  ││                              YOU  clean up the repo
│ session 1a2b ●││ ┃ → Bash  ls -la                    ✓ asked → allowed
│  mode: plan   ││ ┃ ← done
└───────────────┘│ ┃ → Bash  rm -rf build              ✕ asked → denied
                 │ ┃ ← ✕ not run (denied)
                 │     — permission mode: default → plan —
```

- A **Permissions** tab lists every request and mode change in order:
  time, session, event (`request` / `denial` / `mode change`), tool + key
  argument (or `from → to`), outcome (`? pending…`, `✓ allowed`, `✕ denied`,
  plus why, e.g. `inferred: no result before Stop`).

### D17c. Dashboard: traffic-only hints

- A tool card whose `tool_result` is an error with denial text gets a badge:
  `✕ asked → denied` for "The user doesn't want to proceed with this tool
  use…", `✕ denied` for "Permission to use … has been denied" (no prompt).
  The card's rule turns dashed red; the badge carries the text (D3).
- A thin status line above the thread shows the mode the traffic implies:
  `plan` after a "Plan mode is active" reminder, `not plan` after an
  "Exited plan mode" reminder, otherwise `unknown`. A change adds a grey
  divider `— permission mode: plan → not plan —` before the new messages.
- The sidebar has a plain link `permissions page ↗` to the dashboard's port
  + 1 (8043 by default). `allowed` and pending prompts are **not** shown in
  the dashboard: the traffic has no sign of them.

### D17d. Security

- Hook payloads contain tool inputs and outputs (file contents, commands),
  the same material as the traffic: **in memory only**, never on disk, gone
  on restart. Nothing new is redacted (hook bodies carry no headers).
- `permissions.py` binds `127.0.0.1`, checks `Host` like the dashboard (DNS
  rebinding), and serves the same strict CSP.
- `POST /hooks` refuses requests with an `Origin` header and any content
  type other than `application/json`, so a web page cannot plant fake
  events (a cross-site JSON post needs a preflight that is never approved).
  Bodies over 16 MB are refused.
- `install_hooks.py` never runs on its own: the user runs it, and it backs
  up the file first.

## 4. Open decisions

These were not discussed, or were left open on purpose. Each one needs a
decision before or during implementation.

- D2c. How "main", "subagent" and "side call" are told apart, which thread
  is selected by default, and how threads are labelled in the sidebar.
- D2d. Consequences of D2a's rule 2 to watch for:
  - A **fresh subagent** whose first request has no prefix match but the same
    system prompt and tools as an earlier subagent of the same type would be
    attached to that earlier thread as a "rewrite", not given its own thread.
  - Starting over in the main agent (e.g. `/clear`) would likewise continue
    the main thread with a divider, not start a new one.

  Whether these are acceptable, or need an extra rule (e.g. a short new
  history that shares no messages with the thread starts a new thread), is
  open.
- D2e. The exact list of fields ignored as "similar to `cache_control`" in
  D2a's comparison.
- D3b. Rules for detecting injected text (e.g. `<system-reminder>` tags,
  separate text blocks, known hook/context wrappers), and what to do when
  detection is uncertain. How images and redacted thinking render.
- D5a. Exact preview length (how many lines count as "the first few"),
  whether the threshold is user-adjustable, and whether there is an
  expand/collapse-all control.
- D9b. Whether the dashboard port is a CLI flag (e.g. `--dashboard-port`),
  and the exact shape of the raw events (e.g. how response chunks are
  framed and encoded inside the SSE stream).
- D10a. A memory cap for very long sessions (and what happens when it is
  reached), and whether there is a "clear" button.
- D12a. Where fallback (non-Messages) cards appear: in the "side calls"
  group, their own "other traffic" sidebar entry, or somewhere else.
- D13. Security. The dashboard shows full prompts, file contents and tool
  output. To decide: bind to `127.0.0.1` only (as the proxy does now)? How
  `authorization` / `x-api-key` and other secret-looking headers are redacted
  (they are truncated in terminal output today)? Whether headers are shown in
  the UI at all?
- D14. Raw view: whether each exchange offers a "raw" toggle showing the
  exact request JSON and SSE stream, for debugging the reconstruction.
- D15. Search and filtering within a thread (e.g. show only tool calls, find
  text). Not discussed.
- D16. Light/dark theme and the concrete color palette for D3's kinds. Not
  discussed.

## 5. Acceptance criteria

Manual checks to run during the lab. Setup: `python3 proxy.py`, then
`ANTHROPIC_BASE_URL=http://localhost:8041 claude` in a second terminal, then
open `http://localhost:8042`. Each check names the decisions it covers.

- [ ] **Startup (D9, D11).** One command prints both the proxy and dashboard
  URLs. The page loads, and the browser's network tab shows no requests
  outside `localhost`.
- [ ] **One task with a tool call (D3, D3a, D4).** Ask *"How many files are
  in this folder? Use a shell command."* The page shows: a `YOU` bubble
  containing only the typed text, with any reminders in a collapsed
  `injected` chip; `MODEL` text; a `→ Bash` card whose result appears inside
  the same card, which shows `running…` until then. A tool result is never
  labelled `YOU`.
- [ ] **No repetition (D1, D8).** After three or more turns, every message
  appears exactly once. Exchange markers between them show time, duration
  and output tokens. Hovering a marker shows model, usage, stop reason and
  status.
- [ ] **Live and sticky scroll (D6).** A long reply grows as it streams. If
  you scroll up while it streams, the view stays put and `↓ N new` appears.
  Clicking it jumps back down and resumes following.
- [ ] **Long content (D5).** Ask it to read `proxy.py`. The result is
  collapsed to a few preview lines plus `▸ N more lines`, and expands on
  click.
- [ ] **System prompt and tools (D7).** The top of the thread shows a
  collapsed `System prompt (… lines) · Tools (…)` header, and it is not
  repeated anywhere else.
- [ ] **Subagent (D2, D2a).** Ask for a task that spawns a subagent. A new
  sidebar entry appears with an activity indicator. The main thread shows
  only the `Agent` call and its result. Side calls are counted under
  "side calls".
- [ ] **Compaction (D1a, D2a rule 2).** Run `/compact`, then send one more
  prompt. The same thread continues after a `history rewritten` divider,
  with no new sidebar entry.
- [ ] **Reload and second tab (D9a, D10).** Reload mid-session and open a
  second tab. Both show the same full history and keep updating live.
  Restarting the proxy gives an empty page.
- [ ] **Forwarding unaffected (D9).** Close every dashboard tab while a
  reply is streaming. The agent finishes normally, and the terminal output
  matches what the proxy printed before.
- [ ] **Errors and fallback (D3a, D12).** Run
  `curl -X POST localhost:8041/v1/messages -d '{}'`: a red error banner shows
  the status. Run `curl localhost:8041/v1/models`: it appears as a plain card
  with pretty-printed JSON.

Permissions tracker (D17). Extra setup: `python3 permissions.py` in a third
terminal, `python3 install_hooks.py` once, then restart Claude Code; open
`http://localhost:8043`.

- [ ] **Hooks never block (D17a).** Stop `permissions.py` and use Claude
  Code: nothing changes and nothing is printed. `install_hooks.py` run twice
  adds its entries once, leaves other hooks alone, and writes a backup;
  `--uninstall` removes only its entries.
- [ ] **Mode (D17b).** The status line shows the session's mode. Press
  shift+tab into plan mode and send a prompt: a grey
  `— permission mode: default → plan —` divider appears and the status
  line says `plan`.
- [ ] **Allowed (D17b).** In default mode ask for a command that needs
  approval and approve it: the card shows `asked → …` while the prompt is
  open, then `✓ asked → allowed`.
- [ ] **Denied (D17b, D17c).** Reject a prompt: the card shows
  `✕ asked → denied` (inferred at the next prompt or `Stop` if no other
  signal). In the dashboard the same call's card shows `✕ asked → denied`
  once the denial `tool_result` is sent.
- [ ] **Permissions tab (D17b).** Lists every request and mode change in
  order, with time, session, tool + key argument and outcome.
- [ ] **Replay (D10, D17a).** Reloading the permissions page shows the
  same history; restarting `permissions.py` gives an empty page.
- [ ] **Proxy unchanged (D17).** `git diff` shows no change to `proxy.py`.
