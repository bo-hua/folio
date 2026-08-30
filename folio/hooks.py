"""Generate / safely merge the Claude Code hook configuration.

We never overwrite existing hooks: our entries are appended alongside whatever
is already configured, and a timestamped backup is written before any change.
"""
from __future__ import annotations

import copy
import json
import shutil
import sys
import time
from pathlib import Path

from .config import DEFAULT_DATA_DIR

HOOK_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "SessionEnd",
)
HOOK_TIMEOUT_SECONDS = 10
MARKER = "folio hook"  # substring identifying our hook commands


def default_settings_path() -> Path:
    return Path.home() / ".claude" / "settings.json"


def hook_command(data_dir: Path | None = None) -> str:
    """Absolute command for the hook, using this very interpreter's venv."""
    exe = Path(sys.executable).resolve().parent / "folio"
    cmd = f"{exe} hook"
    if data_dir is not None and Path(data_dir).resolve() != DEFAULT_DATA_DIR.resolve():
        cmd += f" --data-dir {Path(data_dir).resolve()}"
    return cmd


def hook_settings(command: str) -> dict:
    entry = {"type": "command", "command": command, "timeout": HOOK_TIMEOUT_SECONDS}
    return {"hooks": {event: [{"hooks": [entry]}] for event in HOOK_EVENTS}}


def _has_command(groups: list, command: str) -> bool:
    for group in groups:
        for hook in (group or {}).get("hooks", []) or []:
            if isinstance(hook, dict) and hook.get("command") == command:
                return True
    return False


def merge_settings(existing: dict, command: str) -> dict:
    """Return a new settings dict with our hooks added; nothing else touched."""
    merged = copy.deepcopy(existing) if existing else {}
    hooks = merged.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("existing settings 'hooks' is not an object; refusing to merge")
    ours = hook_settings(command)["hooks"]
    for event, groups in ours.items():
        current = hooks.setdefault(event, [])
        if not isinstance(current, list):
            raise ValueError(f"existing hooks[{event!r}] is not a list; refusing to merge")
        if not _has_command(current, command):
            current.extend(groups)
    return merged


def remove_settings(existing: dict, marker: str = MARKER) -> dict:
    """Return settings with every hook whose command contains `marker` removed."""
    merged = copy.deepcopy(existing) if existing else {}
    hooks = merged.get("hooks")
    if not isinstance(hooks, dict):
        return merged
    for event in list(hooks.keys()):
        groups = hooks.get(event)
        if not isinstance(groups, list):
            continue
        kept_groups = []
        for group in groups:
            if not isinstance(group, dict):
                kept_groups.append(group)
                continue
            inner = [h for h in group.get("hooks", []) or [] if not (isinstance(h, dict) and marker in str(h.get("command", "")))]
            if inner or not group.get("hooks"):
                group = dict(group)
                group["hooks"] = inner
                kept_groups.append(group)
        if kept_groups:
            hooks[event] = kept_groups
        else:
            del hooks[event]
    if not hooks:
        del merged["hooks"]
    return merged


def load_settings(path: Path) -> dict:
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return {}
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError(f"{path} does not contain a JSON object")
    return data


def write_settings(path: Path, settings: dict) -> Path | None:
    """Write settings, backing up any existing file first. Returns backup path."""
    backup = None
    if path.exists():
        backup = path.with_name(f"{path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(path, backup)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return backup
