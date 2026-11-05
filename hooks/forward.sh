#!/usr/bin/env bash
# forward.sh: a Claude Code hook that copies its JSON input to the dashboard.
#
# Claude Code runs this for each hook event and pipes the event's JSON on stdin.
# It is posted to permissions.py's /hooks endpoint (SPEC D17a) and nothing else
# happens: no output (some hooks' stdout would reach the model), always exit 0,
# and at most one second of waiting, so Claude Code behaves exactly as without
# it, whether or not permissions.py is running.
#
#   PERMISSIONS_HOOKS_URL   where to post (default http://127.0.0.1:8043/hooks)
#
# install_hooks.py registers it; see that file for the events.

url="${PERMISSIONS_HOOKS_URL:-http://127.0.0.1:8043/hooks}"
if command -v curl >/dev/null 2>&1; then
  curl -s -m 1 -o /dev/null -H 'Content-Type: application/json' --data-binary @- "$url" >/dev/null 2>&1
fi
exit 0
