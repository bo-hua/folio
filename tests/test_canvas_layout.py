"""How the canvas groups Areas into rows, exercised against the JavaScript folio ships.

Areas used to wrap inside a fixed 1980px-wide world, so an Area crossing four
top-level cards grew a third column and shoved its neighbour onto the next row.
Row membership is now a count, not a pixel budget: nothing a card does can break
a row. The rule is pulled out of `static/app.js` and run under node.
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


def extract(marker: str, end: str) -> str:
    src = APP_JS.read_text(encoding="utf-8")
    start = src.index(marker)
    stop = src.index(end, start)
    return src[start : src.index("\n", stop) + 1]


def rows(tmp_path, names):
    script = tmp_path / "rows.js"
    script.write_text(
        "'use strict';\n"
        + extract("const areasPerRow", "}")
        + f"const AREAS = {json.dumps(names)}.map(n => ({{ id: n }}));\n"
        "console.log(JSON.stringify(areaRows(AREAS).map(r => r.map(a => a.id))));\n",
        encoding="utf-8",
    )
    out = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


@node
def test_two_areas_sit_side_by_side(tmp_path):
    """The user's case: two Areas share one row, however wide either one grows."""
    assert rows(tmp_path, ["Folio", "Gen rank paper"]) == [["Folio", "Gen rank paper"]]


@node
def test_one_area_is_one_row(tmp_path):
    assert rows(tmp_path, ["Folio"]) == [["Folio"]]


@node
def test_no_areas_is_no_rows(tmp_path):
    assert rows(tmp_path, []) == []


@node
def test_many_areas_form_a_balanced_grid(tmp_path):
    """Rows stay squarish, so the canvas never becomes one long strip."""
    assert rows(tmp_path, list("abcd")) == [["a", "b"], ["c", "d"]]
    assert rows(tmp_path, list("abcde")) == [["a", "b", "c"], ["d", "e"]]
    assert rows(tmp_path, list("abcdefghi")) == [list("abc"), list("def"), list("ghi")]


@node
def test_every_area_appears_exactly_once(tmp_path):
    for n in range(1, 13):
        names = [f"a{i}" for i in range(n)]
        flat = [name for row in rows(tmp_path, names) for name in row]
        assert flat == names, f"{n} areas came back reordered or duplicated"


def test_world_width_is_not_a_fixed_pixel_budget():
    """A hard-coded world width is what made a third column push an Area down a row."""
    world = next(l for l in STYLE.read_text(encoding="utf-8").splitlines() if l.startswith(".world{"))
    assert "width:max-content" in world
    assert "1980px" not in world
    assert "flex-wrap" not in world


def test_area_row_is_styled():
    css = STYLE.read_text(encoding="utf-8")
    assert ".area-row{" in css
    assert "class: 'area-row'" in APP_JS.read_text(encoding="utf-8")
