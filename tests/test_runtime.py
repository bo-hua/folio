import json
from datetime import datetime, timedelta, timezone

from folio.runtime import (
    ENDED, INACTIVE, NEEDS_YOU, READY, WORKING, RuntimeStore, aggregate_attention, effective_state, iso,
    subagent_busy, transition,
)

SID = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b"


def iso_at(base, seconds):
    return iso(base + timedelta(seconds=seconds))


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
    # ...but attention raised inside a subagent still blocks *you*, so it is never swallowed
    assert transition(ev("PermissionRequest", tool_name="Bash", agent_id="a1")) == (NEEDS_YOU, "permission")
    assert transition(ev("PermissionRequest", tool_name="AskUserQuestion", agent_id="a1")) == (NEEDS_YOU, "question")
    assert transition(ev("Notification", notification_type="permission_prompt", agent_id="a1")) == (NEEDS_YOU, "permission")
    # an idle prompt inside a subagent says nothing about the main session
    assert transition(ev("Notification", notification_type="idle_prompt", agent_id="a1")) is None
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
    assert "TOP SECRET" not in raw and "passwd" not in raw and "tool_name" not in raw
    # The transcript's *path* is metadata we keep, so the server can read the session's
    # title back out of it live. Nothing from inside the transcript is ever written here.
    assert json.loads(raw)["transcript_path"] == "/home/u/.claude/projects/x/y.jsonl"
    allowed = {"session_id", "state", "attention", "first_seen", "cwd", "transcript_path", "permission_mode", "pid",
               "background", "last_event", "updated_at", "ended_at", "main_event_at", "agent_event_at"}
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


def test_process_finder_records_pid_and_background(tmp_path):
    store = RuntimeStore(tmp_path / "runtime")
    store.record_event(ev("SessionStart"), process_finder=lambda: (4242, True))
    rec = store.get(SID)
    assert rec["pid"] == 4242 and rec["background"] is True
    # later events reuse the discovered process unless a new SessionStart (resume) arrives
    store.record_event(ev("PreToolUse"), process_finder=lambda: (1, False))
    assert store.get(SID)["pid"] == 4242
    store.record_event(ev("SessionStart", source="resume"), process_finder=lambda: (5150, False))
    assert (store.get(SID)["pid"], store.get(SID)["background"]) == (5150, False)


def test_background_subagent_keeps_the_session_working_after_the_main_agent_stops():
    """The devbox case: /data-analysis dispatched a subagent, the main agent's turn
    ended (Stop -> ready), and the session read "ready" while the subagent ground on."""
    t0 = datetime(2026, 8, 31, 5, 50, tzinfo=timezone.utc)
    rec = {"state": READY, "updated_at": iso_at(t0, 8), "main_event_at": iso_at(t0, 0),
           "agent_event_at": iso_at(t0, 8)}
    # the last thing we heard came from the subagent -> still working
    assert subagent_busy(rec) is True
    assert effective_state(rec, t0 + timedelta(seconds=30)) == WORKING

    # main thread speaks again (subagent returned, main is processing the result)
    rec = {**rec, "state": WORKING, "updated_at": iso_at(t0, 20), "main_event_at": iso_at(t0, 20)}
    assert subagent_busy(rec) is False
    assert effective_state(rec, t0 + timedelta(seconds=30)) == WORKING

    # ...and when it stops for real, ready means ready -- no timeout needed to get here
    rec = {**rec, "state": READY, "updated_at": iso_at(t0, 25), "main_event_at": iso_at(t0, 25)}
    assert subagent_busy(rec) is False
    assert effective_state(rec, t0 + timedelta(seconds=30)) == READY

    # a session that never spawned one is unaffected
    assert subagent_busy({"state": READY, "main_event_at": iso_at(t0, 25)}) is False
    # ended and inactive still win over a chatty subagent
    ended = {"state": ENDED, "updated_at": iso_at(t0, 8), "agent_event_at": iso_at(t0, 8)}
    assert effective_state(ended, t0 + timedelta(seconds=30)) == ENDED
    dead = {"state": READY, "updated_at": iso_at(t0, 8), "agent_event_at": iso_at(t0, 8), "pid": 4242}
    assert effective_state(dead, t0 + timedelta(seconds=30), alive=lambda pid: False) == INACTIVE


def test_record_event_tracks_which_side_of_the_session_spoke(tmp_path):
    store = RuntimeStore(tmp_path / "runtime")
    t0 = datetime(2026, 8, 31, 5, 50, tzinfo=timezone.utc)
    store.record_event(ev("Stop"), now=t0)
    store.record_event(ev("PostToolUse", agent_id="agent-adc68b7f45dd523d9"), now=t0 + timedelta(seconds=8))
    rec = store.get(SID)
    # exactly the contradictory record observed on the devbox: a fresh PostToolUse
    # that left the stored state at "ready" -- now recovered as working
    assert (rec["state"], rec["last_event"]) == (READY, "PostToolUse")
    assert rec["main_event_at"] == iso_at(t0, 0) and rec["agent_event_at"] == iso_at(t0, 8)
    assert effective_state(rec, t0 + timedelta(seconds=20)) == WORKING

    store.record_event(ev("Stop"), now=t0 + timedelta(seconds=30))
    rec = store.get(SID)
    assert rec["main_event_at"] == iso_at(t0, 30)
    assert effective_state(rec, t0 + timedelta(seconds=40)) == READY


def test_subagent_and_main_events_inside_the_same_second_are_still_ordered(tmp_path):
    """Both hooks fire microseconds apart when a turn ends and a subagent keeps going.
    Second-resolution timestamps made that comparison a coin toss."""
    store = RuntimeStore(tmp_path / "runtime")
    t0 = datetime(2026, 8, 31, 5, 50, 0, 120_000, tzinfo=timezone.utc)
    store.record_event(ev("Stop"), now=t0)
    store.record_event(ev("PostToolUse", agent_id="a1"), now=t0 + timedelta(microseconds=300_000))
    rec = store.get(SID)
    assert rec["main_event_at"][:19] == rec["agent_event_at"][:19]  # same wall-clock second
    assert subagent_busy(rec) is True
    assert effective_state(rec, t0 + timedelta(seconds=5)) == WORKING

    # and the other way round: the main thread spoke last, so ready means ready
    store.record_event(ev("Stop"), now=t0 + timedelta(microseconds=600_000))
    assert subagent_busy(store.get(SID)) is False
