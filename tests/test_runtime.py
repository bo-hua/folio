import json
from datetime import datetime, timedelta, timezone

from folio.runtime import (
    ENDED, INACTIVE, NEEDS_YOU, READY, SNOOZED, WORKING, RuntimeStore, aggregate_attention, effective_state,
    is_snoozed, is_spare, iso, snooze_left, subagent_busy, transition,
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
    assert transition(ev("Notification", notification_type="permission_prompt")) == (NEEDS_YOU, "permission")
    assert transition(ev("Notification", notification_type="auth_success")) is None
    # the turn is over: whatever it produced is waiting for you
    assert transition(ev("Stop")) == (NEEDS_YOU, "review")
    # the idle notification a minute later adds nothing to that -- unless the Stop never
    # landed (still "working"), in which case it is the finished turn's only witness
    assert transition(ev("Notification", notification_type="idle_prompt"), prior=NEEDS_YOU) is None
    assert transition(ev("Notification", notification_type="idle_prompt"), prior=READY) is None
    assert transition(ev("Notification", notification_type="idle_prompt"), prior=WORKING) == (NEEDS_YOU, "review")
    assert transition(ev("Notification", notification_type="idle_prompt")) == (READY, None)  # no history: just "up"
    assert transition(ev("Notification", notification_type="idle_prompt"), prior="unknown") == (READY, None)
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
    assert (store.get(SID)["state"], store.get(SID)["attention"]) == (NEEDS_YOU, "review")
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
    # a snoozed attention is counted, and counts as neither: that is what makes the card quiet
    agg = aggregate_attention([SNOOZED, SNOOZED, WORKING])
    assert agg["level"] == WORKING and (agg["needs_you"], agg["snoozed"], agg["sessions"]) == (0, 2, 3)
    assert aggregate_attention([SNOOZED, READY])["level"] is None
    agg = aggregate_attention([SNOOZED, NEEDS_YOU])
    assert agg["level"] == NEEDS_YOU and (agg["needs_you"], agg["snoozed"]) == (1, 1)
    assert aggregate_attention([])["snoozed"] == 0


def test_a_snooze_silences_one_attention_and_only_that_one(tmp_path):
    """Reading a finished turn you cannot get to should not mean living with the ring.

    Snoozing keeps the session exactly as it is -- still NEEDS_YOU, still listed -- and
    only stops it counting. What it must never do is silence the *next* thing: the
    record drops its snooze the moment the state or the reason behind it changes.
    """
    store = RuntimeStore(tmp_path / "runtime")
    now = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)
    store.record_event(ev("Stop"), now=now)
    rec = store.get(SID)
    assert (rec["state"], rec["attention"]) == (NEEDS_YOU, "review")
    assert is_snoozed(rec, now) is False and snooze_left(rec, now) is None

    assert store.snooze([SID, "never-seen"], now + timedelta(hours=1)) == [SID], "unknown ids are skipped, not fatal"
    rec = store.get(SID)
    assert rec["snooze_until"] == iso(now + timedelta(hours=1))
    assert rec["state"] == NEEDS_YOU and rec["attention"] == "review", "the session itself is untouched"
    assert snooze_left(rec, now) == timedelta(hours=1)
    assert is_snoozed(rec, now + timedelta(minutes=59)) is True
    assert is_snoozed(rec, now + timedelta(minutes=61)) is False, "it wakes on its own"

    # the idle notification a minute after the turn says nothing new -- it must not wake it
    store.record_event(ev("Notification", notification_type="idle_prompt"), now=now + timedelta(minutes=1))
    assert is_snoozed(store.get(SID), now + timedelta(minutes=1)) is True

    # a prompt moves the session on, so the snooze is spent...
    store.record_event(ev("UserPromptSubmit"), now=now + timedelta(minutes=2))
    rec = store.get(SID)
    assert rec["state"] == WORKING and "snooze_until" not in rec
    # ...and the turn after it rings, an hour of quiet or not
    store.record_event(ev("Stop"), now=now + timedelta(minutes=3))
    rec = store.get(SID)
    assert rec["state"] == NEEDS_YOU and is_snoozed(rec, now + timedelta(minutes=3)) is False

    # a permission prompt raised while a snoozed review sits there is a different attention
    store.snooze([SID], now + timedelta(days=1))
    store.record_event(ev("PermissionRequest", tool_name="Bash"), now=now + timedelta(minutes=4))
    rec = store.get(SID)
    assert rec["attention"] == "permission" and "snooze_until" not in rec

    # the duplicate Notification behind that same prompt changes nothing, so the snooze holds
    store.snooze([SID], now + timedelta(hours=3))
    store.record_event(ev("Notification", notification_type="permission_prompt"), now=now + timedelta(minutes=5))
    assert is_snoozed(store.get(SID), now + timedelta(minutes=5)) is True

    # waking takes the field off the record rather than leaving a stale stamp behind
    assert store.snooze([SID], None) == [SID]
    assert "snooze_until" not in store.get(SID)
    assert store.snooze([SID], None) == [SID], "already awake: still reported, and the file is left alone"
    assert store.snooze(["", "bad id"], now) == [], "ids we would never write are refused"


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
    # the same for the real shape of a finished turn, needs you · review: while the subagent
    # it dispatched is still going there is nothing to read yet, so it is working...
    review = {"state": NEEDS_YOU, "attention": "review", "updated_at": iso_at(t0, 8), "main_event_at": iso_at(t0, 0),
              "agent_event_at": iso_at(t0, 8)}
    assert effective_state(review, t0 + timedelta(seconds=30)) == WORKING
    # ...but a permission prompt or a question raised anywhere blocks you now, subagent or not
    for reason in ("permission", "question"):
        assert effective_state({**review, "attention": reason}, t0 + timedelta(seconds=30)) == NEEDS_YOU
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
    # that left the stored state at the main thread's finished turn -- recovered as working
    assert (rec["state"], rec["attention"], rec["last_event"]) == (NEEDS_YOU, "review", "PostToolUse")
    assert rec["main_event_at"] == iso_at(t0, 0) and rec["agent_event_at"] == iso_at(t0, 8)
    assert effective_state(rec, t0 + timedelta(seconds=20)) == WORKING

    store.record_event(ev("Stop"), now=t0 + timedelta(seconds=30))
    rec = store.get(SID)
    assert rec["main_event_at"] == iso_at(t0, 30)
    assert effective_state(rec, t0 + timedelta(seconds=40)) == NEEDS_YOU  # the result is in: read it


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


def test_a_finished_turn_needs_you_until_you_come_back_to_it(tmp_path):
    """The card: "if the session is finished and output something for me to review, it
    should also be needs you". A background job that ends with `result: ...` used to go
    quiet -- Stop -> ready, idle_prompt -> ready, and once the daemon retired the process,
    inactive -- so the board never said the job was done. Now the finished turn is
    needs you · review until the session hears from you."""
    store = RuntimeStore(tmp_path / "runtime")
    t0 = datetime(2026, 9, 4, 6, 49, tzinfo=timezone.utc)
    alive = lambda pid: True  # noqa: E731
    store.record_event(ev("SessionStart", source="startup"), now=t0, process_finder=lambda: (4242, True))
    store.record_event(ev("UserPromptSubmit", prompt="work on task"), now=t0 + timedelta(seconds=1))
    store.record_event(ev("PostToolUse", tool_name="Bash"), now=t0 + timedelta(seconds=30))
    store.record_event(ev("Stop"), now=t0 + timedelta(seconds=37))  # `result:` written; the job is done
    rec = store.get(SID)
    assert (rec["state"], rec["attention"]) == (NEEDS_YOU, "review")
    assert effective_state(rec, t0 + timedelta(seconds=40), alive=alive) == NEEDS_YOU
    # a minute later Claude Code says it is idle: still yours to read, not "ready"
    store.record_event(ev("Notification", notification_type="idle_prompt"), now=t0 + timedelta(seconds=97))
    rec = store.get(SID)
    assert (rec["state"], rec["attention"], rec["last_event"]) == (NEEDS_YOU, "review", "Notification")
    # you answer: working again, and the review is over
    store.record_event(ev("UserPromptSubmit", prompt="merge"), now=t0 + timedelta(minutes=5))
    assert (store.get(SID)["state"], store.get(SID)["attention"]) == (WORKING, None)
    store.record_event(ev("Stop"), now=t0 + timedelta(minutes=6))
    assert store.get(SID)["attention"] == "review"
    # coming back to the session to look at it (a resume) clears it too: ready is "up, nothing waiting"
    store.record_event(ev("SessionStart", source="resume"), now=t0 + timedelta(minutes=7), process_finder=lambda: (5150, False))
    assert (store.get(SID)["state"], store.get(SID)["attention"]) == (READY, None)
    store.record_event(ev("Notification", notification_type="idle_prompt"), now=t0 + timedelta(minutes=8))
    assert store.get(SID)["state"] == READY  # nothing to recover; idle after a resume stays ready
    # and the end of the session ends the review with it -- there is nothing left to open
    store.record_event(ev("Stop"), now=t0 + timedelta(minutes=9))
    store.record_event(ev("SessionEnd", reason="exit"), now=t0 + timedelta(minutes=10))
    assert store.get(SID)["state"] == ENDED
    # a process that is gone reads inactive, review or not (the daemon retires idle jobs)
    gone = {"state": NEEDS_YOU, "attention": "review", "updated_at": iso(t0), "pid": 4242}
    assert effective_state(gone, t0 + timedelta(minutes=1), alive=lambda pid: False) == INACTIVE


def test_the_idle_notification_recovers_a_stop_that_never_landed(tmp_path):
    """Hooks run concurrently and a lost Stop leaves a finished session "working" for good.
    The idle notification a minute later is the only other witness to the finished turn."""
    store = RuntimeStore(tmp_path / "runtime")
    t0 = datetime(2026, 9, 4, 6, 49, tzinfo=timezone.utc)
    store.record_event(ev("UserPromptSubmit", prompt="go"), now=t0)
    store.record_event(ev("PostToolUse", tool_name="Bash"), now=t0 + timedelta(seconds=5))
    # (no Stop)
    store.record_event(ev("Notification", notification_type="idle_prompt"), now=t0 + timedelta(seconds=70))
    assert (store.get(SID)["state"], store.get(SID)["attention"]) == (NEEDS_YOU, "review")
    # a permission prompt is never downgraded by it: that is still the thing to answer
    store.record_event(ev("PermissionRequest", tool_name="Bash"), now=t0 + timedelta(seconds=80))
    store.record_event(ev("Notification", notification_type="idle_prompt"), now=t0 + timedelta(seconds=140))
    assert (store.get(SID)["state"], store.get(SID)["attention"]) == (NEEDS_YOU, "permission")


def test_concurrent_hooks_for_one_session_take_turns(tmp_path):
    """Two hook processes fired by the same turn -- a subagent's PostToolUse beside the main
    thread's Stop, a Stop and the SessionEnd behind it -- each read the record, folded their
    own event in and wrote it back: the second write undid the first, and when both used the
    same temp file the loser crashed in os.replace (hook-errors.log: FileNotFoundError
    '...json.tmp'). One lost Stop is a finished session that stays "working". The
    read-modify-write now happens under the store's lock."""
    import fcntl
    import threading

    store = RuntimeStore(tmp_path / "runtime")
    store.record_event(ev("UserPromptSubmit", prompt="go"))
    # the test plays the hook that is mid-write and holds the lock
    holder = open(store.sessions_dir / ".lock", "a")
    fcntl.flock(holder, fcntl.LOCK_EX)
    done = threading.Event()
    worker = threading.Thread(target=lambda: (store.record_event(ev("Stop")), done.set()))
    worker.start()
    assert not done.wait(0.3)  # waiting its turn rather than writing over the other hook
    assert store.get(SID)["state"] == WORKING
    fcntl.flock(holder, fcntl.LOCK_UN)
    assert done.wait(5)
    worker.join()
    holder.close()
    assert (store.get(SID)["state"], store.get(SID)["attention"]) == (NEEDS_YOU, "review")
    # the temp file is per process too, so even two unlocked writers cannot trip over one name
    assert not list(store.sessions_dir.glob("*.tmp"))


def test_a_spare_is_a_background_session_nobody_has_prompted_yet(tmp_path):
    """Claude Code's daemon claims a spare process ahead of the next job: SessionStart
    fires, then nothing -- until a job prompts it, or it is retired an hour later without
    a SessionEnd (`bg retire <id>: stale-spare` in the daemon log). Read off the record."""
    store = RuntimeStore(tmp_path / "runtime")
    t0 = datetime(2026, 9, 3, 0, 12, 16, tzinfo=timezone.utc)
    store.record_event(ev("SessionStart", source="startup"), now=t0, process_finder=lambda: (32350, True))
    rec = store.get(SID)
    assert is_spare(rec) is True
    # while it stands by it is, technically, ready -- for the daemon, not for you
    assert effective_state(rec, t0 + timedelta(minutes=30), alive=lambda pid: True) == READY
    # retired: the process is gone and no SessionEnd ever comes -- still a spare, never a session
    assert effective_state(rec, t0 + timedelta(minutes=70), alive=lambda pid: False) == INACTIVE
    assert is_spare(rec) is True

    # a job claims it: the first prompt makes it a session like any other
    store.record_event(ev("UserPromptSubmit", prompt="work on task"), now=t0 + timedelta(seconds=1))
    assert is_spare(store.get(SID)) is False and store.get(SID)["state"] == WORKING

    # an interactive session that just opened is a real terminal waiting for you, not a spare
    assert is_spare({"background": False, "last_event": "SessionStart", "state": READY}) is False
    assert is_spare({"background": None, "last_event": "SessionStart", "state": READY}) is False  # older hook: unknown
    # and a background session that has stopped once has been prompted at least once
    assert is_spare({"background": True, "last_event": "Stop", "state": READY}) is False
    assert is_spare({"background": True, "last_event": "SessionEnd", "state": ENDED}) is False


def test_hiding_a_session_is_yours_and_survives_the_hook(tmp_path):
    """`hidden` is the one thing in a session record a person sets: it takes a session
    out of the rail's Unattached list and nothing else. The hook keeps writing to the
    same record, so it has to survive every event that lands afterwards -- and a rail
    full of old sessions has to clear in one gesture, under one lock."""
    store = RuntimeStore(tmp_path / "runtime")
    assert store.set_hidden(SID) is None, "no record yet: nothing to hide"

    t0 = datetime(2026, 9, 8, 9, 0, tzinfo=timezone.utc)
    store.record_event(ev("UserPromptSubmit"), now=t0)
    assert "hidden" not in store.get(SID), "a session starts in the list"

    assert store.set_hidden(SID)["hidden"] is True
    # the hook fires on: state moves, hidden stays put
    store.record_event(ev("Stop"), now=t0 + timedelta(seconds=30))
    rec = store.get(SID)
    assert (rec["state"], rec["attention"], rec["hidden"]) == (NEEDS_YOU, "review", True)

    # putting it back drops the key rather than storing a false
    assert "hidden" not in store.set_hidden(SID, False)
    assert "hidden" not in store.get(SID)

    # a whole list at once, in one lock -- ids we have never seen are skipped, not fatal
    others = ["s-a", "s-b", "s-c"]
    for sid in others:
        store.record_event({"session_id": sid, "hook_event_name": "Stop"}, now=t0)
    assert store.set_hidden_many([*others, "s-never", "../../etc/passwd"]) == others
    assert all(store.get(sid)["hidden"] is True for sid in others)
    assert store.get("s-never") is None
    assert store.set_hidden_many(others, False) == others
    assert all("hidden" not in store.get(sid) for sid in others)

    # an id we would never write is refused rather than reaching the filesystem
    assert store.set_hidden("../../etc/passwd") is None
    assert not list(store.sessions_dir.glob("*.tmp"))
