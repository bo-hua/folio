"""How the canvas lays Areas out, exercised against the JavaScript folio ships.

Areas used to sit in rows of ceil(sqrt(n)), and a row is as tall as its tallest
member: with two big Areas and a one-card one, the small Area sat alone a whole
screen below, under the blank the shorter big Area left. Areas now stack in that
many *columns*, and each Area goes under the shortest column so far, so the small
one sits right under the shorter big one. How many columns is chosen by the
canvas that wastes least for the window's shape (ceil(sqrt(n)) left a long blank
strip beside a wide Area); the packing is remembered and only redone when a fresh
one is clearly better. The rule is pulled out of `static/app.js` and run under node.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parents[1] / "folio" / "static"
APP_JS = STATIC / "app.js"
STYLE = STATIC / "style.css"
node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

START = "// ------------------------------------------------------------------ area layout"
END = "function render() {"


def layout_block() -> str:
    src = APP_JS.read_text(encoding="utf-8")
    return src[src.index(START) : src.index(END)]


def run(tmp_path, body: str):
    """Run `body` after the layout block under node; it must print one JSON line."""
    script = tmp_path / "layout.js"
    script.write_text("'use strict';\n" + layout_block() + body, encoding="utf-8")
    out = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def columns(tmp_path, *renders, gap=56, view=(1600, 1000)):
    """Lay the same canvas out once per render; each render is {area name: height} or
    {area name: [width, height]} in px (width defaults to one 376px column).

    Returns the columns of each render, as lists of Area names top to bottom. Insertion
    order of the dict is the Area order, as the server sends it (alphabetical).
    """
    sized = [{n: s if isinstance(s, list) else [376, s] for n, s in r.items()} for r in renders]
    body = (
        f"const RENDERS = {json.dumps(sized)};\n"
        "const out = RENDERS.map(ss => layoutAreas(Object.keys(ss).map(n => ({ id: n })), a => ({ w: ss[a.id][0], h: ss[a.id][1] }), "
        f"{gap}, {{ w: {view[0]}, h: {view[1]} }}).map(col => col.map(a => a.id)));\n"
        "console.log(JSON.stringify(out));\n"
    )
    return run(tmp_path, body)


def once(tmp_path, sizes, gap=56, view=(1600, 1000)):
    return columns(tmp_path, sizes, gap=gap, view=view)[0]


@node
def test_the_small_area_sits_under_the_shorter_big_one(tmp_path):
    """The user's case: Manage (one card) used to sit alone below the taller of two big Areas."""
    assert once(tmp_path, {"Folio": 520, "Gen rank paper": 1150, "Manage": 200}) == [["Folio", "Manage"], ["Gen rank paper"]]
    # and under the other one when that is the shorter
    assert once(tmp_path, {"Folio": 1150, "Gen rank paper": 520, "Manage": 200}) == [["Folio"], ["Gen rank paper", "Manage"]]


@node
def test_two_areas_sit_side_by_side(tmp_path):
    """Two Areas share the top, however tall or wide either one grows."""
    assert once(tmp_path, {"Folio": 200, "Gen rank paper": 3000}) == [["Folio"], ["Gen rank paper"]]
    assert once(tmp_path, {"Folio": 3000, "Gen rank paper": 200}) == [["Folio"], ["Gen rank paper"]]


@node
def test_one_area_is_one_column(tmp_path):
    assert once(tmp_path, {"Folio": 400}) == [["Folio"]]


@node
def test_no_areas_is_no_columns(tmp_path):
    assert once(tmp_path, {}) == []


@node
def test_small_areas_tuck_under_a_narrow_one_beside_a_wide_one(tmp_path):
    """The user's board: three columns -- Folio, a very wide Gen rank paper, and MISC, Manage and
    Reading in a column of their own -- made a long mostly-blank strip. Two are far tighter."""
    sizes = {"Folio": [570, 535], "Gen rank paper": [955, 985], "MISC": [570, 135], "Manage": [570, 165], "Reading": [285, 140]}
    assert once(tmp_path, sizes) == [["Folio", "MISC", "Manage", "Reading"], ["Gen rank paper"]]
    # even in a very wide window
    assert once(tmp_path, sizes, view=(2260, 1115)) == [["Folio", "MISC", "Manage", "Reading"], ["Gen rank paper"]]


@node
def test_many_small_areas_do_not_make_one_tall_strip(tmp_path):
    cols = once(tmp_path, dict.fromkeys("abcdefghijkl", 300))
    assert 3 <= len(cols) <= 5, cols


@node
def test_equal_areas_form_a_balanced_grid(tmp_path):
    """Same-height Areas fill the columns left to right, then start the next tier."""
    assert once(tmp_path, dict.fromkeys("abcd", 300)) == [["a", "c"], ["b", "d"]]
    assert once(tmp_path, dict.fromkeys("abcde", 300)) == [["a", "d"], ["b", "e"], ["c"]]
    assert once(tmp_path, dict.fromkeys("abcdefghi", 300)) == [["a", "d", "g"], ["b", "e", "h"], ["c", "f", "i"]]


@node
def test_a_tall_area_avoids_the_tall_column(tmp_path):
    """Short Areas gather under one another rather than each starting a new tier under a tall one:
    in two columns D landed under B and C (1612px); three columns keep everything within A's 1000px."""
    assert once(tmp_path, {"A": 1000, "B": 300, "C": 300, "D": 900}) == [["A"], ["B", "C"], ["D"]]


@node
def test_a_tall_area_late_in_the_list_gets_a_column_of_its_own(tmp_path):
    """The user's board: PHUV, third of four, went under MISC and left Stale activation beside a blank.

    Taken tallest first it gets the right-hand column to itself, and the canvas is ~530px shorter."""
    assert once(tmp_path, {"MISC": 475, "Manage": 500, "PHUV": 1740, "Stale activation": 240}) == [["MISC", "Manage", "Stale activation"], ["PHUV"]]


@node
def test_two_short_areas_share_a_column_beside_two_tall_ones(tmp_path):
    """Three narrow columns (1240 x 1050) beat two (808 x 1406, a tall strip in a wide window)."""
    assert once(tmp_path, {"Folio": 1000, "Gen rank paper": 1050, "Manage": 200, "Paper notes": 300}) == [["Folio"], ["Gen rank paper"], ["Manage", "Paper notes"]]


@node
def test_a_tall_strip_never_wins_by_being_narrow(tmp_path):
    """Stacked, a 200px Area sat a screen below a 3000px one: the old complaint. Past SHAPE_FREE
    off the window's shape the penalty is steep, so the pair stays side by side."""
    assert once(tmp_path, {"Folio": 3000, "Gen rank paper": 200}, view=(2400, 1000)) == [["Folio"], ["Gen rank paper"]]


def deal(tmp_path, *renders, cols=2, gap=16):
    """Deal cards into an Area's columns once per render; each render is {card: height in px}."""
    body = (
        f"const RENDERS = {json.dumps(renders)};\n"
        "const out = RENDERS.map(hs => { const cards = Object.keys(hs).map(n => ({ id: n })), heightOf = c => hs[c.id];\n"
        f"  return sticky('area:x', cards, packColumns(cards, heightOf, {cols}, {gap}),\n"
        f"    (kept, fresh) => packHeight(kept, heightOf, {gap}) <= packHeight(fresh, heightOf, {gap}) + CARD_SLACK).map(col => col.map(c => c.id)); }});\n"
        "console.log(JSON.stringify(out));\n"
    )
    return run(tmp_path, body)


@node
def test_a_card_goes_under_the_shorter_column(tmp_path):
    """PM went under Digest (round-robin, third card -> first column) and hung below a 1000px card."""
    assert deal(tmp_path, {"Digest": 1060, "Feed": 470, "PM": 90})[0] == [["Digest"], ["Feed", "PM"]]
    # equal cards still fill left to right
    assert deal(tmp_path, dict.fromkeys("abcd", 100))[0] == [["a", "c"], ["b", "d"]]


@node
def test_a_card_growing_does_not_shuffle_its_neighbours(tmp_path):
    first, second = deal(tmp_path, {"Digest": 500, "Feed": 520, "PM": 90}, {"Digest": 560, "Feed": 520, "PM": 90})
    assert first == [["Digest", "PM"], ["Feed"]]
    assert second == first, "Digest grew 60px and PM jumped columns"


@node
def test_every_area_appears_exactly_once_in_order(tmp_path):
    for n in range(1, 13):
        names = [f"a{i:02d}" for i in range(n)]
        heights = {name: 100 + (i * 397) % 900 for i, name in enumerate(names)}
        cols = once(tmp_path, heights)
        assert sorted(name for col in cols for name in col) == names, f"{n} areas came back duplicated or dropped"
        for col in cols:
            assert col == sorted(col), f"{n} areas: a column reads out of order"


@node
def test_a_card_growing_does_not_shuffle_areas(tmp_path):
    """Heights nudge every render; an Area only moves when a fresh packing saves real height."""
    first, second = columns(tmp_path, {"Folio": 1000, "Gen rank paper": 1050, "Manage": 200}, {"Folio": 1100, "Gen rank paper": 1050, "Manage": 200})
    assert first == [["Folio", "Manage"], ["Gen rank paper"]]
    assert second == first, "Folio overtook Gen rank paper by 50px and Manage jumped across the canvas"


@node
def test_a_real_imbalance_repacks(tmp_path):
    first, second = columns(tmp_path, {"Folio": 1000, "Gen rank paper": 1050, "Manage": 200}, {"Folio": 2400, "Gen rank paper": 1050, "Manage": 200})
    assert first == [["Folio", "Manage"], ["Gen rank paper"]]
    assert second == [["Folio"], ["Gen rank paper"], ["Manage"]], "Manage stayed 2400px down under Folio"


@node
def test_adding_or_removing_an_area_lays_out_afresh(tmp_path):
    first, second, third = columns(
        tmp_path,
        {"Folio": 1000, "Gen rank paper": 1050, "Manage": 200},
        {"Folio": 1000, "Gen rank paper": 1050, "Manage": 200, "Paper notes": 300},
        {"Folio": 1000, "Gen rank paper": 1050},
    )
    assert first == [["Folio", "Manage"], ["Gen rank paper"]]
    assert second == [["Folio"], ["Gen rank paper"], ["Manage", "Paper notes"]]
    assert third == [["Folio"], ["Gen rank paper"]]


def test_world_width_is_not_a_fixed_pixel_budget():
    """A hard-coded world width is what made a third column push an Area down a row."""
    world = next(l for l in STYLE.read_text(encoding="utf-8").splitlines() if l.startswith(".world{"))
    assert "width:max-content" in world
    assert "1980px" not in world
    assert "flex-wrap" not in world
    assert "flex-direction:column" not in world, "the world is a row of columns now"


def test_area_head_sizes_the_area_and_columns_widen_for_nesting():
    """An absolute head never widened its Area, so a one-column Area wrapped its own name and counts."""
    css = STYLE.read_text(encoding="utf-8")
    head = css.split(".area-head{", 1)[1].split("}", 1)[0]
    assert "position:absolute" not in head and "white-space:nowrap" in head
    assert "width:var(--col-w" in css.split(".col{", 1)[1].split("}", 1)[0]
    assert "--col-w:" in APP_JS.read_text(encoding="utf-8")


def test_area_columns_are_styled_and_rows_are_gone():
    css = STYLE.read_text(encoding="utf-8")
    js = APP_JS.read_text(encoding="utf-8")
    assert ".area-col{" in css and "flex-direction:column" in css.split(".area-col{", 1)[1].split("}", 1)[0]
    assert "class: 'area-col'" in js
    assert ".area-row" not in css and "area-row" not in js
