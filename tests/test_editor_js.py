"""Runs the note editor's own unit tests (tests/editor_test.js) under node.

The editing rules -- Enter continues a list, Tab nests it, numbers stay in order --
are pure text transforms, so they are tested directly rather than through a browser.
Skipped when node is not installed; CI with node gets the real coverage.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SUITE = Path(__file__).with_name("editor_test.js")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_note_editor_typing_rules():
    proc = subprocess.run([NODE, str(SUITE)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "note-editor assertions" in proc.stdout
