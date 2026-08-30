"""Derived session identity: the title Claude Code already gives each session.

Claude Code writes one JSONL transcript per session under
``<claude-config>/projects/<slug>/<session-id>.jsonl``. Interleaved with the
conversation it records small state lines, two of which answer "what is this
session about?" without anyone having to type a title:

    {"aiTitle": "delete area data cleanup",  "sessionId": ..., "type": "ai-title"}
    {"lastPrompt": "merge",                  "sessionId": ..., "type": "last-prompt"}

folio reads those two fields and nothing else -- no messages, no responses, no
tool calls, no code. Like worktrees and session state, this is *derived on every
request and never written into folio's data directory*: the runtime record
stores only the transcript's path, and even that is optional (we can find the
file by session id).

Transcripts reach tens of megabytes, so we read a tail window and scan it
backwards for the newest of each line, then cache per (path, mtime, size). Both
lines are rewritten every turn, so the tail almost always has them; the
whole-file fallback covers sessions that stopped early.

Claude Code owns this format and may change it. Every failure here is silent and
yields nothing -- a session without a title is exactly what folio showed before
this module existed.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

TAIL_BYTES = 256 * 1024
MAX_SCAN_BYTES = 64 * 1024 * 1024  # never whole-file-scan anything absurd
TITLE_MAX = 120
PROMPT_MAX = 240
_CACHE_MAX = 512
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

# (json "type" value, field holding the text, key we expose)
_WANTED = (
    ("ai-title", "aiTitle", "title"),
    ("last-prompt", "lastPrompt", "last_prompt"),
)
_LIMITS = {"title": TITLE_MAX, "last_prompt": PROMPT_MAX}

# path -> (mtime, size, meta)
_CACHE: dict[str, tuple[float, int, dict]] = {}
# session id -> resolved transcript path (positive results only; one stat to revalidate)
_PATHS: dict[str, Path] = {}


def claude_projects_dir() -> Path:
    """Where Claude Code keeps transcripts (honours CLAUDE_CONFIG_DIR)."""
    root = os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude")
    return Path(root).expanduser() / "projects"


def find_transcript(session_id: str, hint: str | None = None, projects_dir: Path | None = None) -> Path | None:
    """The transcript for a session: the hook's `transcript_path`, else by id.

    The hint wins when it still exists; otherwise we glob, which also covers
    every session recorded before folio started storing the path.
    """
    for candidate in (Path(hint).expanduser() if hint else None, _PATHS.get(session_id)):
        if candidate is not None and candidate.is_file():
            return candidate
    if not _SAFE_ID.match(session_id or ""):
        return None
    root = projects_dir or claude_projects_dir()
    try:
        found = next(iter(sorted(root.glob(f"*/{session_id}.jsonl"))), None)
    except OSError:
        return None
    if found is not None:
        if len(_PATHS) >= _CACHE_MAX:
            _PATHS.clear()
        _PATHS[session_id] = found
    return found


def _harvest(lines: list[str], out: dict) -> dict:
    """Fill missing keys from `lines`, which must be ordered newest-first."""
    for line in lines:
        if len(out) == len(_WANTED):
            break
        for type_name, field, key in _WANTED:
            if key in out or type_name not in line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if not isinstance(obj, dict) or obj.get("type") != type_name:
                continue
            value = obj.get(field)
            if isinstance(value, str) and value.strip():
                out[key] = " ".join(value.split())[: _LIMITS[key]].strip()
    return out


def _tail_lines(path: Path, size: int, window: int) -> list[str]:
    with path.open("rb") as fh:
        if size > window:
            fh.seek(size - window)
            fh.readline()  # drop the partial line we landed in the middle of
        data = fh.read()
    return data.decode("utf-8", "replace").splitlines()


def read_meta(path: Path, size: int | None = None) -> dict:
    """{'title': ..., 'last_prompt': ...} -- either key may be absent."""
    try:
        size = path.stat().st_size if size is None else size
        meta = _harvest(list(reversed(_tail_lines(path, size, TAIL_BYTES))), {})
        if len(meta) < len(_WANTED) and TAIL_BYTES < size <= MAX_SCAN_BYTES:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                meta = _harvest(list(reversed(fh.readlines())), meta)
    except OSError:
        return {}
    return meta


def describe(session_id: str, hint: str | None = None, projects_dir: Path | None = None) -> dict:
    """Cached {'title', 'last_prompt'} for a session; {} when unknown."""
    path = find_transcript(session_id, hint, projects_dir)
    if path is None:
        return {}
    try:
        st = path.stat()
    except OSError:
        return {}
    key = str(path)
    cached = _CACHE.get(key)
    if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
        return cached[2]
    meta = read_meta(path, st.st_size)
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.clear()
    _CACHE[key] = (st.st_mtime, st.st_size, meta)
    return meta
