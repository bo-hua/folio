import json

import pytest

from folio import jobs

SID = "e97f2433-6613-427e-9be2-349793879a3b"


@pytest.fixture(autouse=True)
def _clear_cache():
    jobs._CACHE.clear()
    yield
    jobs._CACHE.clear()


def write_job(root, short, **fields):
    d = root / short
    d.mkdir(parents=True, exist_ok=True)
    # the shape Claude Code 2.1.308 writes, trimmed; `intent` is your prompt and must never be needed
    body = {"state": "working", "detail": "Running ...", "tempo": "idle", "intent": "do the thing",
            "sessionId": SID, "resumeSessionId": SID, "daemonShort": short, **fields}
    (d / "state.json").write_text(json.dumps(body), encoding="utf-8")
    return d / "state.json"


def test_reads_the_state_of_the_job_running_this_session(tmp_path):
    path = write_job(tmp_path, SID[:8])
    assert jobs.job_state(SID, tmp_path) == "working"
    write_job(tmp_path, SID[:8], state="done", detail="a longer detail line so the size changes")
    assert jobs.job_state(SID, tmp_path) == "done"
    assert path.exists()


def test_finds_a_job_filed_under_another_name_and_ignores_other_sessions(tmp_path):
    write_job(tmp_path, "aaaaaaaa", sessionId="some-other-session", resumeSessionId="some-other-session")
    assert jobs.job_state(SID, tmp_path) is None
    write_job(tmp_path, "bbbbbbbb", sessionId="the-first-run", resumeSessionId=SID, state="blocked")
    assert jobs.job_state(SID, tmp_path) == "blocked"


def test_no_job_or_an_unreadable_one_is_none(tmp_path):
    assert jobs.job_state(SID, tmp_path / "missing") is None
    d = tmp_path / SID[:8]
    d.mkdir()
    (d / "state.json").write_text("{not json", encoding="utf-8")
    assert jobs.job_state(SID, tmp_path) is None
    assert jobs.job_state("", tmp_path) is None


def test_jobs_dir_follows_the_env(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cfg"))
    assert jobs.claude_jobs_dir() == tmp_path / "cfg" / "jobs"
