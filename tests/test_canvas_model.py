"""The canvas model: sibling order + move, human-only status, cascade delete, exclusive attach,
and the single overview payload the UI polls."""
import json
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone

import pytest

from folio.config import Config
from folio.items import ItemStore, parse_item, render_item
from folio.runtime import RuntimeStore
from folio.server import make_server


@pytest.fixture
def store(tmp_path, clock):
    return ItemStore(tmp_path / "items", clock=clock)


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

    yield {"call": call, "config": config, "repo": fixture_repo}
    srv.shutdown()
    srv.server_close()


# ---------------------------------------------------------------- store

def test_order_and_park_note_round_trip_and_sorting(store, clock):
    a = store.create("A", "Inbox")
    clock.value = "2026-08-29T10:01:00-07:00"
    b = store.create("B", "Inbox")
    clock.value = "2026-08-29T10:02:00-07:00"
    c = store.create("C", "Inbox")
    # no order yet: creation time decides
    assert [i.name for i in store.list_items()] == ["A", "B", "C"]
    store.move_item(c, area="Inbox", before=a.id)
    names = [i.name for i in store.list_items()]
    assert names == ["C", "A", "B"]
    text = c.path.read_text()
    assert "order: 0" in text and "park_note" not in text
    store.set_human_status(c, "parked", "waiting on Priya")
    again = parse_item(c.path.read_text())
    assert again.status == "parked" and again.park_note == "waiting on Priya" and again.order == 0
    assert "park_note: waiting on Priya" in render_item(again)
    # legacy `waiting` reads as parked with the note "waiting"
    legacy = parse_item("---\nid: x1\nname: L\nstatus: waiting\n---\n")
    assert legacy.human_status == "parked" and legacy.effective_park_note == "waiting"
    # a bogus order is ignored, not fatal
    assert parse_item("---\nid: x2\nname: O\norder: soon\n---\n").order is None


def test_save_snapshots_open_status_from_sessions(store):
    it = store.create("Thing", "Inbox", status="active")
    assert parse_item(it.path.read_text()).status == "idea"  # nothing attached -> idea, whatever was asked
    store.attach_session(it, "sess-1")
    assert parse_item(it.path.read_text()).status == "active"
    store.set_human_status(it, "done")
    assert parse_item(it.path.read_text()).status == "done"
    store.set_human_status(it, "open")
    assert parse_item(it.path.read_text()).status == "active"  # back to derivation: still has a session
    with pytest.raises(ValueError):
        store.set_human_status(it, "bogus")


def test_move_item_reparents_relocates_and_renumbers(store):
    store.create_area("Ranking")
    p = store.create("Parent", "Ranking")
    k1 = store.create("Kid 1", "Ranking", parent=p.id)
    k2 = store.create("Kid 2", "Ranking", parent=p.id)
    loose = store.create("Loose", "Inbox")
    # nest a top-level item from another Area: file moves into the parent's Area, goes last
    store.move_item(loose, parent=p.id)
    assert loose.area == "Ranking" and loose.path.parent.name == "Ranking"
    kids = store.children(p.id)
    assert [k.name for k in kids] == ["Kid 1", "Kid 2", "Loose"] and [k.order for k in kids] == [0, 1, 2]
    # reorder: before the first sibling
    store.move_item(loose, parent=p.id, before=k1.id)
    assert [k.name for k in store.children(p.id)] == ["Loose", "Kid 1", "Kid 2"]
    # after a sibling
    store.move_item(loose, parent=p.id, after=k1.id)
    assert [k.name for k in store.children(p.id)] == ["Kid 1", "Loose", "Kid 2"]
    # move out to the top level of an Area
    store.move_item(k2, area="Inbox")
    k2 = store.get(k2.id)
    assert k2.parent is None and k2.area == "Inbox" and k2.order == 0
    assert [k.name for k in store.children(p.id)] == ["Kid 1", "Loose"]
    # cycles and self-parenting are refused
    with pytest.raises(ValueError):
        store.move_item(p, parent=k1.id)
    with pytest.raises(ValueError):
        store.move_item(p, parent=p.id)


def test_delete_tree_and_exclusive_detach(store):
    p = store.create("P", "Inbox")
    k = store.create("K", "Inbox", parent=p.id)
    g = store.create("G", "Inbox", parent=k.id)
    other = store.create("Other", "Inbox")
    store.attach_session(k, "s-1")
    store.attach_session(other, "s-1")
    changed = store.detach_session_everywhere("s-1", except_id=other.id)
    assert [c.id for c in changed] == [k.id] and store.get(k.id).session_ids() == [] and store.get(other.id).session_ids() == ["s-1"]
    gone = store.delete_tree(p)
    assert {i.id for i in gone} == {p.id, k.id, g.id}
    assert [i.id for i in store.list_items()] == [other.id]


# ---------------------------------------------------------------- server

def test_overview_carries_lifecycle_order_and_sessions(server):
    call, cfg, repo = server["call"], server["config"], server["repo"]
    call("POST", "/api/areas", {"name": "Ranking"})
    _, p = call("POST", "/api/items", {"name": "Objective", "area": "Ranking"})
    _, k = call("POST", "/api/items", {"name": "Prototype", "parent": p["id"]})  # area inferred from the parent
    assert k["area"] == "Ranking" and k["order"] == 0
    _, ov = call("GET", "/api/overview")
    by = {i["id"]: i for i in ov["items"]}
    assert by[p["id"]]["lifecycle"] == "idea" and by[p["id"]]["human_status"] is None
    # a session on the child makes the child active and the parent active (child has started)
    rt = RuntimeStore(cfg.runtime_dir)
    now = datetime.now(timezone.utc)
    rt.record_event({"session_id": "s-work", "hook_event_name": "PreToolUse", "cwd": str(repo["repo"])}, now=now)
    rt.record_event({"session_id": "s-idle", "hook_event_name": "Stop", "cwd": str(repo["repo"])}, now=now)
    call("POST", f"/api/items/{k['id']}/sessions", {"session_id": "s-work", "title": "Impl"})
    _, ov = call("GET", "/api/overview")
    by = {i["id"]: i for i in ov["items"]}
    assert by[k["id"]]["lifecycle"] == "active" and by[p["id"]]["lifecycle"] == "active" and by[p["id"]]["status"] == "active"
    sess = {s["id"]: s for s in ov["sessions"]}
    assert sess["s-work"]["item"] == k["id"] and sess["s-work"]["title"] == "Impl" and sess["s-work"]["state"] == "working"
    assert sess["s-idle"]["item"] is None and sess["s-idle"]["state"] == "ready"
    # an attached session the hook never saw is still listed (state unknown) so the card can show it
    call("POST", f"/api/items/{p['id']}/sessions", {"session_id": "s-manual"})
    _, ov = call("GET", "/api/overview")
    assert {s["id"]: s["state"] for s in ov["sessions"]}["s-manual"] == "unknown"
    assert "human_statuses" in ov and ov["human_statuses"] == ["done", "parked"]


def test_status_semantics_over_http(server):
    call = server["call"]
    _, it = call("POST", "/api/items", {"name": "Thing", "area": "Inbox", "status": "active"})
    assert it["lifecycle"] == "idea" and it["human_status"] is None  # nothing attached; the request was advisory
    st, it = call("PATCH", f"/api/items/{it['id']}", {"status": "parked", "park_note": "after review"})
    assert st == 200 and it["lifecycle"] == "parked" and it["human_status"] == "parked" and it["park_note"] == "after review"
    _, it = call("PATCH", f"/api/items/{it['id']}", {"status": "done"})
    assert it["lifecycle"] == "done" and it["park_note"] == ""
    _, it = call("PATCH", f"/api/items/{it['id']}", {"status": "open"})
    assert it["lifecycle"] == "idea" and it["human_status"] is None
    _, it = call("PATCH", f"/api/items/{it['id']}", {"status": "waiting"})  # legacy spelling
    assert it["lifecycle"] == "parked" and it["park_note"] == "waiting"
    st, err = call("PATCH", f"/api/items/{it['id']}", {"status": "bogus"})
    assert st == 400 and "status" in err["error"]


def test_parking_without_a_note_is_one_call_and_keeps_any_existing_note(server):
    """The Park button sends no park_note — parking must not need one, and must not
    wipe a note that is already in the file."""
    call = server["call"]
    _, it = call("POST", "/api/items", {"name": "Thing", "area": "Inbox"})
    st, it = call("PATCH", f"/api/items/{it['id']}", {"status": "parked"})
    assert st == 200 and it["human_status"] == "parked" and it["park_note"] == ""
    _, it = call("PATCH", f"/api/items/{it['id']}", {"park_note": "after review"})
    assert it["human_status"] == "parked" and it["park_note"] == "after review"
    _, it = call("PATCH", f"/api/items/{it['id']}", {"status": "parked"})  # re-park: note survives
    assert it["park_note"] == "after review"
    _, it = call("PATCH", f"/api/items/{it['id']}", {"status": "parked", "park_note": ""})  # cleared explicitly
    assert it["human_status"] == "parked" and it["park_note"] == ""


def test_move_endpoint_cascade_delete_and_exclusive_attach(server):
    call, cfg = server["call"], server["config"]
    call("POST", "/api/areas", {"name": "Ranking"})
    _, a = call("POST", "/api/items", {"name": "A", "area": "Ranking"})
    _, b = call("POST", "/api/items", {"name": "B", "area": "Ranking"})
    _, c = call("POST", "/api/items", {"name": "C", "area": "Inbox"})
    # order among top-level siblings
    st, moved = call("POST", f"/api/items/{b['id']}/move", {"area": "Ranking", "before": a["id"]})
    assert st == 200 and moved["order"] == 0
    _, ov = call("GET", "/api/overview")
    ranking = [i["name"] for i in ov["items"] if i["area"] == "Ranking" and not i["parent"]]
    assert ranking == ["B", "A"]
    # nest C under A: file moves to Ranking
    st, moved = call("POST", f"/api/items/{c['id']}/move", {"parent": a["id"]})
    assert st == 200 and moved["parent"] == a["id"] and moved["area"] == "Ranking"
    assert (cfg.items_dir / "Ranking" / "c.md").exists() and not (cfg.items_dir / "Inbox" / "c.md").exists()
    # cycle refused; bad types refused
    assert call("POST", f"/api/items/{a['id']}/move", {"parent": c["id"]})[0] == 400
    assert call("POST", f"/api/items/{a['id']}/move", {"parent": 3})[0] == 400
    # exclusive attach: the session leaves B when attached to A
    call("POST", f"/api/items/{b['id']}/sessions", {"session_id": "s-1", "title": "T"})
    call("POST", f"/api/items/{a['id']}/sessions", {"session_id": "s-1", "title": "T"})
    _, ov = call("GET", "/api/overview")
    by = {i["id"]: i for i in ov["items"]}
    assert [s["id"] for s in by[b["id"]]["sessions"]] == [] and [s["id"] for s in by[a["id"]]["sessions"]] == ["s-1"]
    # non-exclusive attach keeps both
    call("POST", f"/api/items/{b['id']}/sessions", {"session_id": "s-1", "exclusive": False})
    _, ov = call("GET", "/api/overview")
    by = {i["id"]: i for i in ov["items"]}
    assert [s["id"] for s in by[b["id"]]["sessions"]] == ["s-1"] and [s["id"] for s in by[a["id"]]["sessions"]] == ["s-1"]
    # cascade delete: A takes C with it
    st, res = call("DELETE", f"/api/items/{a['id']}")
    assert st == 200 and set(res["deleted"]) == {a["id"], c["id"]}
    _, ov = call("GET", "/api/overview")
    assert [i["name"] for i in ov["items"]] == ["B"]
