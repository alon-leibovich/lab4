# Session Viewer

Live, readable view of a Claude Code session: prompts, responses, tool calls/results,
permission events, and the raw API traffic behind them. Design: [SPEC.md](SPEC.md).

## Setup
```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python server.py           # proxy + site on http://127.0.0.1:8787
.venv/bin/python install_hooks.py    # adds hooks to ~/.claude/settings.json (backup written first)
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```
Open http://127.0.0.1:8787. Remove the hooks with `install_hooks.py --uninstall`.

Env overrides: `VIEWER_PORT`, `VIEWER_DATA_DIR`, `VIEWER_UPSTREAM`, and `SESSION_VIEWER_URL` (for `hooks/forward.sh`).

## Notes
- **If the server stops, Claude Code sessions started with `ANTHROPIC_BASE_URL` pointing at it stop working**
  (the proxy is in the request path). Hooks are unaffected: `forward.sh` times out after 1s and always exits 0.
- Auth headers (`x-api-key`, `authorization`, `proxy-authorization`, `cookie`, `set-cookie`) are stored as `[REDACTED]`.
  Bodies are stored verbatim, so `data/viewer.db` holds file contents Claude read. `data/` is gitignored.
- The proxy asks upstream for `accept-encoding: identity` so the stored copy is plain text.
- Also registers `PostToolUseFailure` (beyond the spec's list) so failed tools show ✗. Errors and denials are
  also picked up from `tool_result` blocks in the next API request.
- Site API lives under `/_viewer/`; every other path is proxied to the API.
