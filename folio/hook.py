"""Claude Code hook entrypoint: `folio hook`.

A pure observer. Reads one hook event (JSON) from stdin, records coarse
metadata, exits 0 and prints NOTHING to stdout -- so it can never approve,
deny, block or otherwise influence Claude Code. Any failure is swallowed.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from .config import resolve_data_dir
from .runtime import RuntimeStore


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


def run(stdin_text: str, data_dir: Path) -> None:
    event = json.loads(stdin_text) if stdin_text.strip() else {}
    if not isinstance(event, dict):
        return
    RuntimeStore(data_dir / "runtime").record_event(event, process_finder=find_claude_process)


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
