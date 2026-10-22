import json

import pytest

from folio import transcript

SID = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b"


@pytest.fixture(autouse=True)
def _clear_caches():
    transcript._CACHE.clear()
    transcript._PATHS.clear()
    yield
    transcript._CACHE.clear()
    transcript._PATHS.clear()


def line(**kw) -> str:
    return json.dumps(kw) + "\n"


def title_line(text, sid=SID):
    return line(aiTitle=text, sessionId=sid, type="ai-title")


def prompt_line(text, sid=SID):
    return line(lastPrompt=text, sessionId=sid, type="last-prompt")


def chatter(n=1):
    """Lines that look like a real transcript and carry nothing we want."""
    return "".join(
        line(type="assistant", sessionId=SID, message={"content": [{"type": "text", "text": f"working {i}"}]})
        for i in range(n)
    )


def write_transcript(root, body, sid=SID, slug="-Users-u-code-folio"):
    d = root / "projects" / slug
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{sid}.jsonl"
    path.write_text(body, encoding="utf-8")
    return path


def test_reads_title_and_last_prompt(tmp_path):
    write_transcript(tmp_path, title_line("delete area data cleanup") + prompt_line("merge"))
    meta = transcript.describe(SID, projects_dir=tmp_path / "projects")
    assert meta == {"title": "delete area data cleanup", "last_prompt": "merge"}


def test_newest_of_each_line_wins(tmp_path):
    body = (
        title_line("first guess") + prompt_line("do the thing") + chatter(3)
        + title_line("what it became") + prompt_line("now do this instead")
    )
    write_transcript(tmp_path, body)
    meta = transcript.describe(SID, projects_dir=tmp_path / "projects")
    assert meta == {"title": "what it became", "last_prompt": "now do this instead"}


def custom_line(text, sid=SID):
    return line(type="custom-title", customTitle=text, sessionId=sid)


def agent_line(text, sid=SID):
    return line(type="agent-name", agentName=text, sessionId=sid)


def test_a_name_you_gave_the_session_beats_claudes_guess(tmp_path):
    """Renaming a session writes custom-title; Claude Code keeps writing its own
    ai-title after it, but the agent view shows your name and so must folio."""
    body = (
        title_line("session title mismatch investigation") + custom_line("show my rename")
        + agent_line("show my rename") + chatter(2)
        + title_line("session title mismatch investigation") + prompt_line("merge")
    )
    write_transcript(tmp_path, body)
    meta = transcript.describe(SID, projects_dir=tmp_path / "projects")
    assert meta == {"title": "show my rename", "last_prompt": "merge"}


def test_agent_name_beats_ai_title(tmp_path):
    """The agent view's own label, when there is no custom-title line."""
    write_transcript(tmp_path, title_line("claude's guess") + agent_line("what the agent view shows"))
    assert transcript.describe(SID, projects_dir=tmp_path / "projects")["title"] == "what the agent view shows"


def test_newest_rename_wins(tmp_path):
    write_transcript(tmp_path, custom_line("first name") + chatter(2) + custom_line("second name"))
    assert transcript.describe(SID, projects_dir=tmp_path / "projects")["title"] == "second name"


def test_rename_before_the_tail_is_found_when_the_tail_has_no_title(tmp_path, monkeypatch):
    monkeypatch.setattr(transcript, "TAIL_BYTES", 512)
    write_transcript(tmp_path, custom_line("renamed early") + chatter(400) + prompt_line("late"))
    meta = transcript.describe(SID, projects_dir=tmp_path / "projects")
    assert meta == {"title": "renamed early", "last_prompt": "late"}


def test_unrenamed_session_is_not_whole_file_scanned(tmp_path, monkeypatch):
    """Most sessions never get a custom-title; looking for one must not cost a
    full read of a huge transcript when the tail already has a title."""
    monkeypatch.setattr(transcript, "TAIL_BYTES", 512)
    write_transcript(tmp_path, chatter(400) + title_line("guess") + prompt_line("p"))
    real_open = transcript.Path.open

    def no_text_open(self, mode="r", *a, **kw):
        assert "b" in mode, "whole-file scan happened"
        return real_open(self, mode, *a, **kw)

    monkeypatch.setattr(transcript.Path, "open", no_text_open)
    assert transcript.describe(SID, projects_dir=tmp_path / "projects") == {"title": "guess", "last_prompt": "p"}


def test_found_by_session_id_without_a_hint(tmp_path):
    """Sessions recorded before folio stored transcript_path still get a title."""
    write_transcript(tmp_path, title_line("found by glob"), slug="-Users-u-somewhere-else")
    assert transcript.find_transcript(SID, None, tmp_path / "projects") is not None
    assert transcript.describe(SID, None, tmp_path / "projects")["title"] == "found by glob"


def test_hint_wins_and_a_dead_hint_falls_back(tmp_path):
    real = write_transcript(tmp_path, title_line("by hint"))
    assert transcript.find_transcript(SID, str(real), tmp_path / "projects") == real
    # a stale path (session's project dir renamed) must not stop us finding it by id
    assert transcript.describe(SID, str(tmp_path / "gone.jsonl"), tmp_path / "projects")["title"] == "by hint"


def test_tail_window_finds_recent_lines_in_a_huge_file(tmp_path, monkeypatch):
    monkeypatch.setattr(transcript, "TAIL_BYTES", 2048)
    body = chatter(400) + title_line("late title") + prompt_line("late prompt") + chatter(2)
    path = write_transcript(tmp_path, body)
    assert path.stat().st_size > 2048
    meta = transcript.describe(SID, projects_dir=tmp_path / "projects")
    assert meta == {"title": "late title", "last_prompt": "late prompt"}


def test_whole_file_fallback_when_the_tail_has_nothing(tmp_path, monkeypatch):
    """A session that was titled once and then ran long without being re-titled."""
    monkeypatch.setattr(transcript, "TAIL_BYTES", 512)
    body = title_line("titled early") + prompt_line("asked early") + chatter(400)
    write_transcript(tmp_path, body)
    meta = transcript.describe(SID, projects_dir=tmp_path / "projects")
    assert meta == {"title": "titled early", "last_prompt": "asked early"}


def test_absurdly_large_files_are_not_whole_file_scanned(tmp_path, monkeypatch):
    monkeypatch.setattr(transcript, "TAIL_BYTES", 512)
    monkeypatch.setattr(transcript, "MAX_SCAN_BYTES", 1024)
    write_transcript(tmp_path, title_line("titled early") + chatter(400))
    assert transcript.describe(SID, projects_dir=tmp_path / "projects") == {}


def test_partial_first_line_in_the_tail_is_not_mistaken_for_a_record(tmp_path, monkeypatch):
    monkeypatch.setattr(transcript, "TAIL_BYTES", 300)
    monkeypatch.setattr(transcript, "MAX_SCAN_BYTES", 0)  # tail only; no fallback to rescue us
    write_transcript(tmp_path, chatter(20) + title_line("x" * 400) + prompt_line("fine"))
    # the title line is longer than the window, so only its tail half is visible: skip it cleanly
    assert transcript.describe(SID, projects_dir=tmp_path / "projects") == {"last_prompt": "fine"}


def test_junk_and_lookalike_lines_are_ignored(tmp_path):
    body = (
        "not json at all\n"
        + "\n"
        + line(type="user", sessionId=SID, message={"content": 'talking about "ai-title" and lastPrompt'})
        + line(type="ai-title", sessionId=SID)  # right type, no field
        + title_line("   ")  # blank after stripping
        + title_line("real title")
    )
    write_transcript(tmp_path, body)
    assert transcript.describe(SID, projects_dir=tmp_path / "projects") == {"title": "real title"}


def test_text_is_flattened_and_truncated(tmp_path):
    write_transcript(tmp_path, title_line("  wrapped\n\ttitle   here  ") + prompt_line("p" * 900))
    meta = transcript.describe(SID, projects_dir=tmp_path / "projects")
    assert meta["title"] == "wrapped title here"
    assert len(meta["last_prompt"]) == transcript.PROMPT_MAX


def test_unknown_session_and_unsafe_id_yield_nothing(tmp_path):
    (tmp_path / "projects").mkdir()
    assert transcript.describe(SID, projects_dir=tmp_path / "projects") == {}
    assert transcript.find_transcript("../../etc/passwd", None, tmp_path / "projects") is None
    assert transcript.describe("", None, tmp_path / "projects") == {}
    assert transcript.describe(SID, None, tmp_path / "no-such-dir") == {}


def test_cache_returns_fresh_text_after_the_transcript_grows(tmp_path):
    path = write_transcript(tmp_path, title_line("old title"))
    assert transcript.describe(SID, projects_dir=tmp_path / "projects")["title"] == "old title"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(title_line("new title"))
    assert transcript.describe(SID, projects_dir=tmp_path / "projects")["title"] == "new title"


def test_claude_projects_dir_follows_the_env(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cfg"))
    assert transcript.claude_projects_dir() == tmp_path / "cfg" / "projects"
    monkeypatch.delenv("CLAUDE_CONFIG_DIR")
    assert transcript.claude_projects_dir().name == "projects"


# --------------------------------------------------------------- background tasks
# Shapes copied from a real Claude Code 2.1.26x transcript.

def launched(task_id, at="2026-10-22T06:57:00.100Z", sidechain=False):
    return line(type="user", isSidechain=sidechain, timestamp=at, sessionId=SID,
                message={"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_x", "content": ""}]},
                toolUseResult={"stdout": "", "stderr": "", "interrupted": False, "backgroundTaskId": task_id})


def notified(task_id, status="completed"):
    return line(type="queue-operation", operation="enqueue", timestamp="2026-10-22T06:59:15.220Z", sessionId=SID,
                content=f"<task-notification>\n<task-id>{task_id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n"
                        f"<status>{status}</status>\n</task-notification>")


def stopped(task_id, tool="TaskStop"):
    key = "shell_id" if tool == "KillShell" else "task_id"
    return line(type="assistant", sessionId=SID, message={"content": [
        {"type": "tool_use", "id": "toolu_y", "name": tool, "input": {key: task_id}}]})


@pytest.fixture
def projects(tmp_path):
    transcript._TASKS.clear()
    yield tmp_path
    transcript._TASKS.clear()


def tasks(root, since=None, sid=SID):
    return transcript.background_tasks(sid, since=since, projects_dir=root / "projects")


def test_a_shell_left_running_is_counted_until_its_notification(projects):
    path = write_transcript(projects, title_line("refresh") + launched("bvpwgrn36") + launched("bv80z3rnz") + chatter(2))
    assert tasks(projects) == 2  # "2 shells still running"
    with path.open("a") as fh:
        fh.write(notified("bvpwgrn36", "failed"))
    assert tasks(projects) == 1
    with path.open("a") as fh:
        fh.write(notified("bv80z3rnz"))
    assert tasks(projects) == 0


def test_a_stopped_shell_is_not_running(projects):
    write_transcript(projects, launched("a1") + launched("b2") + launched("c3") + stopped("a1") + stopped("b2", "KillShell"))
    assert tasks(projects) == 1


def test_only_complete_lines_are_read_and_each_once(projects):
    path = write_transcript(projects, launched("a1"))
    with path.open("a") as fh:
        fh.write(notified("a1")[:40])  # Claude Code is mid-write
    assert tasks(projects) == 1
    with path.open("a") as fh:
        fh.write(notified("a1")[40:])
    assert tasks(projects) == 0
    # a rewritten (shorter) file is read again from the top
    write_transcript(projects, launched("z9"))
    assert tasks(projects) == 1


def test_tasks_from_before_the_process_started_are_gone(projects):
    from datetime import datetime, timezone
    write_transcript(projects, launched("old", at="2026-10-22T06:00:00.000Z") + launched("new", at="2026-10-22T07:00:00.500Z"))
    assert tasks(projects, since=datetime(2026, 10, 22, 7, 0, 0, tzinfo=timezone.utc)) == 1
    # compared as times, not text: as strings "07:00:00.500Z" would sort before "07:00:00Z"
    assert tasks(projects, since=datetime(2026, 10, 22, 7, 0, 0, 400000, tzinfo=timezone.utc)) == 1
    assert tasks(projects, since=datetime(2026, 10, 22, 7, 0, 1, tzinfo=timezone.utc)) == 0


def test_a_subagents_shells_and_unknown_sessions_count_nothing(projects):
    write_transcript(projects, launched("sub", sidechain=True))
    assert tasks(projects) == 0
    assert tasks(projects, sid="no-such-session") == 0
