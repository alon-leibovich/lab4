# Spec history: live traffic dashboard

How `SPEC.md` evolved during Lab 4, what each build showed, and why the spec
changed. Commits are in the `lab4` repository.

## Revision 1: the pre-lab draft (commit `ed2aec2`)

Drafted with the agent before the lab. The agent read `proxy.py` and raised
open decisions one at a time; we answered them and the spec was updated during
the discussion.

- **Main decisions:** one reconstructed chat thread per conversation, because
  every request resends the whole history (D1); a "history rewritten" divider
  for compaction and rewinds (D1a); a sidebar of threads for subagents and side
  calls (D2); color plus a text label for every kind of message (D3); tool
  results inside their call's card (D4); anything over ~15 lines collapsed
  (D5); token-by-token streaming with sticky scroll (D6); system prompt and
  tools in a collapsed header (D7); dashboard served by `proxy.py` on a second
  port over SSE (D9); proxy stores raw traffic, browser rebuilds (D9a);
  standard library only (D11).
- **Conflict found while writing the spec, not in code:** assigning requests to
  threads by matching the start of the history (D2a) contradicted D1a, because
  after compaction the history no longer matches. Resolved with a second rule:
  fall back to the most recent thread with the same system prompt and tools.
  Comparison ignores `cache_control`, which Claude Code moves every turn.
- **Acceptance criteria** were added as a final section, 11 manual checks.

## Build 1: from revision 1 (commit `90cc367`)

Built at home before the lab, in a fresh agent session, in about 13 minutes.
It worked on live traffic. The threads, sidebar, tool cards, markers and
Markdown replies matched the spec. It showed four problems:

1. Injected environment context (`# Environment ...`) appeared as a `YOU`
   bubble. The detection rule for injected text had been left open.
2. `tool_addition` blocks (tools added mid-conversation) appeared as large raw
   JSON cards. The spec did not know this block type.
3. An empty `thinking (0 lines)` block was shown.
4. The Bash command appeared twice in the tool card.

## Revision 2: merged with the partner's draft

We compared both pre-lab drafts and kept ours as the base: it was built on
`proxy.py`, needed nothing installed, and had already produced a working
build. The partner's draft used FastAPI, SQLite and global Claude Code hooks,
which would have made every build longer and riskier.

- **Fixes for build 1:** a concrete detection rule for injected text (D3a);
  `tool_addition` shown as a "tools added" divider and unknown blocks as
  collapsed chips (D3b); empty thinking hidden (D3b); one-line tool cards that
  show the command once (D4).
- **Taken from the partner, adapted to our design:** one-line tool summaries
  with the full input and full result one click away (D4), a `raw` link on
  every item and a raw panel (D14), header redaction and `127.0.0.1` binding
  (D15), a status bar (D16), sessions with search and persistence to a JSONL
  file instead of SQLite (D17), permissions (D18), optional hooks installed
  per project only (D19), a "responding…" indicator (D6), red auto-expanded
  errors.
- **Conflicts resolved in favour of our design:** token-by-token streaming
  instead of complete messages only; standard library only; side calls in the
  sidebar instead of the raw log only.
- **New: build priority.** The spec grew a lot, so it was split into Tier 1
  (core) and Tier 2 (sessions, permissions, hooks). A build must make Tier 1
  work before starting Tier 2.

## Revision 3: `proxy.py` stays unmodified (commit `3908e21`)

We decided that `proxy.py` must stay exactly as provided by the course. In
revisions 1 and 2 the dashboard was built into `proxy.py`. Revision 3 moves it
into a separate `monitor.py` that sits in front of the unchanged proxy:

```
Claude Code → monitor.py :8040 → proxy.py :8041 → api.anthropic.com
                   └─ dashboard :8042
```

The monitor returns a clear `502` if `proxy.py` is not running, and the page
shows it as a red banner. Everything the page shows stayed the same.

**Update the old code or rebuild?** We considered updating build 1. We chose
to rebuild from scratch, because revision 3 changes the structure (code moves
out of `proxy.py`), and because a fresh build also tests whether the spec is
complete on its own.

## Build 2: from revision 3, from scratch

Fresh session, empty folder with only `SPEC.md` and the original `proxy.py`.
It took about 25 minutes, roughly twice as long as build 1, because the spec
was much larger.

**The agent's choices for open decisions:** main thread is the first thread
with tools, other threads with tools are subagents, tool-less requests are
side calls (D2c); collapse above 15 lines or 6,000 characters with an 8-line
preview (D5a); memory cap 1 GB and log rotation at 2 GB (D10a); theme follows
the OS setting (D21); thread search deferred (D20). It also labelled a
subagent's prompt `TASK` and a side call's prompt `PROMPT`.

**What worked:** the `502` banner when `proxy.py` was not running; `YOU`
bubble with only the typed text; environment and system reminders in
`injected:` chips; a "tools added" divider instead of raw JSON; one-line Bash
card with a description and status; markers with time, duration and tokens;
`raw` links on every item.

**What it showed:**

1. **A background request appeared as my prompt.** After each turn, Claude
   Code sends a request starting with `[SUGGESTION MODE: Suggest what the user
   might naturally type next ...]` to predict my next prompt. It resends the
   main history plus one message, so the prefix rule (D2a) attached it to the
   main thread: a large `YOU` bubble, then the model's guess ("list them")
   shown as a reply. The agent had listed this as a known risk.
2. **An empty header** `System prompt (0 lines) · Tools (0)` is shown for
   requests that have neither.
3. **The spec contradicts itself** on where an exchange marker goes (D1's text
   and its diagram disagree). The agent followed the diagram.
4. **The caps are too large** for a local tool (1 GB in memory, 2 GB file).

## Next changes (revision 4)

- Detect suggestion-mode requests and move them to side calls. More generally:
  a request that adds messages to a thread, when the thread's next request does
  not contain them, was a side branch and moves to side calls.
- Hide the system prompt / tools header when both are empty.
- Fix D1 so the text and the diagram agree.
- Set smaller caps for memory and the log file.
- Write the agent's good choices (thread types, `TASK` / `PROMPT` labels,
  preview length) into the spec, so the next build does not have to guess.
- New acceptance check: after several turns, no `YOU` bubble starts with
  `[SUGGESTION MODE`.

## Interesting things in the traffic

- A one-line question became a request of about 90 KB: most of it is the
  system prompt and tool definitions.
- Claude Code sends requests the user never sees: prompt suggestions, title
  and summary generation, token counting, a quota check.
- Context is injected into user messages: system reminders, an environment
  block with the working directory and platform, and tool definitions added
  mid-conversation (`tool_addition`).
- `cache_control` markers move to the newest messages every turn, so an exact
  comparison of histories never matches.

## Process notes

- Saving a spec over an editor buffer with unsaved changes would have erased
  the agent's edits: VS Code does not reload a file that has unsaved changes.
- Several spec versions downloaded under the same name were easy to mix up.
  Checking the content (`grep`, `head`) before committing and before each
  build confirmed the right revision was used.
- Roles in the pair: one partner builds and tests, the other is the only one
  who edits `SPEC.md`. Git carries the work between them, so the two never edit
  the same file at once.
