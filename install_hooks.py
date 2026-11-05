#!/usr/bin/env python3
"""install_hooks.py: report Claude Code permission events to the dashboard.

Adds hook entries to a Claude Code settings file that run hooks/forward.sh,
which posts each hook's JSON input to permissions.py's /hooks endpoint
(SPEC D17). Its page uses them to show the permission mode, which tool calls
asked for permission, and whether each was allowed or denied. Stdlib only.

    python3 install_hooks.py                      # ~/.claude/settings.json
    python3 install_hooks.py --settings .claude/settings.local.json
    python3 install_hooks.py --url http://127.0.0.1:9002/hooks
    python3 install_hooks.py --uninstall

Safe to run twice: entries it added before are replaced, never duplicated, and
every other setting and hook is left as it was. Before changing an existing
file it saves a timestamped copy next to it (settings.json.bak-YYYYmmdd-HHMMSS).
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import sys
from datetime import datetime
from pathlib import Path

FORWARD = Path(__file__).resolve().with_name("hooks") / "forward.sh"
DEFAULT_URL = "http://127.0.0.1:8043/hooks"
# Events the dashboard reads, and whether their hooks take a tool-name matcher.
EVENTS = {
    "UserPromptSubmit": False,
    "PreToolUse": True,
    "PermissionRequest": True,
    "PostToolUse": True,
    "PostToolUseFailure": True,
    "Stop": False,
}
TIMEOUT_SECONDS = 5  # forward.sh gives up after 1s; this is only a backstop


def command(url: str) -> str:
    env = "" if url == DEFAULT_URL else f"PERMISSIONS_HOOKS_URL={shlex.quote(url)} "
    return f"{env}bash {shlex.quote(str(FORWARD))}"


def is_ours(hook: object) -> bool:
    return isinstance(hook, dict) and str(FORWARD) in str(hook.get("command", ""))


def remove_ours(hooks: dict) -> None:
    """Drop every entry that runs our forward.sh, and any group or event left empty."""
    for event in list(hooks):
        groups = hooks[event]
        if not isinstance(groups, list):
            continue
        kept = []
        for group in groups:
            if isinstance(group, dict) and isinstance(group.get("hooks"), list):
                had = len(group["hooks"])
                group["hooks"] = [h for h in group["hooks"] if not is_ours(h)]
                if had and not group["hooks"]:
                    continue
            kept.append(group)
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]


def add_ours(hooks: dict, url: str) -> None:
    entry = {"type": "command", "command": command(url), "timeout": TIMEOUT_SECONDS}
    for event, takes_matcher in EVENTS.items():
        group = {"matcher": "*", "hooks": [entry]} if takes_matcher else {"hooks": [entry]}
        hooks.setdefault(event, []).append(group)


def main() -> int:
    parser = argparse.ArgumentParser(description="Add (or remove) the permissions page's Claude Code hooks.")
    parser.add_argument("--settings", type=Path, default=Path.home() / ".claude" / "settings.json",
                        help="settings file to change (default: ~/.claude/settings.json)")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"permissions.py's hooks endpoint (default: {DEFAULT_URL})")
    parser.add_argument("--uninstall", action="store_true", help="remove the entries this script added")
    args = parser.parse_args()
    path: Path = args.settings.expanduser()

    try:
        original = path.read_text(encoding="utf-8") if path.exists() else ""
        settings = json.loads(original) if original.strip() else {}
    except (OSError, ValueError) as e:
        print(f"cannot read {path}: {e}\nnothing changed", file=sys.stderr)
        return 1
    hooks = settings.get("hooks", {}) if isinstance(settings, dict) else None
    if not isinstance(hooks, dict):
        print(f"{path} does not look like a Claude Code settings file\nnothing changed", file=sys.stderr)
        return 1

    before = json.dumps(settings, sort_keys=True)
    remove_ours(hooks)
    if not args.uninstall:
        add_ours(hooks, args.url)
    if hooks:
        settings["hooks"] = hooks
    else:
        settings.pop("hooks", None)
    if json.dumps(settings, sort_keys=True) == before:
        print(f"{path}: already {'free of these hooks' if args.uninstall else 'up to date'}, nothing changed")
        return 0

    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        stem = f"{path.name}.bak-{datetime.now():%Y%m%d-%H%M%S}"
        backup = path.with_name(stem)
        for n in range(1, 1000):  # never overwrite an earlier backup made in the same second
            if not backup.exists():
                break
            backup = path.with_name(f"{stem}-{n}")
        shutil.copy2(path, backup)
        print(f"backup     {backup}")
    temp = path.with_name(f".{path.name}.tmp")
    temp.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)
    if args.uninstall:
        print(f"removed    permissions-page hooks from {path}")
    else:
        print(f"installed  {', '.join(EVENTS)} hooks in {path}")
        print(f"           they post to {args.url}; restart Claude Code to pick them up")
    return 0


if __name__ == "__main__":
    sys.exit(main())
