"""Ephemeral Claude Code session state, written by the hook and read by the UI.

One small JSON file per session under <data>/runtime/sessions/. Only metadata
is stored: session id, coarse state, timestamps, cwd, permission mode, pid, the
path of Claude Code's own transcript, and the two fields a person writes --
`hidden`, set when you tuck a session out of the rail's Unattached list (see
`set_hidden`), and `snooze_until`, set when you silence an attention you have
read but cannot get to yet (see `snooze`). Never prompts, responses, tool arguments, transcript *contents*
or code -- `transcript.py` reads the session's title out of that file at request
time and hands it straight to the UI.

This module is the Claude-specific boundary: `transition()` knows about Claude
Code hook event names; everything else just consumes coarse states.
"""
from __future__ import annotations

import json
import os
import re
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable, Iterator

try:
    import fcntl
except ImportError:  # not POSIX: the hook still records, just without the lock below
    fcntl = None  # type: ignore[assignment]

# Coarse states, in priority order for attention aggregation.
NEEDS_YOU = "needs_you"  # attention: permission | question | review (a finished turn you have not looked at)
WORKING = "working"
READY = "ready"  # up, and nothing is waiting on you: just started, or resumed to look
ENDED = "ended"  # graceful SessionEnd
INACTIVE = "inactive"  # derived: stale or process gone
UNKNOWN = "unknown"  # derived: never observed by the hook

# Not a state: a `needs_you` you have read and silenced on purpose (see RuntimeStore.snooze).
# Only the attention roll-up sees it -- the session itself stays in NEEDS_YOU.
SNOOZED = "snoozed"

STALE_AFTER = timedelta(hours=12)
SNOOZE_MAX = timedelta(days=7)  # longer than a snooze is: past this, deal with the session
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


def transition(event: dict, prior: str | None = None) -> tuple[str, str | None] | None:
    """Map one Claude Code hook event to (state, attention_reason).

    Returns None when the event carries no state information for the main
    session (e.g. tool events emitted from inside a subagent) -- the record's
    `updated_at` is still touched in that case.

    `prior` is the state stored so far; only the idle notification reads it.

    Three things need you. A permission prompt and a question block the session
    until you answer. A finished turn does not block anything, but its output is
    sitting there for you -- and for a background job that is the *only* signal
    the job is done, since nothing else lights up when it finishes. So `Stop` is
    **needs you · review** and stays so until the session hears from you again:
    your next prompt (-> working), coming back to it (`SessionStart` on a resume
    -> ready), or its end. *Ready* is what is left: a session that is up and has
    nothing waiting on you.
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
            # Claude has been sitting at the prompt for a minute after finishing a turn.
            # Normally `Stop` already said so and this changes nothing -- a review stays a
            # review, a permission prompt stays one. Still *working* means the Stop was
            # lost (hooks run concurrently), so recover the finished turn from this. With
            # no history at all it can only say the session is up.
            if prior == WORKING:
                return NEEDS_YOU, "review"
            return (READY, None) if prior in (None, UNKNOWN) else None
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
        # The turn is over and whatever it produced is waiting for you (see above).
        return NEEDS_YOU, "review"
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


def snooze_left(record: dict, now: datetime | None = None) -> timedelta | None:
    """How long this session's attention stays silenced, or None when it is not silenced.

    A finished turn is *needs you*, and rightly so -- but once you have read it and
    cannot get to it, every card it sits on goes on ringing for nothing you are going
    to do about it now. A snooze says "I know, not yet": the session keeps its state
    and the rail keeps listing it, while the roll-ups stop counting it (see
    `aggregate_attention`) so its cards go quiet until the time is up.

    It silences *this* attention, not the session: `_fold` drops the snooze the moment
    the stored state or reason changes, so the next thing that needs you rings even if
    you silenced the last one for a day.
    """
    until = parse_iso(record.get("snooze_until"))
    if until is None:
        return None
    now = now or utc_now()
    return until - now if until > now else None


def is_snoozed(record: dict, now: datetime | None = None) -> bool:
    return snooze_left(record, now) is not None


def is_spare(record: dict) -> bool:
    """A background session Claude Code started ahead of time and nobody has prompted yet.

    The daemon behind `claude --bg` / `claude agents` keeps the *next* session warm so
    a job opens instantly: it claims a spare process, which fires `SessionStart`, and
    then either hands it a prompt within the second (a real job) or leaves it standing
    by, retiring it after about an hour idle -- with no `SessionEnd` ever
    (`bg claimed-spare <id> (spare)` / `bg retire <id>: stale-spare` in its log,
    Claude Code 2.1.25x-2.1.260).

    Until a prompt arrives it is plumbing, not work: no title, no transcript on disk,
    nothing to resume, no terminal you could type into. Left alone it sits in the rail
    as an untitled *ready* session for an hour and then as an untitled *inactive* one
    for a week. It is recognised from the record alone -- background, and the only
    main-thread event ever seen is the start -- and the server keeps it out of the
    session lists; it becomes a normal session the moment its first prompt lands.
    """
    return record.get("background") is True and record.get("last_event") == "SessionStart"


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
    finished = state == READY or (state == NEEDS_YOU and record.get("attention") == "review")
    if finished and subagent_busy(record):
        # The main agent finished its turn but handed work to a subagent that is
        # still running -- what you see in the terminal is work, not a prompt, and
        # not a result to read yet either. A permission prompt or a question is
        # never overridden this way: those block until you answer.
        return WORKING
    return state


def is_live(record: dict, state: str) -> bool:
    """A session whose process is (as far as we can tell) still running."""
    return state in (WORKING, NEEDS_YOU, READY)


def aggregate_attention(states: list[str]) -> dict:
    """Item-level roll-up across attached sessions.

    A session whose attention you snoozed arrives as the pseudo-state SNOOZED. It
    counts as neither needing you nor working -- that is the point, the card goes
    quiet -- but it is counted rather than dropped, so the UI can still say the
    attention is there and when it comes back.
    """
    needs = sum(1 for s in states if s == NEEDS_YOU)
    working = sum(1 for s in states if s == WORKING)
    snoozed = sum(1 for s in states if s == SNOOZED)
    level = NEEDS_YOU if needs else WORKING if working else None
    return {"level": level, "needs_you": needs, "working": working, "snoozed": snoozed, "sessions": len(states)}


class RuntimeStore:
    def __init__(self, runtime_dir: Path):
        self.sessions_dir = Path(runtime_dir) / "sessions"

    def _path(self, session_id: str) -> Path:
        return self.sessions_dir / f"{session_id}.json"

    @contextmanager
    def locked(self) -> Iterator[None]:
        """Hold the store's write lock for one read-modify-write of a record.

        Claude Code runs hooks concurrently, and two of them regularly fire for the
        same session within milliseconds: a subagent's PostToolUse beside the main
        thread's Stop, a Stop and the SessionEnd behind it, PermissionRequest and its
        Notification. Each one read the record, folded its own event in and wrote the
        file back -- so the second writer silently undid the first, and when both used
        the same temp file the loser crashed in os.replace (the FileNotFoundError lines
        in hook-errors.log). One event lost is one state lost: a Stop that never lands
        leaves a finished session "working". An exclusive flock on a sidecar file
        serialises them; the critical section is a few milliseconds, well inside the
        hook's 10 s budget.
        """
        if fcntl is None:
            yield
            return
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        with open(self.sessions_dir / ".lock", "a", encoding="utf-8") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)

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
        with self.locked():
            return self._fold(session_id, event, now, process_finder)

    def _fold(self, session_id: str, event: dict, now: datetime, process_finder) -> dict:
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
        result = transition(event, record.get("state"))
        if result is not None:
            if result != (record.get("state"), record.get("attention")):
                # A snooze silences one attention, not the session. Anything that moves the
                # session on -- you answered the prompt, another turn finished, a fresh
                # permission request came in -- you have not seen, so it rings again.
                record.pop("snooze_until", None)
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
        self._write(record)
        return record

    def _write(self, record: dict) -> None:
        session_id = record["session_id"]
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        # The lock makes sharing a temp file safe; naming it per process makes it safe
        # even without one (see `locked`).
        tmp = self.sessions_dir / f"{session_id}.json.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(record, indent=1, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self._path(session_id))

    def _set_hidden(self, session_id: str, hidden: bool) -> bool:
        """One record, caller holds the lock. False when there is no such record."""
        record = self.get(session_id)
        if record is None:
            return False
        if bool(record.get("hidden")) != hidden:  # already so: leave the file alone
            if hidden:
                record["hidden"] = True
            else:
                record.pop("hidden", None)
            self._write(record)
        return True

    def set_hidden(self, session_id: str, hidden: bool = True) -> dict | None:
        """Tuck a session out of the rail's Unattached list, or put it back.

        The one field here a person sets. *Unattached* is a list of sessions on no
        card, and most sessions never get one -- a question answered, a one-off in
        another repo -- so it silts up until each record ages out a week later.
        Hiding one says "not this, ever": it leaves that list and nothing else, and
        the rail always says how many are hidden and can list them again.

        It lives with the session's own record rather than in `items/` because it is
        only ever about this session and should die with it: a pruned record takes
        its `hidden` along, and by then there is no row left to declutter.

        Returns the stored record, or None when the hook has never seen the session
        or the id is not one we would write.
        """
        if not _SAFE_ID.match(session_id or ""):
            return None
        with self.locked():
            return self.get(session_id) if self._set_hidden(session_id, bool(hidden)) else None

    def set_hidden_many(self, session_ids: Iterable[str], hidden: bool = True) -> list[str]:
        """The same for a list of sessions, under one lock -- clearing a rail full of
        old sessions is one gesture, and must not be one lock round-trip per row.

        Returns the ids that exist and are now in the asked-for state; ids the hook
        has never seen are skipped rather than failing the lot.
        """
        done = []
        with self.locked():
            for sid in session_ids:
                sid = str(sid or "")
                if _SAFE_ID.match(sid) and self._set_hidden(sid, bool(hidden)):
                    done.append(sid)
        return done

    def snooze(self, session_ids: Iterable[str], until: datetime | None) -> list[str]:
        """Silence (or wake) the attention on these sessions, under one lock.

        `until` is when they start counting again; None wakes them now. Snoozing a
        card's sessions is one gesture, so it is one call -- and one Undo. Like
        `hidden`, this is a field a person sets and it lives with the session's own
        record: it is only ever about this session and should die with it.

        Returns the ids that exist and are now in the asked-for state; ids the hook
        has never seen are skipped rather than failing the lot.
        """
        value = iso(until) if until is not None else None
        done = []
        with self.locked():
            for sid in session_ids:
                sid = str(sid or "")
                if not _SAFE_ID.match(sid):
                    continue
                record = self.get(sid)
                if record is None:
                    continue
                if record.get("snooze_until") != value:  # already so: leave the file alone
                    if value is None:
                        record.pop("snooze_until", None)
                    else:
                        record["snooze_until"] = value
                    self._write(record)
                done.append(sid)
        return done

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
