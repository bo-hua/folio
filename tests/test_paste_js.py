"""Runs the note editor's paste tests (tests/paste_test.js) in headless Chrome.

What a paste does to a note depends on the browser's own editing engine, not on
the editor's pure functions: Chrome places pasted paragraphs differently inside a
list item than in a paragraph, and that is exactly where a note once came back
with its headings run together. So these scenarios need a real browser. Skipped
when node or Chrome is not installed; a machine with both gets the coverage.
"""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SUITE = Path(__file__).with_name("paste_test.js")
CHROME_CANDIDATES = [
    os.environ.get("CHROME"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("google-chrome"),
    shutil.which("google-chrome-stable"),
    shutil.which("chromium"),
    shutil.which("chromium-browser"),
]
CHROME = next((c for c in CHROME_CANDIDATES if c and Path(c).exists()), None)


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(CHROME is None, reason="Chrome is not installed (set $CHROME)")
def test_pasting_into_a_note_keeps_its_structure():
    env = {**os.environ, "CHROME": CHROME}
    proc = subprocess.run([NODE, str(SUITE)], capture_output=True, text=True, timeout=180, env=env)
    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "paste assertions" in proc.stdout
