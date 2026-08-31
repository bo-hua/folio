"""Ephemeral Claude Code session state, written by the hook and read by the UI.

One small JSON file per session under <data>/runtime/sessions/. Only metadata
is stored: session id, coarse state, timestamps, cwd, permission mode, pid, and
the path of Claude Code's own transcript. Never prompts, responses, tool
arguments, transcript *contents* or code -- `transcript.py` reads the session's
title out of that file at request time and hands it straight to the UI.

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


def iso_precise(dt: datetime) -> str:
    """Like `iso`, but keeps microseconds.

    Only `main_event_at` / `agent_event_at` use this. They exist to be *ordered*
    against each other, and two hook processes fired by the same turn land well
    inside one second -- truncating them would make the comparison a coin toss.
    """
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


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
    session (e.g. tool events emitted from inside a subagent) -- the record's
    `updated_at` is still touched in that case.
    """
    name = event.get("hook_event_name")
    # Attention first, and *before* the subagent guard below: a permission prompt
    # raised three levels down still blocks you, so it must reach the session that
    # owns the subagent rather than being discarded with the rest of its chatter.
    if name == "PermissionRequest":
        reason = "question" if event.get("tool_name") == "AskUserQuestion" else "permission"
        return NEEDS_YOU, reason
    if name == "Notification":
        kind = event.get("notification_type")
        if kind == "permission_prompt":
            return NEEDS_YOU, "permission"
        if kind == "elicitation_dialog":
            return NEEDS_YOU, "question"
        if kind == "idle_prompt" and not event.get("agent_id"):
            return READY, None
        return None
    if name in ("SubagentStart", "SubagentStop"):
        return WORKING, None
    if event.get("agent_id"):
        # Tool chatter from inside a subagent (Task tool): it says nothing about what
        # the *main* agent is doing, so the stored state is left alone. That the
        # subagent is still going is recovered in `effective_state` via `subagent_busy`.
        # NOTE: main-session events also carry `agent_type` (e.g. "claude"), so only
        # `agent_id` identifies a subagent -- verified against Claude Code 2.1.251.
        return None
    if name == "SessionStart":
        return READY, None
    if name in _WORKING_EVENTS:
        return WORKING, None
    if name == "Stop":
        return READY, None
    if name == "SessionEnd":
        return ENDED, None
    return None


def subagent_busy(record: dict) -> bool:
    """True when the newest event we saw for this session came from inside a subagent.

    A subagent dispatched into the background outlives the turn that spawned it, so
    the main agent's own `Stop` (-> ready) is not the whole story: the session looks
    idle while the work you can see in the terminal is still running.

    Comparing "when did we last hear from a subagent" against "when did we last hear
    from the main thread" needs no timeout and no SubagentStop event. A long-running
    tool call inside the subagent stays busy however long it takes, and the moment the
    main thread speaks again its event is the newer one and its state is trusted again.
    """
    agent_at = parse_iso(record.get("agent_event_at"))
    if agent_at is None:
        return False
    main_at = parse_iso(record.get("main_event_at"))
    return main_at is None or agent_at > main_at


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
    if state == UNKNOWN and record.get("last_event"):
        # Records written by an older hook that skipped the event: derive from the event name.
        derived = transition({"hook_event_name": record["last_event"]})
        if derived:
            state = derived[0]
    if state == ENDED:
        return ENDED
    pid = record.get("pid")
    if isinstance(pid, int) and pid > 0 and not alive(pid):
        return INACTIVE
    updated = parse_iso(record.get("updated_at"))
    if updated is None or now - updated > STALE_AFTER:
        return INACTIVE
    if state == READY and subagent_busy(record):
        # The main agent finished its turn but handed work to a subagent that is
        # still running -- what you see in the terminal is work, not a prompt.
        return WORKING
    return state


def is_live(record: dict, state: str) -> bool:
    """A session whose process is (as far as we can tell) still running."""
    return state in (WORKING, NEEDS_YOU, READY)


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
        process_finder: Callable[[], tuple[int | None, bool | None]] | None = None,
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
            "transcript_path": None,
            "permission_mode": None,
            "pid": None,
            "background": None,
            "last_event": None,
            "updated_at": iso(now),
            "main_event_at": None,
            "agent_event_at": None,
        }
        result = transition(event)
        if result is not None:
            record["state"], record["attention"] = result
        record["last_event"] = event.get("hook_event_name")
        record["updated_at"] = iso(now)
        # Which side of the session spoke: the main thread, or one of its subagents.
        # `subagent_busy` reads these back to tell "idle" from "busy below the surface".
        record["agent_event_at" if event.get("agent_id") else "main_event_at"] = iso_precise(now)
        if event.get("cwd"):
            record["cwd"] = str(event["cwd"])
        if event.get("transcript_path"):
            record["transcript_path"] = str(event["transcript_path"])
        if event.get("permission_mode"):
            record["permission_mode"] = str(event["permission_mode"])
        if record["state"] == ENDED:
            record["ended_at"] = iso(now)
        needs_pid = process_finder is not None and (
            record.get("pid") is None
            or record.get("background") is None  # records written before `background` existed
            or event.get("hook_event_name") == "SessionStart"
        )
        if needs_pid:
            try:
                record["pid"], record["background"] = process_finder()
            except Exception:  # never let process discovery break the hook
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
