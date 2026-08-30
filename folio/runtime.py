"""Ephemeral Claude Code session state, written by the hook and read by the UI.

One small JSON file per session under <data>/runtime/sessions/. Only metadata
is stored: session id, coarse state, timestamps, cwd, permission mode, pid.
Never prompts, responses, tool arguments, transcripts or code.

This module is the Claude-specific boundary: `transition()` knows about Claude
Code hook event names; everything else just consumes coarse states.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

# Coarse states, in priority order for attention aggregation.
NEEDS_YOU = "needs_you"
WORKING = "working"
READY = "ready"  # turn completed; waiting for your next prompt
ENDED = "ended"  # graceful SessionEnd
INACTIVE = "inactive"  # derived: stale or process gone
UNKNOWN = "unknown"  # derived: never observed by the hook

STALE_AFTER = timedelta(hours=12)
_WORKING_EVENTS = {
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
}
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def transition(event: dict) -> tuple[str, str | None] | None:
    """Map one Claude Code hook event to (state, attention_reason).

    Returns None when the event carries no state information for the main
    session (e.g. events emitted from inside a subagent) -- the record's
    `updated_at` is still touched in that case.
    """
    name = event.get("hook_event_name")
    if name in ("SubagentStart", "SubagentStop"):
        return WORKING, None
    if event.get("agent_id") or event.get("agent_type"):
        return None  # subagent-scoped event; keep main-session state
    if name == "SessionStart":
        return READY, None
    if name in _WORKING_EVENTS:
        return WORKING, None
    if name == "PermissionRequest":
        reason = "question" if event.get("tool_name") == "AskUserQuestion" else "permission"
        return NEEDS_YOU, reason
    if name == "Notification":
        kind = event.get("notification_type")
        if kind == "idle_prompt":
            return READY, None
        if kind == "permission_prompt":
            return NEEDS_YOU, "permission"
        if kind == "elicitation_dialog":
            return NEEDS_YOU, "question"
        return None
    if name == "Stop":
        return READY, None
    if name == "SessionEnd":
        return ENDED, None
    return None


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def effective_state(record: dict, now: datetime | None = None, alive: Callable[[int], bool] = pid_alive) -> str:
    """Stored state, downgraded to INACTIVE when the process is gone or stale."""
    now = now or utc_now()
    state = record.get("state") or UNKNOWN
    if state == ENDED:
        return ENDED
    pid = record.get("pid")
    if isinstance(pid, int) and pid > 0 and not alive(pid):
        return INACTIVE
    updated = parse_iso(record.get("updated_at"))
    if updated is None or now - updated > STALE_AFTER:
        return INACTIVE
    return state


def aggregate_attention(states: list[str]) -> dict:
    """Item-level roll-up across attached sessions."""
    needs = sum(1 for s in states if s == NEEDS_YOU)
    working = sum(1 for s in states if s == WORKING)
    level = NEEDS_YOU if needs else WORKING if working else None
    return {"level": level, "needs_you": needs, "working": working, "sessions": len(states)}


class RuntimeStore:
    def __init__(self, runtime_dir: Path):
        self.sessions_dir = Path(runtime_dir) / "sessions"

    def _path(self, session_id: str) -> Path:
        return self.sessions_dir / f"{session_id}.json"

    def get(self, session_id: str) -> dict | None:
        if not _SAFE_ID.match(session_id or ""):
            return None
        try:
            return json.loads(self._path(session_id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def list(self) -> list[dict]:
        if not self.sessions_dir.exists():
            return []
        out = []
        for path in self.sessions_dir.glob("*.json"):
            try:
                out.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        out.sort(key=lambda r: r.get("updated_at") or "", reverse=True)
        return out

    def record_event(
        self,
        event: dict,
        now: datetime | None = None,
        pid_finder: Callable[[], int | None] | None = None,
    ) -> dict | None:
        """Fold one hook event into the session's record. Metadata only."""
        session_id = str(event.get("session_id") or "")
        if not _SAFE_ID.match(session_id):
            return None
        now = now or utc_now()
        record = self.get(session_id) or {
            "session_id": session_id,
            "state": UNKNOWN,
            "attention": None,
            "first_seen": iso(now),
            "cwd": None,
            "permission_mode": None,
            "pid": None,
            "last_event": None,
            "updated_at": iso(now),
        }
        result = transition(event)
        if result is not None:
            record["state"], record["attention"] = result
        record["last_event"] = event.get("hook_event_name")
        record["updated_at"] = iso(now)
        if event.get("cwd"):
            record["cwd"] = str(event["cwd"])
        if event.get("permission_mode"):
            record["permission_mode"] = str(event["permission_mode"])
        if record["state"] == ENDED:
            record["ended_at"] = iso(now)
        needs_pid = pid_finder is not None and (
            record.get("pid") is None or event.get("hook_event_name") == "SessionStart"
        )
        if needs_pid:
            try:
                record["pid"] = pid_finder()
            except Exception:  # never let pid discovery break the hook
                pass
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        tmp = self._path(session_id).with_suffix(".json.tmp")
        tmp.write_text(json.dumps(record, indent=1, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self._path(session_id))
        return record

    def prune_ended(self, older_than: timedelta = timedelta(days=7), now: datetime | None = None) -> int:
        """Housekeeping: drop records of sessions that ended long ago."""
        now = now or utc_now()
        removed = 0
        for rec in self.list():
            updated = parse_iso(rec.get("updated_at"))
            if updated is not None and now - updated > older_than:
                try:
                    self._path(rec["session_id"]).unlink()
                    removed += 1
                except OSError:
                    pass
        return removed
