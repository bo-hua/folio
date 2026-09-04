"""Runs the inspector scroll-keeping client tests (tests/inspector_scroll_test.js) under node.

The poll rebuilds the card panel every few seconds. Before this, a rebuild started at
the top: the body was a new element and the notes box lost its own scroll while it was
out of the document, so reading a long note meant being thrown back to its first line
on every refresh. keepScroll() is pulled out of static/app.js and run against a
hand-rolled DOM. Skipped when node is not installed.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SUITE = Path(__file__).with_name("inspector_scroll_test.js")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_the_inspector_keeps_its_scroll_across_a_redraw():
    proc = subprocess.run([NODE, str(SUITE)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "inspector scroll assertions passed" in proc.stdout
