"""The done fold, exercised against the JavaScript folio actually ships.

A parent that has collected a dozen done children used to render every one of
them, and became a column taller than the rest of the canvas put together. Now a
long list folds its done children into one line ("13 done") and stays the height
of its open work. The rule lives in `static/app.js`; this pulls the real block
out and runs it under node, so nothing here is a copy of it.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

APP_JS = Path(__file__).resolve().parents[1] / "folio" / "static" / "app.js"
node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


def block(start: str, end: str) -> str:
    """The source from the line holding `start` up to (not including) the line holding `end`."""
    src = APP_JS.read_text(encoding="utf-8")
    a = src.index(start)
    return src[src.rfind("\n", 0, a) + 1 : src.index(end, a)]


PRELUDE = """'use strict';
const spec = %s;
const state = { selected: spec.selected || null };
const CARDS = spec.cards, SESSIONS = spec.sessions || [];
const kidsOf = id => CARDS.filter(c => c.parent === id);
const sessOf = id => SESSIONS.filter(s => s.item === id);
const lifecycle = c => c.lifecycle || 'idea';
spec.unfolded.forEach(id => unfolded.add(id));
"""
EPILOGUE = """
const r = foldKids(spec.parent, kidsOf(spec.parent));
console.log(JSON.stringify({ foldAt: FOLD_AT, shown: r.shown.map(k => k.id), folded: r.folded.map(k => k.id) }));
"""


def run(tmp_path, cards, parent="p", sessions=None, selected=None, unfolded=()):
    spec = json.dumps({"cards": cards, "parent": parent, "sessions": sessions or [], "selected": selected, "unfolded": list(unfolded)})
    script = tmp_path / "fold.js"
    script.write_text(
        block("const unfolded = new Set()", "let VISIBLE")
        + (PRELUDE % spec)
        + block("const LIVE_STATES", "const closedOut")
        + block("// --- the done fold.", "// --- end of the done fold")
        + EPILOGUE,
        encoding="utf-8",
    )
    out = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def tree(*lifecycles, parent="p"):
    """One parent with children k0, k1, ... in the given lifecycles."""
    return [{"id": parent, "parent": None, "area": "Work", "lifecycle": "active"}] + [
        {"id": f"k{i}", "parent": parent, "area": "Work", "lifecycle": lc} for i, lc in enumerate(lifecycles)
    ]


@node
def test_a_short_list_never_folds_even_when_it_is_all_done(tmp_path):
    got = run(tmp_path, tree("done", "done"))
    n = got["foldAt"]
    assert got["shown"] == ["k0", "k1"] and got["folded"] == []
    # exactly at the threshold is still short: the line would be as tall as what it replaced
    got = run(tmp_path, tree(*["done"] * n))
    assert len(got["shown"]) == n and got["folded"] == []


@node
def test_a_long_list_folds_its_done_children_and_keeps_the_open_ones_in_order(tmp_path):
    n = run(tmp_path, tree("idea"))["foldAt"]
    # the user's case: mostly done, a few open, interleaved
    lcs = ["done", "done", "idea", "done", "active", "parked", "done"] + ["done"] * n
    got = run(tmp_path, tree(*lcs))
    assert got["shown"] == ["k2", "k4", "k5"]  # every open card, in its own order; parked is not done
    assert got["folded"] == [f"k{i}" for i, lc in enumerate(lcs) if lc == "done"]
    assert len(got["folded"]) == lcs.count("done")


@node
def test_a_long_list_with_nothing_done_has_no_fold(tmp_path):
    n = run(tmp_path, tree("idea"))["foldAt"]
    got = run(tmp_path, tree(*["idea"] * (n + 3)))
    assert len(got["shown"]) == n + 3 and got["folded"] == []


@node
def test_the_fold_spares_a_done_card_that_still_holds_open_work(tmp_path):
    n = run(tmp_path, tree("idea"))["foldAt"]
    cards = tree(*["done"] * (n + 2)) + [{"id": "g", "parent": "k1", "area": "Work", "lifecycle": "active"}]
    got = run(tmp_path, cards)
    assert "k1" in got["shown"] and "k1" not in got["folded"]  # k1 is the way in to g
    assert "k0" in got["folded"]
    # a done grandchild under a done child folds with it
    deep = tree(*["done"] * (n + 2)) + [{"id": "g", "parent": "k1", "area": "Work", "lifecycle": "done"}]
    assert "k1" in run(tmp_path, deep)["folded"]


@node
def test_the_fold_spares_a_done_card_a_session_is_live_on(tmp_path):
    n = run(tmp_path, tree("idea"))["foldAt"]
    cards = tree(*["done"] * (n + 2))
    for live in ("needs_you", "working", "ready"):
        got = run(tmp_path, cards, sessions=[{"id": "s", "item": "k3", "state": live}])
        assert got["shown"] == ["k3"], live
    for quiet in ("ended", "inactive", "unknown"):
        got = run(tmp_path, cards, sessions=[{"id": "s", "item": "k3", "state": quiet}])
        assert got["shown"] == [] and "k3" in got["folded"], quiet
    # a live session deeper down keeps the chain out of the fold too
    deep = cards + [{"id": "g", "parent": "k3", "area": "Work", "lifecycle": "done"}]
    got = run(tmp_path, deep, sessions=[{"id": "s", "item": "g", "state": "working"}])
    assert got["shown"] == ["k3"]


@node
def test_the_card_you_have_open_is_pulled_out_of_the_fold(tmp_path):
    n = run(tmp_path, tree("idea"))["foldAt"]
    cards = tree(*["done"] * (n + 2))
    got = run(tmp_path, cards, selected="k4")
    assert got["shown"] == ["k4"] and "k4" not in got["folded"]
    # and so is a done child holding the card you have open
    deep = cards + [{"id": "g", "parent": "k4", "area": "Work", "lifecycle": "done"}]
    assert run(tmp_path, deep, selected="g")["shown"] == ["k4"]


@node
def test_an_opened_fold_shows_everything_but_still_counts_what_it_stands_for(tmp_path):
    n = run(tmp_path, tree("idea"))["foldAt"]
    lcs = ["done", "idea"] + ["done"] * n
    got = run(tmp_path, tree(*lcs), unfolded=["p"])
    assert got["shown"] == [f"k{i}" for i in range(len(lcs))]  # in their own order
    assert len(got["folded"]) == lcs.count("done")  # the line reads "N done" and offers to fold again
    # opening one parent's fold does not open another's
    other = run(tmp_path, tree(*lcs), unfolded=["someone-else"])
    assert other["shown"] == ["k1"]
