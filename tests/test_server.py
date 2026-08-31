import json
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone

import pytest

from folio.config import Config
from folio.runtime import RuntimeStore
from folio import server as server_mod
from folio.server import make_server, parse_bind, resume_command


@pytest.fixture
def server(tmp_path, fixture_repo):
    data = tmp_path / "data"
    config = Config(data_dir=data, repo=fixture_repo["repo"], bind="127.0.0.1:0")
    srv = make_server(config)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    host, port = srv.server_address[:2]

    def call(method, path, body=None):
        req = urllib.request.Request(f"http://{host}:{port}{path}", method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"} if body is not None else {})
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    yield {"call": call, "config": config, "repo": fixture_repo, "url": f"http://{host}:{port}"}
    srv.shutdown()
    srv.server_close()


def test_end_to_end_flow(server):
    call, cfg, repo = server["call"], server["config"], server["repo"]
    status, ov = call("GET", "/api/overview")
    assert status == 200 and ov["repo"]["error"] is None
    assert [w["branch"] for w in ov["repo"]["worktrees"]] == ["main", "feature"]

    assert call("POST", "/api/areas", {"name": "Ranking"})[0] == 200
    status, parent = call("POST", "/api/items", {"name": "Long-term objective", "area": "Ranking", "status": "active", "notes": "# plan\n\nstep one"})
    # `status` is derived: nothing attached yet, so the item is an idea whatever the request said
    assert status == 201 and parent["status"] == "idea" and parent["human_status"] is None and "<h1>plan</h1>" in parent["notes_html"]
    status, child = call("POST", "/api/items", {"name": "Prototype", "area": "Ranking", "parent": parent["id"]})
    assert status == 201 and child["parent"] == parent["id"]
    status, detail = call("GET", f"/api/items/{parent['id']}")
    assert [c["id"] for c in detail["children"]] == [child["id"]]

    # notes edit round-trips and touches only the Notes section
    status, detail = call("PATCH", f"/api/items/{parent['id']}", {"notes": "edited notes", "context": [{"title": "Design doc", "ref": "https://example.com/doc"}]})
    assert status == 200 and detail["notes"] == "edited notes" and detail["context"][0]["ref"] == "https://example.com/doc"
    md = (cfg.items_dir / "Ranking" / "Long-term objective.md").read_text()
    assert "edited notes" in md and "https://example.com/doc" in md

    # runtime: two sessions inside the repo's worktrees, one outside
    rt = RuntimeStore(cfg.runtime_dir)
    now = datetime.now(timezone.utc)
    rt.record_event({"session_id": "s-needs", "hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion", "cwd": str(repo["worktree"] / "src")}, now=now)
    rt.record_event({"session_id": "s-work", "hook_event_name": "PreToolUse", "tool_name": "Read", "cwd": str(repo["repo"])}, now=now)
    rt.record_event({"session_id": "s-elsewhere", "hook_event_name": "Stop", "cwd": "/nowhere"}, now=now)

    status, recent = call("GET", "/api/sessions")
    assert status == 200 and sorted(s["id"] for s in recent["sessions"]) == ["s-needs", "s-work"]
    status, recent_all = call("GET", "/api/sessions?all=1")
    assert len(recent_all["sessions"]) == 3

    # attach multiple sessions to one item (child gets the needs-you one)
    assert call("POST", f"/api/items/{parent['id']}/sessions", {"session_id": "s-work", "title": "Implementation"})[0] == 200
    assert call("POST", f"/api/items/{parent['id']}/sessions", {"session_id": "s-unknown", "title": "Manual id"})[0] == 200
    assert call("POST", f"/api/items/{child['id']}/sessions", {"session_id": "s-needs", "title": "Prototype run"})[0] == 200

    status, detail = call("GET", f"/api/items/{child['id']}")
    sess = detail["sessions"][0]
    assert sess["state"] == "needs_you" and sess["attention"] == "question"
    assert sess["branch"] == "feature" and sess["in_repo"] and sess["is_main_worktree"] is False
    assert sess["resume_command"] == resume_command("s-needs", str(repo["worktree"] / "src"))
    assert "claude --resume s-needs" in sess["resume_command"]
    assert detail["attention"]["level"] == "needs_you"

    status, detail = call("GET", f"/api/items/{parent['id']}")
    states = {s["id"]: s["state"] for s in detail["sessions"]}
    assert states == {"s-work": "working", "s-unknown": "unknown"}
    assert detail["sessions"][0]["is_main_worktree"] is True and detail["sessions"][0]["branch"] == "main"
    assert detail["attention"]["level"] == "working"

    status, ov = call("GET", "/api/overview")
    by_id = {i["id"]: i for i in ov["items"]}
    assert by_id[parent["id"]]["attention"]["level"] == "working"
    assert by_id[parent["id"]]["rollup"]["level"] == "needs_you"  # child's needs-you bubbles up to the parent card
    assert by_id[child["id"]]["attention"]["needs_you"] == 1

    status, res = call("GET", "/api/sessions/s-needs/resume")
    assert status == 200 and res["kind"] == "resume" and res["command"].endswith("claude --resume s-needs") and res["cwd"].endswith("src")
    assert res["alternatives"][0]["command"].endswith("--fork-session")

    # a live *background* session must be attached, not resumed; job commands take the short id
    import os
    rt.record_event({"session_id": "b1234567-aaaa-bbbb-cccc-dddddddddddd", "hook_event_name": "Stop", "cwd": str(repo["repo"])},
                    now=now, process_finder=lambda: (os.getpid(), True))
    status, res = call("GET", "/api/sessions/b1234567-aaaa-bbbb-cccc-dddddddddddd/resume")
    assert status == 200 and res["kind"] == "attach" and res["command"] == "claude attach b1234567"
    assert res["alternatives"][0]["command"].startswith("claude stop b1234567 && cd ")
    assert call("POST", f"/api/items/{parent['id']}/sessions", {"session_id": "b1234567-aaaa-bbbb-cccc-dddddddddddd", "title": "bg job"})[0] == 200
    status, detail = call("GET", f"/api/items/{parent['id']}")
    bg = next(s for s in detail["sessions"] if s["short_id"] == "b1234567")
    assert bg["background"] is True and bg["resume"]["kind"] == "attach" and bg["resume_command"] == "claude attach b1234567"
    # a live *interactive* session still gets --resume but with a warning note
    rt.record_event({"session_id": "i1234567-aaaa-bbbb-cccc-dddddddddddd", "hook_event_name": "Stop", "cwd": str(repo["repo"])},
                    now=now, process_finder=lambda: (os.getpid(), False))
    status, res = call("GET", "/api/sessions/i1234567-aaaa-bbbb-cccc-dddddddddddd/resume")
    assert res["kind"] == "resume" and res["note"] and "another" in res["note"]
    assert call("DELETE", f"/api/items/{parent['id']}/sessions/b1234567-aaaa-bbbb-cccc-dddddddddddd")[0] == 200

    # detach persists
    assert call("DELETE", f"/api/items/{parent['id']}/sessions/s-unknown")[0] == 200
    assert "s-unknown" not in (cfg.items_dir / "Ranking" / "Long-term objective.md").read_text()

    # guard rails
    assert call("PATCH", f"/api/items/{parent['id']}", {"parent": child["id"]})[0] == 400  # cycle
    assert call("PATCH", f"/api/items/{parent['id']}", {"status": "blocked"})[0] == 400
    assert call("GET", "/api/items/nope")[0] == 404
    # delete cascades: the parent takes its child with it (the UI confirms first)
    status, res = call("DELETE", f"/api/items/{parent['id']}")
    assert status == 200 and set(res["deleted"]) == {parent["id"], child["id"]}
    assert call("GET", f"/api/items/{child['id']}")[0] == 404


def test_renaming_a_card_renames_its_file(server):
    """The canvas creates every card as "Untitled idea", then renames it."""
    call, cfg = server["call"], server["config"]
    status, item = call("POST", "/api/items", {"name": "Untitled idea", "area": "Ranking"})
    assert status == 201
    assert (cfg.items_dir / "Ranking" / "Untitled idea.md").exists()

    status, detail = call("PATCH", f"/api/items/{item['id']}", {"name": "Clarify card status"})
    assert status == 200 and detail["name"] == "Clarify card status"
    assert detail["path"].endswith("Ranking/Clarify card status.md")
    assert not (cfg.items_dir / "Ranking" / "Untitled idea.md").exists()
    assert [p.name for p in (cfg.items_dir / "Ranking").glob("*.md")] == ["Clarify card status.md"]

    # and the item is still reachable by id, with its notes intact
    assert call("GET", f"/api/items/{item['id']}")[1]["name"] == "Clarify card status"


def test_delete_area_removes_directory_and_items(server):
    call, cfg = server["call"], server["config"]
    assert call("POST", "/api/areas", {"name": "Client Work"})[0] == 200
    status, top = call("POST", "/api/items", {"name": "Top", "area": "Client Work"})
    status, kid = call("POST", "/api/items", {"name": "Kid", "area": "Client Work", "parent": top["id"]})
    assert call("POST", "/api/areas", {"name": "Other"})[0] == 200
    # a child lives in its parent's Area, whatever `area` says: the tree is what matters
    status, grandkid = call("POST", "/api/items", {"name": "Grandkid", "area": "Other", "parent": kid["id"]})
    assert status == 201 and grandkid["area"] == "Client Work" and (cfg.items_dir / "Client Work" / "kid.md").exists()

    status, res = call("DELETE", "/api/areas/Client%20Work")  # names are URL-encoded in the path
    assert status == 200 and res["deleted"] == "Client Work" and res["areas"] == ["Other"]
    assert sorted(res["items_deleted"]) == sorted([top["id"], kid["id"], grandkid["id"]]) and res["items_detached"] == []
    assert not (cfg.items_dir / "Client Work").exists()
    assert call("GET", f"/api/items/{top['id']}")[0] == 404
    assert call("GET", f"/api/items/{grandkid['id']}")[0] == 404
    status, ov = call("GET", "/api/overview")
    assert [a["name"] for a in ov["areas"]] == ["Other"]

    assert call("DELETE", "/api/areas/Client%20Work")[0] == 404
    assert call("DELETE", "/api/areas/.hidden")[0] == 400
    assert call("GET", "/api/areas/Other")[0] == 405


def test_static_shell_and_bind_guard(server):
    with urllib.request.urlopen(server["url"] + "/", timeout=10) as res:
        assert res.status == 200 and res.headers["Content-Type"].startswith("text/html")
        shell = res.read()
        assert b"<title>folio</title>" in shell
        # the focus filter is chrome the page must actually carry
        for mode in (b'data-focus="all"', b'data-focus="done"', b'data-focus="live"', b'id="focusCount"'):
            assert mode in shell
    with urllib.request.urlopen(server["url"] + "/static/app.js", timeout=10) as res:
        assert res.status == 200 and res.headers["Content-Type"].startswith(("application/javascript", "text/javascript"))
        app_js = res.read()
        assert b"renderRail" in app_js and b"computeVisible" in app_js
        # Park is a one-click state change: no modal between the click and the state
        assert b"toggle-park" in app_js and b"Park \xe2\x80\x94 why" not in app_js
    with urllib.request.urlopen(server["url"] + "/static/favicon.svg", timeout=10) as res:
        assert res.status == 200 and res.headers["Content-Type"] == "image/svg+xml"
        assert b"<svg" in res.read()
    with urllib.request.urlopen(server["url"] + "/item/abc", timeout=10) as res:  # SPA fallback
        assert b"<title>folio</title>" in res.read()
    assert parse_bind("127.0.0.1:4317") == ("127.0.0.1", 4317)
    assert parse_bind("localhost:1") == ("localhost", 1)
    for bad in ("0.0.0.0:4317", "192.168.1.5:4317", ":::80"):
        with pytest.raises(ValueError):
            parse_bind(bad)


def test_inspector_title_uses_the_ui_sans_and_can_wrap(server):
    """The card title in the inspector is typeset in the same family as the rest of
    the UI, and is a textarea so a long name wraps instead of being clipped."""
    with urllib.request.urlopen(server["url"] + "/static/style.css", timeout=10) as res:
        assert res.status == 200 and res.headers["Content-Type"].startswith("text/css")
        css = res.read().decode()
    rule = next(l for l in css.splitlines() if l.startswith(".ins-title textarea{"))
    assert "font-family:var(--sans)" in rule
    assert "var(--serif)" not in rule and "font-style:italic" not in rule
    assert "resize:none" in rule  # height is driven by fitTitle(), not a drag handle
    with urllib.request.urlopen(server["url"] + "/static/app.js", timeout=10) as res:
        js = res.read().decode()
    assert "h('textarea', { value: c.name" in js  # not an <input>: it must be able to wrap
    assert "$('.ins-title textarea')" in js  # focus-on-create still finds the field


def test_overview_flags_a_server_older_than_its_code(server, monkeypatch):
    """The UI is served from disk; the process is not. Report the mismatch.

    Without this, editing folio and forgetting to restart it leaves buttons the
    running process has no route for -- they 404 and appear to do nothing.
    """
    call = server["call"]
    status, ov = call("GET", "/api/overview")
    assert status == 200 and ov["server"]["stale"] is False
    assert ov["server"]["version"] and ov["server"]["started"]

    monkeypatch.setattr(server_mod, "code_mtime", lambda: datetime.now(timezone.utc).timestamp() + 60)
    status, ov = call("GET", "/api/overview")
    assert ov["server"]["stale"] is True and ov["server"]["code_changed"]


def test_unknown_endpoint_is_reported_as_such(server):
    """The UI keys its "restart the server" hint off this exact message."""
    call = server["call"]
    status, res = call("DELETE", "/api/areas/Some%20Area/nope")
    assert status == 404 and res["error"] == "no such endpoint"


def test_sessions_carry_the_title_claude_code_gave_them(server, tmp_path, monkeypatch):
    """The rail's answer to "what is this session about?" with nobody renaming anything."""
    from folio import transcript

    call, cfg, repo = server["call"], server["config"], server["repo"]
    sid = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b"
    proj = tmp_path / "claude" / "projects" / "-some-checkout"
    proj.mkdir(parents=True)
    (proj / f"{sid}.jsonl").write_text(
        json.dumps({"aiTitle": "long-term ranking objective", "sessionId": sid, "type": "ai-title"}) + "\n"
        + json.dumps({"lastPrompt": "try the discounted variant", "sessionId": sid, "type": "last-prompt"}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    transcript._CACHE.clear()
    transcript._PATHS.clear()

    now = datetime(2026, 8, 29, 17, 0, tzinfo=timezone.utc)
    RuntimeStore(cfg.runtime_dir).record_event(
        {"session_id": sid, "hook_event_name": "Stop", "cwd": str(repo["repo"])}, now=now)

    sess = next(s for s in call("GET", "/api/overview")[1]["sessions"] if s["id"] == sid)
    assert sess["auto_title"] == "long-term ranking objective"
    assert sess["last_prompt"] == "try the discounted variant"
    assert sess["title"] == ""  # nothing in the Markdown yet; yours wins once you set it

    assert call("POST", "/api/areas", {"name": "Ranking"})[0] == 200
    item = call("POST", "/api/items", {"name": "Objective", "area": "Ranking"})[1]
    assert call("POST", f"/api/items/{item['id']}/sessions", {"session_id": sid, "title": "the prototype"})[0] == 200
    sess = next(s for s in call("GET", "/api/overview")[1]["sessions"] if s["id"] == sid)
    assert (sess["title"], sess["auto_title"]) == ("the prototype", "long-term ranking objective")

    # nothing derived leaks into the Markdown you own
    files = list((cfg.items_dir / "Ranking").glob("*.md"))
    assert files and all("long-term ranking objective" not in p.read_text() for p in files)
