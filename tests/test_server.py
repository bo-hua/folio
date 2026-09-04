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


def test_deleting_an_area_is_not_one_click(server):
    """The server's Area delete is an rmtree with no undo, so the page must not put a
    button in front of it. The Area header carries a ⋯ menu; the delete hides inside,
    behind a dialog that stays disabled until the Area's name is typed back -- never a
    native confirm(), which a stray Enter accepts."""
    with urllib.request.urlopen(server["url"] + "/static/app.js", timeout=10) as res:
        assert res.status == 200
        js = res.read().decode()
    assert "'data-act': 'area-menu'" in js
    assert "'data-act': 'delete-area'" not in js, "no click anywhere should delete an Area outright"
    header = js.split("function areaEl(a) {", 1)[1].split("\nfunction ", 1)[0]
    assert "Delete" not in header, "the Area header must not offer a delete"
    gate = js.split("function typeToConfirm(", 1)[1].split("\nfunction ", 1)[0]
    assert "disabled: true" in gate  # the confirm button is born dead
    assert "if (armed()) close(true)" in gate  # ...and Enter cannot get past the gate either
    door = js.split("function deleteArea(", 1)[1].split("\n}", 1)[0]
    assert "window.confirm" not in door and "typeToConfirm({" in door
    assert "phrase: area.name" in door  # what has to be typed is the Area's own name
    with urllib.request.urlopen(server["url"] + "/static/style.css", timeout=10) as res:
        assert res.status == 200 and res.headers["Content-Type"].startswith("text/css")
        css = res.read().decode()
    assert ".area-del" not in css, "the hover-to-reveal delete button is gone"
    for sel in (".area-menu{", ".pop-i.harm{", ".scrim{", ".dlg{"):
        assert any(l.startswith(sel) for l in css.splitlines()), sel
    assert "cursor:not-allowed" in next(l for l in css.splitlines() if l.startswith(".dlg-acts .go{"))


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


def test_wheel_over_the_inspector_scrolls_it_rather_than_panning(server):
    """The inspector lives inside .stage, so its wheel events bubble to the pan
    handler. Without a guard ahead of preventDefault() the panel cannot scroll at
    all -- the wheel moves the camera instead, and long card details are unreachable."""
    with urllib.request.urlopen(server["url"] + "/static/app.js", timeout=10) as res:
        assert res.status == 200
        js = res.read().decode()
    handler = js.split("stage.addEventListener('wheel'", 1)[1].split("{ passive: false }", 1)[0]
    assert "closest('.inspector')" in handler, "wheel over the inspector would pan the canvas"
    bail = handler.index("closest('.inspector')")
    swallow = handler.index("e.preventDefault()")
    assert bail < swallow and "return" in handler[bail:swallow]
    with urllib.request.urlopen(server["url"] + "/static/style.css", timeout=10) as res:
        css = res.read().decode()
    for sel in (".rail-body{", ".ins-body{"):  # both side panels own their own scrolling
        assert "overflow-y:auto" in next(l for l in css.splitlines() if l.startswith(sel))


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


def test_note_editor_is_served_and_wired_into_the_page(server):
    """Notes are edited as formatted text and stored as Markdown: the editor is a
    real asset the shell loads, and the notes section is built from it rather than
    from a bare textarea."""
    with urllib.request.urlopen(server["url"] + "/static/editor.js", timeout=10) as res:
        assert res.status == 200 and res.headers["Content-Type"].startswith(("application/javascript", "text/javascript"))
        js = res.read().decode()
    # Markdown is the wire format on both sides of the editing surface
    for fn in ("function mdToHtml(", "function htmlToMd(", "function blockRules(", "function inlineRules("):
        assert fn in js
    assert "contentEditable = 'true'" in js          # you type into formatted text, not into syntax
    for cmd in ("insertUnorderedList", "insertOrderedList", "'indent'", "'outdent'"):
        assert cmd in js                             # native list handling keeps Enter/Tab on the undo stack
    assert "/^[-*+]\\s$/" in js                      # "- " is what turns a line into a bullet
    with urllib.request.urlopen(server["url"] + "/", timeout=10) as res:
        shell = res.read()
    assert b'<script src="/static/editor.js">' in shell  # loaded before app.js, which uses it
    assert shell.index(b"/static/editor.js") < shell.index(b"/static/app.js")
    with urllib.request.urlopen(server["url"] + "/static/app.js", timeout=10) as res:
        app_js = res.read().decode()
    assert "NoteEditor.create(" in app_js
    assert "'data-act': 'notes'" not in app_js  # the editor owns saving now, not the blur handler
    with urllib.request.urlopen(server["url"] + "/static/style.css", timeout=10) as res:
        css = res.read().decode()
    for rule in (".md-doc{", ".md-doc li.task{", ".md-src{"):
        assert rule in css


def test_typing_a_note_is_not_a_canvas_shortcut(server):
    """The canvas keys (j, h, f, n, -, =) must stand aside for the note editor.
    It is a contenteditable, not an <input>, so guarding on tag name alone let
    typing "- " zoom the canvas out."""
    with urllib.request.urlopen(server["url"] + "/static/app.js", timeout=10) as res:
        js = res.read().decode()
    guard = next(l for l in js.splitlines() if "matches('input, textarea')" in l)
    assert "isContentEditable" in guard
    # the poll must leave a half-written note alone for the same reason
    editing = next(l for l in js.splitlines() if l.startswith("function isEditing()"))
    assert "isContentEditable" in editing


def test_the_placeholder_gets_out_of_the_way(server):
    """Right after "- " there is a bullet but no text yet. The hint has to go:
    emptiness is about structure, not just characters."""
    with urllib.request.urlopen(server["url"] + "/static/editor.js", timeout=10) as res:
        js = res.read().decode()
    blank = next(l for l in js.splitlines() if "const blank = ()" in l)
    for tag in ("ul", "ol", "blockquote", "input"):
        assert tag in blank


def test_a_link_in_a_note_opens_on_modifier_click(server):
    """A link in the notes is editable text, so a plain click has to keep placing
    the caret; ⌘-click (Ctrl-click elsewhere) opens it in a new tab. The hint bar
    says so, and the cursor turns into a pointer while the modifier is down."""
    with urllib.request.urlopen(server["url"] + "/static/editor.js", timeout=10) as res:
        js = res.read().decode()
    assert "function linkTarget(" in js                       # the pure part, covered by editor_test.js
    assert "window.open(href, '_blank', 'noopener')" in js    # a new tab, not a navigation away from folio
    assert "opens a link" in js                               # the hint bar teaches it
    with urllib.request.urlopen(server["url"] + "/static/style.css", timeout=10) as res:
        css = res.read().decode()
    assert ".mod-held .md-doc a{cursor:pointer}" in css


def test_brief_packs_the_card_and_its_surroundings_for_a_prompt(server):
    """GET /api/items/<id>/brief is what the card's copy button puts on the clipboard:
    the card, its notes and links, its sessions (branch, cwd), its children, and the
    notes of the cards above it -- one block to paste after "work on this"."""
    call, cfg, repo = server["call"], server["config"], server["repo"]
    assert call("POST", "/api/areas", {"name": "Ranking"})[0] == 200
    _, root = call("POST", "/api/items", {"name": "Better ranking", "area": "Ranking", "notes": "the goal: a longer-term objective"})
    _, mid = call("POST", "/api/items", {"name": "Bigger features", "parent": root["id"]})
    _, leaf = call("POST", "/api/items", {"name": "Prototype", "parent": mid["id"], "notes": "- try the discounted variant",
                                          "context": [{"title": "Design doc", "ref": "https://example.com/doc"}]})
    _, kid = call("POST", "/api/items", {"name": "Eval harness", "parent": leaf["id"]})
    now = datetime.now(timezone.utc)
    RuntimeStore(cfg.runtime_dir).record_event({"session_id": "s-proto", "hook_event_name": "PreToolUse", "tool_name": "Read", "cwd": str(repo["worktree"] / "src")}, now=now)
    assert call("POST", f"/api/items/{leaf['id']}/sessions", {"session_id": "s-proto", "title": "Prototype run"})[0] == 200

    status, res = call("GET", f"/api/items/{leaf['id']}/brief")
    assert status == 200 and res["id"] == leaf["id"] and res["name"] == "Prototype"
    text = res["text"]
    lines = text.splitlines()
    assert lines[0] == "folio card “Prototype”"
    assert lines[1] == f"id: {leaf['id']} · status: active · in: Ranking › Better ranking › Bigger features"
    assert lines[2].startswith("file: ") and lines[2].endswith("/items/Ranking/Prototype.md")
    assert "## Notes\n- try the discounted variant\n" in text
    assert "## Context\n- Design doc: https://example.com/doc\n" in text
    assert "## Sessions\n- “Prototype run” (s-proto) — working · branch feature · " in text
    assert "## Children\n- Eval harness — idea\n" in text
    # the direct parent has nothing to say beyond its name (already in the `in:` line); the root's notes come along
    assert "## Parent: Bigger features" not in text
    assert "## Parent of “Bigger features”: Better ranking (active)\nthe goal: a longer-term objective" in text
    assert text[0] not in "#/!"  # pasted alone into Claude Code, those would be a memory note / slash / shell command

    assert call("GET", "/api/items/nope/brief")[0] == 404
    assert call("POST", f"/api/items/{leaf['id']}/brief", {})[0] == 405


def test_the_copy_button_is_on_every_card_and_in_the_inspector(server):
    """The page must actually carry the button, the shortcut, and the styles behind them."""
    with urllib.request.urlopen(server["url"] + "/static/app.js", timeout=10) as res:
        assert res.status == 200
        js = res.read().decode()
    assert js.count("'data-act': 'copy-brief'") == 2, "one button per card on the canvas, one in the inspector"
    assert "/brief`" in js and "navigator.clipboard.writeText(text)" in js
    card = js.split("function cardEl(c, depth = 0) {", 1)[1].split("\nfunction ", 1)[0]
    assert "class: 'card-copy'" in card and "copy-brief" in card
    assert "function showBriefToCopy(" in js  # the clipboard can refuse; the text is shown instead
    keys = js.split("document.addEventListener('keydown', e => {", 1)[1].split("});", 1)[0]
    assert "e.key === 'c'" in keys and "!e.metaKey && !e.ctrlKey" in keys, "C copies; ⌘C stays the browser's"
    with urllib.request.urlopen(server["url"] + "/static/style.css", timeout=10) as res:
        assert res.status == 200 and res.headers["Content-Type"].startswith("text/css")
        css = res.read().decode()
    for sel in (".card-copy{", ".brief-src{", ".ins-path .ins-acts{"):
        assert any(l.startswith(sel) for l in css.splitlines()), sel
    reveal = next(l for l in css.splitlines() if l.startswith(".card-head:hover .card-copy"))
    assert ".card.selected>.card-head .card-copy" in reveal  # the open card keeps its button visible
    with urllib.request.urlopen(server["url"] + "/", timeout=10) as res:
        assert b"<kbd>C</kbd> copy" in res.read()


def test_the_page_says_when_it_last_read_the_sessions(server):
    """A "3m" on a session row is Claude Code's clock (its last hook event). When *folio*
    last looked is a different question, and the page has to answer it out loud --
    otherwise a paused poll (typing, dragging, a menu open) is indistinguishable from
    Claude going quiet. The rail head carries a label that ticks every second."""
    with urllib.request.urlopen(server["url"] + "/", timeout=10) as res:
        html = res.read().decode()
    head = html.split('<div class="rail-head">', 1)[1].split("</div>", 1)[0]
    assert 'id="fresh"' in head and 'class="fresh"' in head, "the label sits in the Sessions rail head"
    with urllib.request.urlopen(server["url"] + "/static/app.js", timeout=10) as res:
        assert res.status == 200 and res.headers["Content-Type"].startswith("text/javascript")
        js = res.read().decode()
    assert "function freshLabel(" in js and "function pauseReason(" in js
    assert "setInterval(tick, 1000)" in js, "one ticker advances the label and polls when a read is due"
    assert "setInterval(() => { if (canRefresh()) refresh(); }" not in js, "the old blind poll loop is gone"
    assert "'visibilitychange'" in js and "pollNow" in js, "coming back to the tab reads at once"
    assert js.count("title: agoTip(s)") == 2, "the row age (rail) and the inspector age both say whose clock they are"
    assert "FRESH.error = (e && e.message)" in js, "a failed poll is a state of the label, not a toast that blocks the next poll"
    with urllib.request.urlopen(server["url"] + "/static/style.css", timeout=10) as res:
        assert res.status == 200 and res.headers["Content-Type"].startswith("text/css")
        css = res.read().decode()
    for sel in (".fresh{", ".fresh.paused{", ".fresh.err{", ".fresh .fdot{"):
        assert any(l.startswith(sel) or ("}" + sel) in l for l in css.splitlines()), sel
