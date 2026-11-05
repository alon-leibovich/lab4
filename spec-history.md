# Spec history: live traffic dashboard

How `SPEC.md` evolved during Lab 4, what each build showed on live traffic, and
when and why the approach changed. Commits are in the `lab4` repository. Times
are the commit times (+02:00).

**Sources.** Everything comes from the git history and the files in the repo,
except text marked **[draft only]**. That text is first-hand from our earlier
draft of this file, and no commit or file confirms it. There is no `notes.md`.

## Timeline

| Time | Commit | Author | What |
|---|---|---|---|
| Nov 4, 13:29 | `ed2aec2` | Alon | Revision 1 of `SPEC.md`, plus the course `proxy.py` |
| Nov 4, 13:43 | `90cc367` | Alon | Build 1: `dashboard.html`, dashboard added to `proxy.py` |
| Nov 5, 10:48 | `122ac06` | noampres (branch) | Session Viewer: own spec and implementation |
| Nov 5, 10:51 | `3908e21` | Alon | Revision 3 of `SPEC.md` (also contains revision 2) |
| Nov 5, 11:20 | `de957ca` | noampres (branch) | Permissions tracker, with its own `SPEC.md` changes |
| Nov 5, 11:45 | `bcf081e` | noampres (branch) | `SPEC.md`: D22 added |
| Nov 5, 11:49 | `9d2e04f` | noampres (branch) | D22 code: `worktree.js`, `worktree-demo.html` |
| Nov 5, 11:55 | `8685eba` | merge | PR #1 merges D22 into `main` |
| Nov 5, 11:57 | `b2562d8` | Alon | `proxy.py` restored to the course original |
| Nov 5, 12:02 | `55788e0` | Alon | First draft of this file |

`SPEC.md` changed in four commits: `ed2aec2` → `3908e21` → `bcf081e` on `main`,
and `de957ca` on a branch that was not merged.

## Revision 1 (`ed2aec2`, 452 lines)

- **Main decisions:** one reconstructed chat thread per conversation, because
  every request resends the whole history (D1); a "history rewritten" divider
  for compaction and rewinds (D1a); a sidebar of threads for subagents and side
  calls (D2); color plus a text label for every kind of message (D3); tool
  results inside their call's card (D4); anything over ~15 lines collapsed
  (D5); token-by-token streaming with sticky scroll (D6); system prompt and
  tools in a collapsed header (D7); dashboard served by `proxy.py` on a second
  port over SSE (D9); proxy stores raw traffic, browser rebuilds (D9a);
  standard library only (D11).
- **Conflict found while writing the spec, before any code existed:** assigning
  requests to threads by matching the start of the history (D2a) contradicted
  D1a, because after compaction the history no longer matches. Resolved with a
  second rule: fall back to the most recent thread with the same system prompt
  and tools. Comparison ignores `cache_control`, which Claude Code moves every
  turn.
- **Left open:** 12 items, including how to detect injected text (D3b) and
  thread types (D2c).
- **Acceptance criteria:** 11 manual checks.
- **[draft only]** Drafted with the agent before the lab; it raised open
  decisions one at a time.

## Build 1 (`90cc367`, from revision 1)

Committed 14 minutes after the spec. It adds `dashboard.html` (1,247 lines) and
about 170 lines to `proxy.py`. `SPEC.md` section 6 records four problems on live
traffic:

1. Injected environment context (`# Environment ...`) appeared as a `YOU`
   bubble. The detection rule for injected text had been left open.
2. `tool_addition` blocks (tools added mid-conversation) appeared as large raw
   JSON cards. The spec did not know this block type.
3. An empty `thinking (0 lines)` block was shown.
4. The Bash command appeared twice in the tool card.

**[draft only]** Built in a fresh agent session. Threads, sidebar, tool cards,
markers and Markdown replies matched the spec.

## The partner's Session Viewer (`122ac06`, branch)

The partner's approach was a separate design with its own
`session-viewer/SPEC.md` and an implementation: one `server.py` process on
port 8787 using FastAPI and SQLite, with hooks registered in the global
`~/.claude/settings.json`. Its spec favored complete messages over live
streaming, and kept side calls in the raw log only. The history records no
live-traffic result for it. Rather than merging its code, we took its ideas
into our spec (next section).

## Revision 2: merge of the two designs (no commit of its own)

Revision 2 was never committed separately. Its changes are inside `3908e21`
together with revision 3. `SPEC.md` shows it as a stage: the numbering jumps
from 1 to 3, and section 6 lists the merge and revision 3 separately.

**Why our spec stayed the base:** it needs nothing installed and had already
produced a working build.

- **Fixes for build 1:** a concrete detection rule for injected text (D3a);
  `tool_addition` shown as a "tools added" divider and unknown blocks as
  collapsed chips (D3b); empty thinking hidden (D3b); one-line tool cards that
  show the command once (D4).
- **Taken from the partner, adapted to our design:** one-line tool summaries
  with full detail on expand (D4), subagents nested under their `Agent` card
  (D2), a `raw` link on every item and a raw panel (D14), header redaction and
  `127.0.0.1` binding (D15), a status bar (D16), sessions with search and
  persistence to a JSONL file instead of SQLite (D17), permissions (D18),
  optional hooks installed per project only (D19), a "responding…" indicator
  (D6), red auto-expanded errors (D4).
- **Conflicts resolved in favor of our design:** token-by-token streaming
  instead of complete messages only; standard library only; side calls in the
  sidebar instead of the raw log only.
- **New: build priority.** The spec was split into Tier 1 (core) and Tier 2
  (sessions, permissions, hooks). A build must make Tier 1 work before starting
  Tier 2.

## Revision 3: `proxy.py` stays unmodified (`3908e21`, +425 / −264 lines)

`proxy.py` must stay exactly as provided by the course. Until now the dashboard
was built into it. Revision 3 moves the dashboard into a separate `monitor.py`
in front of the unchanged proxy:

```
Claude Code → monitor.py :8040 → proxy.py :8041 → api.anthropic.com
                   └─ dashboard :8042
```

- The monitor returns a clear `502` if `proxy.py` is not running, and the page
  shows it as a red banner. Per section 6, everything the dashboard shows is
  unchanged.
- **Other changes in this commit:** D10's "nothing written to disk" gave way to
  persistence (D17). Several open items were closed or renumbered: security
  D13 → D15, search D15 → D20, theme D16 → D21. Acceptance criteria grew to 18
  Tier 1 and 5 Tier 2 checks.
- The commit changed only `SPEC.md`. The code on `main` did not match until
  `b2562d8` restored `proxy.py` about an hour later. That commit's `proxy.py` is
  identical to the one in `ed2aec2`.
- **[draft only]** We considered updating build 1 but rebuilt from scratch,
  because the structure changes and a fresh build also tests whether the spec
  is complete on its own.

## Build 2 (from revision 3) [draft only]

**This whole section except the D1 check comes from the draft.** The build has
no commit, and `monitor.py` is in no commit or folder we have. We also cannot
date it against the commits below.

Fresh session, with only `SPEC.md` and the original `proxy.py` in the folder.
About 25 minutes.

**The agent's choices for open decisions:** main thread is the first thread
with tools, other threads with tools are subagents, tool-less requests are side
calls (D2c); collapse above 15 lines or 6,000 characters with an 8-line preview
(D5a); memory cap 1 GB and log rotation at 2 GB (D10a); theme follows the OS
setting (D21); thread search deferred (D20). It also labelled a subagent's
prompt `TASK` and a side call's prompt `PROMPT`.

**What worked:** the `502` banner; `YOU` bubble with only the typed text;
environment and system reminders in `injected:` chips; a "tools added" divider
instead of raw JSON; one-line Bash card with description and status; markers
with time, duration and tokens; `raw` links on every item.

**What it showed:**

1. **A background request appeared as my prompt.** After each turn, Claude Code
   sends a request starting with `[SUGGESTION MODE: Suggest what the user might
   naturally type next ...]`. It resends the main history plus one message, so
   the prefix rule (D2a) attached it to the main thread: a large `YOU` bubble,
   then the model's guess shown as a reply.
2. **An empty header** `System prompt (0 lines) · Tools (0)` for requests that
   have neither.
3. **The spec contradicts itself** on where an exchange marker goes. This one
   can be checked in `SPEC.md`: D1's text puts the marker where the request's
   content starts, while its diagram puts it after `YOU`.
4. **The caps are too large** for a local tool (1 GB in memory, 2 GB file).

## The partner's permissions tracker (`de957ca`, branch, not merged)

Built on the Session Viewer branch, whose root `SPEC.md` was still revision 1,
so this spec (593 lines) does not include revision 3.

- **What changed:** a new D17 with parts D17a–d. A separate stdlib process,
  `permissions.py` on port 8043, receives Claude Code hooks and has its own page.
  It infers mode, prompts and allowed/denied decisions. `dashboard.html` gets
  traffic-only hints.
- **Why:** per its spec, traffic carries only part of this. Denials appear as
  error `tool_result`s and plan mode in injected reminders, while prompts,
  "allowed" decisions and the exact mode exist only in hooks. A separate process
  also leaves `proxy.py` untouched.
- **Live traffic:** no result recorded; its acceptance checks are unticked.
- **Outcome:** on `main`, permissions remain D18 and D19 from revision 3, a
  different design: inside the monitor, with hooks per project rather than
  global by default. D17 on `main` means sessions, so the number clashes. The
  branch is named `old/session-viewer-permissions`. The history does not record
  why it was not merged.

## D22: working directory and update tree (`bcf081e`, `9d2e04f`, PR #1)

Added by the partner after revision 3 (+104 / −1 lines), as Tier 2. The status
line still says revision 3; section 6 lists it as "added after revision 3".

- **What changed:** a Files tab showing the session's working directory and a
  folder tree of every file Claude wrote or edited, each with a timeline of
  updates (status, typed prompt, `+/-` lines, diff, `raw` link). One new
  acceptance check. Shell commands are deliberately not parsed, because the
  files they change cannot be known reliably.
- **Why this shape:** it is rebuilt from traffic only, so it needs no hooks and
  no `proxy.py` change. The code is one self-contained browser module.
- **Live traffic:** the commit message says it was tested headless against
  synthetic traffic and a real Claude Code session captured through `proxy.py`.
  The spec records what real traffic looks like: environment context arrives in
  a `role: "system"` message inside `messages`, a directory change arrives as
  `# Environment update`, and the session id is in `metadata.user_id` as a JSON
  string.
- **Not integrated:** `dashboard.html` does not load `worktree.js`; it runs only
  in `worktree-demo.html`.
- On that branch `proxy.py` was still the build 1 version with the dashboard.
  The D22 commits did not change it.

## When and why the approach changed

| Change | When | Why |
|---|---|---|
| Two designs → our stdlib spec as base, partner's ideas merged | Revision 2, in `3908e21` | Nothing to install, and already had a working build |
| Dashboard inside `proxy.py` → separate `monitor.py` | Revision 3, `3908e21`; code in `b2562d8` | `proxy.py` must stay as provided |
| Update build 1 → rebuild from scratch | Before build 2 **[draft only]** | Structure changes; tests the spec on its own |
| Tracker with global hooks on a branch → not merged | After `de957ca` | Not recorded |

## State of the repo at the end (`55788e0`)

- `SPEC.md` is revision 3 plus D22. The build 2 findings have not been written
  into it. The planned revision 4 changes below are **not applied**.
- `proxy.py` is the course original, so nothing serves `dashboard.html` any more.
  `dashboard.html` is still the build 1 file, and `monitor.py` is not in the repo.
- **Known spec inconsistencies:**
  - D1's text and diagram disagree (above).
  - D22 says the monitor redacts header names containing `session`, but D15 does
    not list them.
  - D3a expects environment context in user messages, while D22 reports it in a
    `role: "system"` message.

## Planned revision 4 [draft only]

- Detect suggestion-mode requests and move them to side calls. More generally: a
  request that adds messages to a thread, when the thread's next request does
  not contain them, was a side branch and moves to side calls.
- Hide the system prompt / tools header when both are empty.
- Fix D1 so the text and the diagram agree.
- Set smaller caps for memory and the log file.
- Write the agent's good choices (thread types, `TASK` / `PROMPT` labels, preview
  length) into the spec, so the next build does not have to guess.
- New acceptance check: after several turns, no `YOU` bubble starts with
  `[SUGGESTION MODE`.

## Interesting things in the traffic

- Side calls the user never sees: title and summary generation, token counting
  (`SPEC.md` section 2). **[draft only]** Also prompt suggestions and a quota
  check.
- Context is injected into requests: system reminders, an environment block with
  the working directory, and tool definitions added mid-conversation
  (`tool_addition`).
- `cache_control` markers move to the newest messages every turn, so an exact
  comparison of histories never matches.
- **[draft only]** A one-line question became a request of about 90 KB, mostly
  system prompt and tool definitions.

## Process notes

- **Who did what:** both partners edited `SPEC.md` and wrote code. Alon committed
  revisions 1 and 3 and build 1 on `main`. The partner worked on branches, and D22
  reached `main` through PR #1.
- **[draft only]** Saving a spec over an editor buffer with unsaved changes would
  have erased the agent's edits, because VS Code does not reload such a file.
- **[draft only]** Several spec versions downloaded under the same name were easy
  to mix up. Checking the content (`grep`, `head`) before committing and before
  each build confirmed the right revision was used.
