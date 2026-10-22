"""Derived session identity: the title Claude Code already gives each session.

Claude Code writes one JSONL transcript per session under
``<claude-config>/projects/<slug>/<session-id>.jsonl``. Interleaved with the
conversation it records small state lines that answer "what is this session
about?":

    {"customTitle": "Folder path",           "sessionId": ..., "type": "custom-title"}
    {"agentName": "hide done cascade logic", "sessionId": ..., "type": "agent-name"}
    {"aiTitle": "delete area data cleanup",  "sessionId": ..., "type": "ai-title"}
    {"lastPrompt": "merge",                  "sessionId": ..., "type": "last-prompt"}

`custom-title` is a name you gave the session yourself by renaming it;
`agent-name` is the label Claude Code's agent view shows, which follows a
rename; `ai-title` is Claude Code's own guess. The title is the first of those
present, so folio shows the same name the agent view does.

folio reads those fields, plus the ids that mark a background task's launch and
end (see `background_tasks`), and nothing else -- no messages, no responses, no
tool arguments or output, no code. Like worktrees and session state, this is *derived on every
request and never written into folio's data directory*: the runtime record
stores only the transcript's path, and even that is optional (we can find the
file by session id).

Transcripts reach tens of megabytes, so we read a tail window and scan it
backwards for the newest of each line, then cache per (path, mtime, size). These
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
from datetime import datetime
from pathlib import Path

TAIL_BYTES = 256 * 1024
MAX_SCAN_BYTES = 64 * 1024 * 1024  # never whole-file-scan anything absurd
TITLE_MAX = 120
PROMPT_MAX = 240
_CACHE_MAX = 512
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

# (json "type" value, field holding the text, internal key)
_WANTED = (
    ("custom-title", "customTitle", "custom_title"),
    ("agent-name", "agentName", "agent_name"),
    ("ai-title", "aiTitle", "ai_title"),
    ("last-prompt", "lastPrompt", "last_prompt"),
)
# The exposed title is the first of these present: your rename beats the guess.
_TITLE_KEYS = ("custom_title", "agent_name", "ai_title")
_LIMITS = {"custom_title": TITLE_MAX, "agent_name": TITLE_MAX, "ai_title": TITLE_MAX, "last_prompt": PROMPT_MAX}

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


def _incomplete(raw: dict) -> bool:
    """Worth a whole-file scan: no title of any kind yet, or no prompt.

    Not "any key missing" -- most sessions are never renamed, and hunting for a
    custom-title that does not exist would whole-file-scan every transcript.
    """
    return "last_prompt" not in raw or not any(k in raw for k in _TITLE_KEYS)


def read_meta(path: Path, size: int | None = None) -> dict:
    """{'title': ..., 'last_prompt': ...} -- either key may be absent."""
    try:
        size = path.stat().st_size if size is None else size
        raw = _harvest(list(reversed(_tail_lines(path, size, TAIL_BYTES))), {})
        if _incomplete(raw) and TAIL_BYTES < size <= MAX_SCAN_BYTES:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                raw = _harvest(list(reversed(fh.readlines())), raw)
    except OSError:
        return {}
    meta = {}
    title = next((raw[k] for k in _TITLE_KEYS if k in raw), None)
    if title:
        meta["title"] = title
    if "last_prompt" in raw:
        meta["last_prompt"] = raw["last_prompt"]
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


# --------------------------------------------------------------- background tasks
#
# A turn can end while work it started keeps running: `Bash` with
# `run_in_background`, which Claude Code shows as "N shells still running" under
# the finished turn. No hook fires when such a task exits, but the transcript
# records both ends, by task id:
#
#   launch  {"type": "user", "toolUseResult": {..., "backgroundTaskId": "bvpwgrn36"}, "timestamp": ...}
#   exit    {"type": "queue-operation", "content": "<task-notification>\n<task-id>bvpwgrn36</task-id>..."}
#   killed  {"type": "assistant", ... {"type": "tool_use", "name": "TaskStop", "input": {"task_id": "bvpwgrn36"}}}
#
# Again only those markers are read -- task ids and launch times, never the
# command or its output. Background *subagents* are not counted here: their own
# hook events already say they are busy (see `runtime.subagent_busy`).

_NOTIFIED = re.compile(r"<task-id>([A-Za-z0-9._-]{1,128})</task-id>")
_STOPPERS = ("TaskStop", "KillShell")

# path -> (inode, offset scanned to, {task id: launch time})
_TASKS: dict[str, tuple[int, int, dict[str, datetime | None]]] = {}


def _when(value) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _scan_tasks(line: str, running: dict[str, datetime | None]) -> None:
    if "<task-notification>" in line:
        for task_id in _NOTIFIED.findall(line):
            running.pop(task_id, None)
        return
    if "backgroundTaskId" not in line and not any(s in line for s in _STOPPERS):
        return
    try:
        obj = json.loads(line)
    except ValueError:
        return
    if not isinstance(obj, dict) or obj.get("isSidechain"):
        return
    result = obj.get("toolUseResult")
    if isinstance(result, dict) and isinstance(result.get("backgroundTaskId"), str):
        running[result["backgroundTaskId"]] = _when(obj.get("timestamp"))
    message = obj.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    for block in content if isinstance(content, list) else ():
        if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") in _STOPPERS:
            args = block.get("input") if isinstance(block.get("input"), dict) else {}
            for key in ("task_id", "shell_id"):
                running.pop(str(args.get(key)), None)


def running_tasks(path: Path) -> dict[str, datetime | None]:
    """{task id: launch time} for background tasks launched and not over yet.

    Transcripts only grow, so each byte is read once: we remember how far we got
    and pick up from there. A file that shrank or was replaced is read again.
    """
    try:
        st = path.stat()
    except OSError:
        return {}
    key = str(path)
    inode, offset, running = _TASKS.get(key, (st.st_ino, 0, {}))
    if inode != st.st_ino or st.st_size < offset:
        offset, running = 0, {}
    if st.st_size > offset:
        running = dict(running)
        start = max(offset, st.st_size - MAX_SCAN_BYTES)
        try:
            with path.open("rb") as fh:
                fh.seek(start)
                data = fh.read(st.st_size - start)
        except OSError:
            return {}
        end = data.rfind(b"\n") + 1  # a line still being written waits for the next look
        for raw in data[:end].decode("utf-8", "replace").splitlines():
            _scan_tasks(raw, running)
        if len(_TASKS) >= _CACHE_MAX:
            _TASKS.clear()
        _TASKS[key] = (st.st_ino, start + end, running)
    return running


def background_tasks(session_id: str, hint: str | None = None, since: datetime | None = None,
                     projects_dir: Path | None = None) -> int:
    """How many background tasks this session has running, launched at or after `since`.

    `since` is when the session's current process started. A task outlives its
    turn but not its process, so one launched before a resume whose exit was never
    written down is not running now.
    """
    path = find_transcript(session_id, hint, projects_dir)
    if path is None:
        return 0
    return sum(1 for at in running_tasks(path).values() if since is None or at is None or at >= since)
