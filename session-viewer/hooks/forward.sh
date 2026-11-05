#!/usr/bin/env bash
# Forwards a Claude Code hook event (JSON on stdin) to the Session Viewer.
# Never blocks or alters Claude Code: 1s timeout, no output, always exit 0.
curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- \
  "${SESSION_VIEWER_URL:-http://127.0.0.1:8787}/hooks" >/dev/null 2>&1
exit 0
