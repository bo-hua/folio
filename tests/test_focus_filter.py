"""The canvas' focus filter, exercised against the JavaScript folio actually ships.

The rule lives in the browser (the overview API already hands the UI a derived
`lifecycle` per item and a state per session), so this pulls the real block out
of `static/app.js` and runs it under node with the handful of globals it reads.
Nothing is copied -- edit the rule in app.js and this test follows it.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

APP_JS = Path(__file__).resolve().parents[1] / "folio" / "static" / "app.js"
node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


def extract(marker: str, end: str) -> str:
    """The source between two landmarks in app.js, up to the end of that line."""
    src = APP_JS.read_text(encoding="utf-8")
    start = src.index(marker)
    stop = src.index(end, start)
    return src[start : src.index("\n", stop) + 1]


PRELUDE = """'use strict';
const spec = %s;
let VISIBLE = null;
const state = { focus: spec.focus, selected: spec.selected || null };
const CARDS = spec.cards, SESSIONS = spec.sessions || [];
const cardById = id => CARDS.find(c => c.id === id);
const kidsOf = id => CARDS.filter(c => c.parent === id);
const topOf = a => CARDS.filter(c => !c.parent && c.area === a.id);
const sessOf = id => SESSIONS.filter(s => s.item === id);
const lifecycle = c => c.lifecycle || 'idea';
function ancestors(id) { const out = []; let c = cardById(id); while (c && c.parent) { out.unshift(c.parent); c = cardById(c.parent); } return out; }
"""
EPILOGUE = """
computeVisible();
console.log(JSON.stringify({ visible: VISIBLE === null ? null : [...VISIBLE].sort(), hidden: hiddenCount(),
  topKids: CARDS.filter(c => !c.parent).map(c => [c.id, visKidsOf(c.id).map(k => k.id)]),
  rail: SESSIONS.filter(railVisible).map(s => s.id) }));
"""


def run(tmp_path, cards, focus, sessions=None, selected=None):
    spec = json.dumps({"cards": cards, "focus": focus, "sessions": sessions or [], "selected": selected})
    script = tmp_path / "focus.js"
    script.write_text(
        (PRELUDE % spec)
        + extract("const LIVE_STATES", "const FOCUS_ORDER")
        + extract("// --- the focus filter.", "const hiddenCount =")
        + EPILOGUE,
        encoding="utf-8",
    )
    out = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


# One Area: a live card with a finished child, a done card that still holds live
# work, a wholly finished branch, and a parked card.
TREE = [
    {"id": "a", "parent": None, "area": "Work", "lifecycle": "active"},
    {"id": "a1", "parent": "a", "area": "Work", "lifecycle": "done"},
    {"id": "a2", "parent": "a", "area": "Work", "lifecycle": "idea"},
    {"id": "b", "parent": None, "area": "Work", "lifecycle": "done"},
    {"id": "b1", "parent": "b", "area": "Work", "lifecycle": "active"},
    {"id": "c", "parent": None, "area": "Work", "lifecycle": "done"},
    {"id": "c1", "parent": "c", "area": "Work", "lifecycle": "done"},
    {"id": "d", "parent": None, "area": "Work", "lifecycle": "parked"},
]


@node
def test_all_shows_everything(tmp_path):
    got = run(tmp_path, TREE, "all")
    assert got["visible"] is None and got["hidden"] == 0


# --------------------------------------------------------------------------- #
# "Hide done" -- the lifecycle you set
# --------------------------------------------------------------------------- #

@node
def test_hide_done_keeps_a_finished_card_that_still_holds_live_work(tmp_path):
    got = run(tmp_path, TREE, "done")
    # a1 and c1 are done leaves -> gone; c is done with nothing alive inside -> gone.
    # b is done but b1 is active, so b stays as the way in to b1. d is parked -> still shown.
    assert got["visible"] == ["a", "a2", "b", "b1", "d"]
    assert got["hidden"] == 3
    assert dict(got["topKids"])["a"] == ["a2"]  # the done child drops out of the drawn tree


@node
def test_hide_done_never_swallows_a_card_asking_for_you(tmp_path):
    got = run(tmp_path, TREE, "done", sessions=[{"id": "s1", "item": "c1", "state": "needs_you"}])
    # c1 is done, but it is asking for you -- it stays, and c stays as the way in
    assert "c1" in got["visible"] and "c" in got["visible"]
    quiet = run(tmp_path, TREE, "done", sessions=[{"id": "s1", "item": "c1", "state": "ended"}])
    assert "c1" not in quiet["visible"]


@node
def test_a_deep_survivor_pulls_its_whole_chain_through(tmp_path):
    deep = [
        {"id": "p", "parent": None, "area": "Work", "lifecycle": "done"},
        {"id": "q", "parent": "p", "area": "Work", "lifecycle": "done"},
        {"id": "r", "parent": "q", "area": "Work", "lifecycle": "done"},
        {"id": "s", "parent": "r", "area": "Work", "lifecycle": "active"},
        {"id": "t", "parent": "r", "area": "Work", "lifecycle": "done"},
    ]
    got = run(tmp_path, deep, "done")
    assert got["visible"] == ["p", "q", "r", "s"] and got["hidden"] == 1


# --------------------------------------------------------------------------- #
# "Focus" -- what a Claude session is live on right now, whatever the lifecycle
# --------------------------------------------------------------------------- #

@node
def test_focus_keeps_only_cards_carrying_a_live_session(tmp_path):
    got = run(tmp_path, TREE, "live", sessions=[{"id": "s1", "item": "b1", "state": "working"}])
    # b1 is being worked on; b is the way in to it. Everything else -- including the
    # active card `a` and the untouched idea `a2` -- has no live session and drops out.
    assert got["visible"] == ["b", "b1"] and got["hidden"] == 6


@node
def test_focus_reads_live_the_way_the_rail_does(tmp_path):
    for live in ("working", "needs_you", "ready"):
        got = run(tmp_path, TREE, "live", sessions=[{"id": "s1", "item": "a", "state": live}])
        assert got["visible"] == ["a"], live
    for dead in ("ended", "inactive", "unknown"):
        got = run(tmp_path, TREE, "live", sessions=[{"id": "s1", "item": "a", "state": dead}])
        assert got["visible"] == [], dead


@node
def test_focus_does_not_care_what_lifecycle_you_gave_the_card(tmp_path):
    # a done card and a parked card, each with something running on it, both stay
    got = run(tmp_path, TREE, "live", sessions=[
        {"id": "s1", "item": "c1", "state": "working"},
        {"id": "s2", "item": "d", "state": "ready"},
    ])
    assert got["visible"] == ["c", "c1", "d"]


@node
def test_focus_on_a_quiet_workspace_hides_everything(tmp_path):
    got = run(tmp_path, TREE, "live")
    assert got["visible"] == [] and got["hidden"] == len(TREE)


# --------------------------------------------------------------------------- #
# the escape hatch, in both filtered modes
# --------------------------------------------------------------------------- #

@node
def test_the_open_card_and_its_ancestors_stay_on_the_canvas(tmp_path):
    for mode in ("done", "live"):
        got = run(tmp_path, TREE, mode, selected="c1")
        assert "c1" in got["visible"] and "c" in got["visible"], mode
        assert "d" not in got["visible"] or mode == "done", mode


# --------------------------------------------------------------------------- #
# the sessions rail -- it shows what the canvas shows
# --------------------------------------------------------------------------- #

# One session on each kind of card, plus one attached to nothing.
RAIL = [
    {"id": "s-a1", "item": "a1", "state": "ended"},    # on a done leaf
    {"id": "s-b1", "item": "b1", "state": "working"},  # on live work under a done parent
    {"id": "s-c", "item": "c", "state": "ended"},      # on a wholly finished branch
    {"id": "s-free", "item": None, "state": "ready"},  # unattached
]


@node
def test_the_rail_shows_every_session_when_nothing_is_filtered(tmp_path):
    got = run(tmp_path, TREE, "all", sessions=RAIL)
    assert got["rail"] == ["s-a1", "s-b1", "s-c", "s-free"]


@node
def test_hide_done_drops_the_rows_whose_cards_left_the_canvas(tmp_path):
    got = run(tmp_path, TREE, "done", sessions=RAIL)
    # a1 and c are hidden by "hide done", so their sessions go with them. b1 is alive
    # and the unattached row has no card to follow -- both stay.
    assert got["rail"] == ["s-b1", "s-free"]


@node
def test_an_unattached_session_is_never_hidden(tmp_path):
    for mode in ("done", "live"):
        got = run(tmp_path, TREE, mode, sessions=[{"id": "s-free", "item": None, "state": "ended"}])
        assert got["rail"] == ["s-free"], mode


@node
def test_a_session_asking_for_you_survives_every_filter(tmp_path):
    # c1 is done and has no live work, but the card is kept because it needs you --
    # so the row it would be hidden with stays in the rail too.
    for mode in ("done", "live"):
        got = run(tmp_path, TREE, mode, sessions=[{"id": "s1", "item": "c1", "state": "needs_you"}])
        assert got["rail"] == ["s1"], mode


@node
def test_focus_leaves_only_the_rows_on_live_cards(tmp_path):
    got = run(tmp_path, TREE, "live", sessions=RAIL)
    assert got["rail"] == ["s-b1", "s-free"]


@node
def test_the_open_card_keeps_its_rows_in_the_rail(tmp_path):
    got = run(tmp_path, TREE, "done", sessions=RAIL, selected="c")
    assert "s-c" in got["rail"]
