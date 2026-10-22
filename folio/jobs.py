"""What Claude Code itself says a background job is doing.

A background session (`claude --bg`, the agent view) has a job directory,
``<claude-config>/jobs/<short-id>/state.json``, and Claude Code keeps its
``state`` current by reading what the agent *says* at the end of each turn:

    working   the turn ended but the job did not -- "the refresh is running in
              the background; next: review the tables when it finishes"
    done      the job delivered -- even if a preview server or a watcher it
              started is still running
    blocked   it needs input from you

That is the one thing the hook cannot know. A finished turn looks the same
whether the agent is waiting on a three-hour pipeline or handing you a result
with a server left up, and the shells still running do not tell them apart
either. The job state does, because it reads the agent's own words.

folio reads ``state`` and the session ids it belongs to, and nothing else -- not
the prompt, not the detail line. Like the transcript title, it is derived on
every request and never written into folio's data directory. Claude Code owns
this format and may change it; every failure here is silent and yields None,
which is exactly what folio did before this module existed.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

_CACHE_MAX = 512

# path -> (mtime, size, (state, session ids))
_CACHE: dict[str, tuple[float, int, tuple[str | None, frozenset[str]]]] = {}


def claude_jobs_dir() -> Path:
    """Where Claude Code keeps background jobs (honours CLAUDE_CONFIG_DIR)."""
    root = os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude")
    return Path(root).expanduser() / "jobs"


def _read(path: Path) -> tuple[str | None, frozenset[str]]:
    try:
        st = path.stat()
    except OSError:
        return None, frozenset()
    key = str(path)
    cached = _CACHE.get(key)
    if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
        return cached[2]
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, frozenset()
    if not isinstance(raw, dict):
        return None, frozenset()
    state = raw.get("state") if isinstance(raw.get("state"), str) else None
    ids = frozenset(v for k in ("sessionId", "resumeSessionId") if isinstance(v := raw.get(k), str) and v)
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.clear()
    _CACHE[key] = (st.st_mtime, st.st_size, (state, ids))
    return state, ids


def job_state(session_id: str, jobs_dir: Path | None = None) -> str | None:
    """Claude Code's state for the background job running this session, or None.

    The directory is named for the session's first eight characters, so that is
    looked at first; the rest are a handful of files, read only if it misses.
    """
    if not session_id:
        return None
    root = jobs_dir or claude_jobs_dir()
    first = root / session_id[:8] / "state.json"
    state, ids = _read(first)
    if session_id in ids:
        return state
    try:
        others = sorted(root.glob("*/state.json"))
    except OSError:
        return None
    for path in others:
        if path == first:
            continue
        state, ids = _read(path)
        if session_id in ids:
            return state
    return None
