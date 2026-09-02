"""Runs the Area delete guard's own unit tests (tests/area_delete_test.js) under node.

Deleting an Area is the one thing folio cannot undo, so the menu and the
type-the-name dialog that stand in front of it are worth exercising rather than
eyeballing. The suite pulls both straight out of static/app.js.
Skipped when node is not installed; CI with node gets the real coverage.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SUITE = Path(__file__).with_name("area_delete_test.js")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_area_delete_needs_the_name_typed_back():
    proc = subprocess.run([NODE, str(SUITE)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "area-delete assertions passed" in proc.stdout
