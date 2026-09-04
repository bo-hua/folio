"""How the canvas lays Areas out, exercised against the JavaScript folio ships.

Areas used to sit in rows of ceil(sqrt(n)), and a row is as tall as its tallest
member: with two big Areas and a one-card one, the small Area sat alone a whole
screen below, under the blank the shorter big Area left. Areas now stack in that
many *columns*, and each Area goes under the shortest column so far, so the small
one sits right under the shorter big one. The column count is still a count, so
nothing a card does can change the canvas width; the packing within the columns
is remembered and only redone when a fresh one would save real height. The rule
is pulled out of `static/app.js` and run under node.
"""
import json
import math
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


def columns(tmp_path, *renders, gap=56):
    """Lay the same canvas out once per render; each render is {area name: height in px}.

    Returns the columns of each render, as lists of Area names top to bottom. Insertion
    order of the dict is the Area order, as the server sends it (alphabetical).
    """
    body = (
        f"const RENDERS = {json.dumps(renders)};\n"
        "const out = RENDERS.map(hs => layoutAreas(Object.keys(hs).map(n => ({ id: n })), a => hs[a.id], "
        f"{gap}).map(col => col.map(a => a.id)));\n"
        "console.log(JSON.stringify(out));\n"
    )
    return run(tmp_path, body)


def once(tmp_path, heights, gap=56):
    return columns(tmp_path, heights, gap=gap)[0]


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
def test_column_count_is_a_count_not_a_pixel_budget(tmp_path):
    """ceil(sqrt(n)) columns: squarish, and a card can never change it."""
    got = run(tmp_path, "console.log(JSON.stringify([...Array(13).keys()].map(areaColumns)));\n")
    assert got == [math.ceil(math.sqrt(n)) for n in range(13)]


@node
def test_equal_areas_form_a_balanced_grid(tmp_path):
    """Same-height Areas fill the columns left to right, then start the next tier."""
    assert once(tmp_path, dict.fromkeys("abcd", 300)) == [["a", "c"], ["b", "d"]]
    assert once(tmp_path, dict.fromkeys("abcde", 300)) == [["a", "d"], ["b", "e"], ["c"]]
    assert once(tmp_path, dict.fromkeys("abcdefghi", 300)) == [["a", "d", "g"], ["b", "e", "h"], ["c", "f", "i"]]


@node
def test_a_tall_area_avoids_the_tall_column(tmp_path):
    """Short Areas gather under one another rather than each starting a new tier under a tall one."""
    assert once(tmp_path, {"A": 1000, "B": 300, "C": 300, "D": 900}) == [["A"], ["B", "C", "D"]]


@node
def test_every_area_appears_exactly_once_in_order(tmp_path):
    for n in range(1, 13):
        names = [f"a{i:02d}" for i in range(n)]
        heights = {name: 100 + (i * 397) % 900 for i, name in enumerate(names)}
        cols = once(tmp_path, heights)
        assert len(cols) == math.ceil(math.sqrt(n))
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
    first, second = columns(tmp_path, {"Folio": 1000, "Gen rank paper": 1050, "Manage": 400}, {"Folio": 2000, "Gen rank paper": 1050, "Manage": 400})
    assert first == [["Folio", "Manage"], ["Gen rank paper"]]
    assert second == [["Folio"], ["Gen rank paper", "Manage"]]


@node
def test_adding_or_removing_an_area_lays_out_afresh(tmp_path):
    first, second, third = columns(
        tmp_path,
        {"Folio": 1000, "Gen rank paper": 1050, "Manage": 200},
        {"Folio": 1000, "Gen rank paper": 1050, "Manage": 200, "Paper notes": 300},
        {"Folio": 1000, "Gen rank paper": 1050},
    )
    assert first == [["Folio", "Manage"], ["Gen rank paper"]]
    assert second == [["Folio", "Manage"], ["Gen rank paper", "Paper notes"]]
    assert third == [["Folio"], ["Gen rank paper"]]


def test_world_width_is_not_a_fixed_pixel_budget():
    """A hard-coded world width is what made a third column push an Area down a row."""
    world = next(l for l in STYLE.read_text(encoding="utf-8").splitlines() if l.startswith(".world{"))
    assert "width:max-content" in world
    assert "1980px" not in world
    assert "flex-wrap" not in world
    assert "flex-direction:column" not in world, "the world is a row of columns now"


def test_area_columns_are_styled_and_rows_are_gone():
    css = STYLE.read_text(encoding="utf-8")
    js = APP_JS.read_text(encoding="utf-8")
    assert ".area-col{" in css and "flex-direction:column" in css.split(".area-col{", 1)[1].split("}", 1)[0]
    assert "class: 'area-col'" in js
    assert ".area-row" not in css and "area-row" not in js
