import json
from datetime import datetime, timedelta, timezone

from folio.runtime import (
    ENDED, INACTIVE, NEEDS_YOU, READY, WORKING, RuntimeStore, aggregate_attention, effective_state, transition,
)

SID = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b"


def ev(name, **extra):
    base = {"session_id": SID, "cwd": "/repo/wt", "permission_mode": "default", "hook_event_name": name,
            "transcript_path": "/home/u/.claude/projects/x/y.jsonl"}
    base.update(extra)
    return base


def test_transition_table():
    assert transition(ev("SessionStart", source="startup")) == (READY, None)
    assert transition(ev("UserPromptSubmit", prompt="secret")) == (WORKING, None)
    assert transition(ev("PreToolUse", tool_name="Bash", tool_input={"command": "rm"})) == (WORKING, None)
    assert transition(ev("PostToolUse", tool_name="Bash")) == (WORKING, None)
    assert transition(ev("PermissionRequest", tool_name="Bash")) == (NEEDS_YOU, "permission")
    assert transition(ev("PermissionRequest", tool_name="AskUserQuestion")) == (NEEDS_YOU, "question")
    assert transition(ev("Notification", notification_type="idle_prompt")) == (READY, None)
    assert transition(ev("Notification", notification_type="permission_prompt")) == (NEEDS_YOU, "permission")
    assert transition(ev("Notification", notification_type="auth_success")) is None
    assert transition(ev("Stop")) == (READY, None)
    assert transition(ev("SessionEnd", reason="exit")) == (ENDED, None)
    assert transition(ev("SubagentStart", agent_id="a1", agent_type="Explore")) == (WORKING, None)
    assert transition(ev("PreToolUse", agent_id="a1", agent_type="Explore")) is None  # inside a subagent: keep main state
    # main-session events carry agent_type (e.g. "claude") but no agent_id -- they must still count
    assert transition(ev("PreToolUse", agent_type="claude")) == (WORKING, None)
    assert transition(ev("SessionStart", agent_type="claude")) == (READY, None)
    assert transition(ev("SomethingNew")) is None


def test_record_event_sequence_and_metadata_only(tmp_path):
    store = RuntimeStore(tmp_path / "runtime")
    t0 = datetime(2026, 8, 29, 17, 0, tzinfo=timezone.utc)
    store.record_event(ev("SessionStart"), now=t0)
    store.record_event(ev("UserPromptSubmit", prompt="TOP SECRET PROMPT"), now=t0 + timedelta(seconds=5))
    rec = store.get(SID)
    assert rec["state"] == WORKING and rec["cwd"] == "/repo/wt" and rec["first_seen"] == "2026-08-29T17:00:00Z"
    store.record_event(ev("PermissionRequest", tool_name="Bash", tool_input={"command": "cat /etc/passwd"}), now=t0 + timedelta(seconds=9))
    rec = store.get(SID)
    assert (rec["state"], rec["attention"]) == (NEEDS_YOU, "permission")
    # subagent event: touches updated_at but keeps state
    store.record_event(ev("PostToolUse", agent_id="sub1"), now=t0 + timedelta(seconds=10))
    rec = store.get(SID)
    assert rec["state"] == NEEDS_YOU and rec["updated_at"] == "2026-08-29T17:00:10Z"
    store.record_event(ev("Stop"), now=t0 + timedelta(seconds=20))
    assert store.get(SID)["state"] == READY
    store.record_event(ev("SessionEnd"), now=t0 + timedelta(seconds=30))
    rec = store.get(SID)
    assert rec["state"] == ENDED and rec["ended_at"] == "2026-08-29T17:00:30Z"

    raw = (tmp_path / "runtime" / "sessions" / f"{SID}.json").read_text()
    assert "TOP SECRET" not in raw and "passwd" not in raw and "transcript" not in raw and "tool_name" not in raw
    allowed = {"session_id", "state", "attention", "first_seen", "cwd", "permission_mode", "pid", "last_event", "updated_at", "ended_at"}
    assert set(json.loads(raw)) <= allowed


def test_bad_or_missing_session_id_is_ignored(tmp_path):
    store = RuntimeStore(tmp_path / "runtime")
    assert store.record_event({"hook_event_name": "Stop"}) is None
    assert store.record_event({"session_id": "../../etc/passwd", "hook_event_name": "Stop"}) is None
    assert store.list() == []


def test_effective_state_staleness_and_pid():
    now = datetime(2026, 8, 29, 18, 0, tzinfo=timezone.utc)
    fresh = {"state": WORKING, "updated_at": "2026-08-29T17:59:00Z"}
    assert effective_state(fresh, now) == WORKING
    stale = {"state": WORKING, "updated_at": "2026-08-29T05:00:00Z"}
    assert effective_state(stale, now) == INACTIVE
    dead = {"state": NEEDS_YOU, "updated_at": "2026-08-29T17:59:00Z", "pid": 4242}
    assert effective_state(dead, now, alive=lambda pid: False) == INACTIVE
    assert effective_state(dead, now, alive=lambda pid: True) == NEEDS_YOU
    assert effective_state({"state": ENDED, "updated_at": "2026-08-29T17:59:00Z"}, now) == ENDED
    # legacy record whose state was never set: fall back to the last event name
    assert effective_state({"state": "unknown", "last_event": "PreToolUse", "updated_at": "2026-08-29T17:59:00Z"}, now) == WORKING
    assert effective_state({"state": "unknown", "last_event": "SessionEnd", "updated_at": "2026-08-29T17:59:00Z"}, now) == ENDED


def test_aggregate_attention_across_sessions():
    assert aggregate_attention([WORKING, NEEDS_YOU, READY])["level"] == NEEDS_YOU
    assert aggregate_attention([WORKING, READY, ENDED])["level"] == WORKING
    assert aggregate_attention([READY, ENDED, INACTIVE, "unknown"])["level"] is None
    assert aggregate_attention([])["level"] is None
    agg = aggregate_attention([NEEDS_YOU, NEEDS_YOU, WORKING])
    assert (agg["needs_you"], agg["working"], agg["sessions"]) == (2, 1, 3)
