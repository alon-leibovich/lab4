# Session Viewer — Spec

A local website that shows, live, the conversation between the user and Claude Code: every prompt, every response, every tool call and every tool result. Permission status and the raw API traffic are also available, but they are visually secondary.

## 1. Guiding principle

**Readability first.** The main view is a cleaned-up, human-friendly rendering of the conversation. It is *not* a dump of the data as sent. Fidelity lives in the raw log (§6), which is one click away from every item but never clutters the main view.

Concretely, when readability and faithfulness conflict, the main view:
- hides injected context (`<system-reminder>` blocks, hook output, attribution boilerplate) from the user's prompts and shows only what the user typed,
- renders Markdown in responses,
- summarises tool calls in one line (e.g. `Bash · List files in Downloads`, `Read · SPEC.md`) and puts the full input behind an expander,
- truncates long tool results (default: first 20 lines) with a "show all" toggle,
- shows complete messages rather than flickering partial text (see §5.3).

## 2. Decisions taken

| Topic | Decision |
|---|---|
| Data source | Local HTTP proxy (via `ANTHROPIC_BASE_URL`) for raw API traffic, plus Claude Code hooks for tool calls, results and permission events |
| Scope | All sessions. The active one updates live and past ones can be browsed |
| Secrets | Auth headers (`x-api-key`, `authorization`, cookies) are replaced with `[REDACTED]` before anything is stored. Everything else is stored verbatim |
| Network exposure | The server binds to `127.0.0.1` only |
| Stack | Python 3.11+, FastAPI, SQLite, plain HTML/CSS/JS frontend (no build step), live updates over Server-Sent Events |
| Liveness | Items appear once complete. An in-progress response shows a "Claude is responding…" indicator (§5.3) |
| Subagents / background calls | Subagent conversations are nested and collapsed under the tool call that spawned them. Background calls (titles, summaries, etc.) appear only in the raw log |
| Git | `data/` is gitignored from day one. The database and logs are never committed |

## 3. Architecture

One Python process (`server.py`) exposes three things on `127.0.0.1:8787`:

```
Claude Code ──API requests──▶ /v1/*  (proxy) ──▶ https://api.anthropic.com
     │                              │
     └──hook events──▶ /hooks       │
                          │         │
                          ▼         ▼
                       SQLite (data/viewer.db)
                          │
                          ▼
              /  (website)  ◀── SSE /events
```

### 3.1 Proxy (`/v1/*`)
- Claude Code is launched with `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.
- Every request is forwarded unchanged to `https://api.anthropic.com`, including the real auth headers. Redaction applies only to the stored copy.
- Streaming (SSE) responses are passed through to Claude Code chunk by chunk with no added latency. In parallel, the proxy accumulates the stream and stores the complete response when it ends.
- The proxy stores each exchange: timestamp, method, path, redacted request headers, request body, response status, redacted response headers, raw response body/stream, and duration.
- **Fail-safe:** if the viewer's storage or parsing fails, forwarding must still succeed. The viewer must never break Claude Code.

### 3.2 Hook receiver (`/hooks`)
- A small script, `hooks/forward.sh`, is registered in `~/.claude/settings.json` for these events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification`, `Stop`, `SubagentStop`, `SessionEnd`.
- The script POSTs its stdin JSON to `/hooks` with a 1-second timeout. It always exits 0 and prints nothing, so it never blocks, alters or delays Claude Code, even when the server is down.
- Fields used: `session_id`, `hook_event_name`, `cwd`, `permission_mode`, `prompt`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `transcript_path`.

### 3.3 Correlation
- Hooks provide `session_id`. Proxy exchanges are attached to a session by matching `tool_use_id`s and prompt text between hook events and request/response bodies. Requests that can't be matched (background calls) are stored under "unattributed".
- Assistant text comes from proxy responses, because hooks don't carry it. User prompts come from `UserPromptSubmit`, which is already clean. Tool calls and results come from `PreToolUse` / `PostToolUse`.

## 4. Data model (SQLite)

```
sessions(id, cwd, started_at, ended_at, title, current_permission_mode)
events(id, session_id, ts, kind, tool_use_id, parent_tool_use_id, payload_json)
    -- kind: prompt | response | tool_call | tool_result | permission_request
    --       | permission_decision | permission_mode_change | notification | stop
exchanges(id, session_id NULL, ts, duration_ms, method, path, status,
          req_headers_json, req_body, resp_headers_json, resp_body, model,
          input_tokens, output_tokens)
event_exchange(event_id, exchange_id)   -- links a readable item to its raw source
```

## 5. Website

### 5.1 Layout
```
┌──────────────┬─────────────────────────────────────────────┐
│ Sessions     │  session title · cwd · ● live   [mode: auto]│ ← status bar (small)
│ ● current    ├─────────────────────────────────────────────┤
│   yesterday  │  YOU      read the file small-file in …     │
│   …          │  ▸ Bash · Find small-file in Downloads  ✓   │
│              │  ▸ Bash · Show the small file's contents ✓  │
│              │  CLAUDE   The file is small_file.txt …      │
│              │                                             │
│              │                              [Raw ▸]        │
└──────────────┴─────────────────────────────────────────────┘
```

### 5.2 Main timeline (visually primary)
- **Prompts:** right-aligned or clearly labelled "You", in large readable text.
- **Responses:** labelled "Claude", with Markdown rendered (code blocks, tables, lists).
- **Tool calls:** compact single-line cards showing the tool name, the description (or a short summary of the input) and a status icon (running / ✓ / ✗ / denied). Expanding a card shows the full input (pretty-printed JSON or the command) and the full result.
- **Tool results:** shown inside their call's card, not as separate rows. Errors are tinted red and auto-expanded.
- **Subagents:** an `Agent` tool card expands into a nested, indented mini-timeline.
- Every item has a small "raw" link that opens the matching proxy exchange in the raw panel (§6).

### 5.3 Liveness
- New items arrive over SSE and are appended without a page reload.
- The page auto-scrolls only if the reader is already at the bottom. Otherwise it shows a "↓ N new" pill.
- While a response is in progress, a single "Claude is responding…" row is shown. It is replaced by the full message once complete.
- Running tool calls show a spinner until their `PostToolUse` arrives.

### 5.4 Permissions (visually secondary)
- The status bar shows the current permission mode (e.g. `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`).
- Mode changes appear as a thin grey divider in the timeline: `— permission mode: default → auto —`.
- Each tool card carries a small badge when a permission prompt was shown: `asked → allowed` or `asked → denied`. A decision is inferred as *allowed* if `PostToolUse` follows the `PermissionRequest`, and as *denied* if no `PostToolUse` arrives before the next prompt or `Stop`.
- A "Permissions" tab lists all permission events for the session chronologically.

### 5.5 Session list
- Sessions are sorted by most recent activity. Each shows its title (the first prompt, truncated), cwd, start time and a live dot if active.
- A search box filters sessions by prompt text.

## 6. Raw log (proxy record)
- Shown in a slide-over panel or a separate "Raw" tab, never inline.
- Lists every exchange for the session, plus an "Unattributed" bucket for background calls.
- Each exchange shows its request and response headers (auth `[REDACTED]`) and the bodies as collapsible, pretty-printed JSON. Streamed responses are shown both as reassembled JSON and as the raw event stream.
- Shows token counts, model and duration per exchange.
- A download button exports the exchange as JSON.

## 7. Security
- Redaction happens before storage and covers `x-api-key`, `authorization`, `proxy-authorization`, `cookie` and `set-cookie` (case-insensitive).
- The server binds to `127.0.0.1` only. There is no authentication, since access is local only.
- `data/` is gitignored. No secrets or databases are committed.
- Bodies are stored verbatim, so contents of files Claude reads are in the database. This is accepted for now.

## 8. Setup (target UX)
```
pip install -r requirements.txt
python server.py                         # starts proxy + site on :8787
python install_hooks.py                  # adds hook entries to ~/.claude/settings.json (with backup)
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
open http://127.0.0.1:8787
```

## 9. Out of scope (v1)
- Remote access or multi-user use
- Editing or replaying requests
- Masking secrets inside message bodies
- Retention and cleanup policies

## 10. Acceptance criteria
1. Starting Claude Code through the proxy works exactly as without it, including streaming.
2. Within 1 second of each event, the site shows the prompt, every tool call and its result, and the final response.
3. Prompts on the site show no `<system-reminder>` content.
4. Changing the permission mode mid-session shows a divider and updates the status bar.
5. Every timeline item links to its raw exchange, and no stored exchange contains a real API key.
6. Killing the server mid-session does not interrupt Claude Code's hooks. The proxy, however, does stop responding, so this is documented in the README.
