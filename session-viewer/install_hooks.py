"""Add Session Viewer hook entries to ~/.claude/settings.json (a timestamped backup is written first).

Usage: python install_hooks.py [--settings PATH] [--uninstall]
Idempotent: existing hooks are kept, and our entry is added only once per event.
"""
import argparse
import json
import shutil
import time
from pathlib import Path

EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
          "PermissionRequest", "Notification", "Stop", "SubagentStop", "SessionEnd"]
SCRIPT = Path(__file__).resolve().parent / "hooks" / "forward.sh"
COMMAND = f"bash {SCRIPT}"
MATCHER_EVENTS = {"PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--settings", default=str(Path.home() / ".claude" / "settings.json"))
    ap.add_argument("--uninstall", action="store_true")
    args = ap.parse_args()
    path = Path(args.settings).expanduser()

    settings = json.loads(path.read_text()) if path.exists() and path.read_text().strip() else {}
    if path.exists():
        backup = path.with_name(f"{path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(path, backup)
        print(f"backup: {backup}")

    hooks = settings.setdefault("hooks", {})
    changed = 0
    for ev in EVENTS:
        groups = hooks.setdefault(ev, [])
        ours = [g for g in groups if any(h.get("command") == COMMAND for h in g.get("hooks", []))]
        if args.uninstall:
            for g in ours:
                groups.remove(g)
                changed += 1
            if not groups:
                del hooks[ev]
        elif not ours:
            group = {"hooks": [{"type": "command", "command": COMMAND, "timeout": 5}]}
            if ev in MATCHER_EVENTS:
                group = {"matcher": "*", **group}
            groups.append(group)
            changed += 1
    if not hooks:
        settings.pop("hooks")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2) + "\n")
    print(f"{'removed' if args.uninstall else 'added'} {changed} hook entr{'y' if changed == 1 else 'ies'} in {path}")


if __name__ == "__main__":
    main()
