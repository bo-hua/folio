"""Claude Code hook entrypoint: `folio hook`.

A pure observer. Reads one hook event (JSON) from stdin, records coarse
metadata, exits 0 and prints NOTHING to stdout -- so it can never approve,
deny, block or otherwise influence Claude Code. Any failure is swallowed.

The one thing it reads out of a prompt is the `id:` line of a pasted card
brief: "work on task - <brief>" attaches the session to that card
(`attach_from_prompt`). The prompt itself is never stored.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from .brief import card_id_in_text
from .config import resolve_data_dir
from .items import Item, ItemStore
from .runtime import _SAFE_ID, RuntimeStore


def find_claude_process(start_pid: int | None = None, max_depth: int = 4) -> tuple[int | None, bool | None]:
    """Best-effort: walk up from our parent to the `claude` process.

    Returns (pid, background) where `background` is True when the process argv
    marks a Claude Code background session (`claude bg-spare ...` / `--bg`),
    which must be re-opened with `claude attach <short-id>` rather than
    `claude --resume`.
    """
    pid = start_pid or os.getppid()
    for _ in range(max_depth):
        if pid <= 1:
            return None, None
        try:
            out = subprocess.run(
                ["ps", "-o", "ppid=,command=", "-p", str(pid)],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            ).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            return None, None
        if not out:
            return None, None
        parts = out.split(None, 1)
        command = parts[1] if len(parts) > 1 else ""
        if "claude" in command and "folio" not in command:
            return pid, ("bg-spare" in command or " --bg" in f" {command}")
        try:
            pid = int(parts[0])
        except ValueError:
            return None, None
    return None, None


def find_claude_pid(start_pid: int | None = None, max_depth: int = 4) -> int | None:
    return find_claude_process(start_pid, max_depth)[0]


def attach_from_prompt(event: dict, items_dir: Path) -> Item | None:
    """Attach the session to the card whose brief the submitted prompt carries.

    Pasting a card's copied brief -- "work on task - <brief>" -- is how a session
    is pointed at a card, and the brief's `id: … · status: …` line is what names
    it. This does what the inspector's *attach* does, from the prompt alone: the
    card gains the session id in its Markdown, and an *idea* becomes *active*.

    The id is the only thing read out of the prompt. A session that already
    belongs to a card is never moved -- pasting a second card's brief for
    reference must not steal the session from the first -- and prompts from
    inside a subagent are not yours, so they are ignored.
    """
    if event.get("hook_event_name") != "UserPromptSubmit" or event.get("agent_id"):
        return None
    session_id = str(event.get("session_id") or "")
    prompt = event.get("prompt")
    card_id = card_id_in_text(prompt if isinstance(prompt, str) else None)
    if not card_id or not _SAFE_ID.match(session_id):
        return None
    store = ItemStore(items_dir)
    items = store.list_items()
    if any(session_id in it.session_ids() for it in items):
        return None
    item = next((it for it in items if it.id == card_id), None)
    if item is None:
        return None
    return store.attach_session(item, session_id)


def run(stdin_text: str, data_dir: Path) -> None:
    event = json.loads(stdin_text) if stdin_text.strip() else {}
    if not isinstance(event, dict):
        return
    RuntimeStore(data_dir / "runtime").record_event(event, process_finder=find_claude_process)
    attach_from_prompt(event, data_dir / "items")


def main(data_dir: str | None = None) -> int:
    try:
        run(sys.stdin.read(), resolve_data_dir(data_dir))
    except Exception as exc:  # noqa: BLE001 -- observer must never fail loudly
        try:
            log = resolve_data_dir(data_dir) / "runtime" / "hook-errors.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("a", encoding="utf-8") as fh:
                fh.write(f"{type(exc).__name__}: {exc}\n")
        except Exception:  # noqa: BLE001
            pass
    return 0
