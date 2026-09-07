"""Runs the card-title paste tests (tests/title_paste_test.js).

The title is a one-row textarea that grows with its text, and its name is only tidied
on blur. What you copy usually ends in a newline, so pasted as-is it opened a blank
second row under the title with the caret on it. The paste handler in static/app.js
folds the pasted text onto one line and drops its trailing whitespace before it lands.

The suite has two halves: titlePaste() pulled out of app.js and run under node, and
the paste listener itself driven in headless Chrome, since whether
execCommand('insertText') writes into a textarea, moves the caret and fires input is
the browser's call. The node half always runs; the Chrome half needs Chrome, found via
$CHROME or the usual places, and is skipped without it.
"""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SUITE = Path(__file__).with_name("title_paste_test.js")
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
def test_a_pasted_title_becomes_one_trimmed_line():
    env = {**os.environ, "NO_CHROME": "1"}
    proc = subprocess.run([NODE, str(SUITE)], capture_output=True, text=True, timeout=60, env=env)
    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "title paste assertions (pure)" in proc.stdout


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(CHROME is None, reason="Chrome is not installed (set $CHROME)")
def test_pasting_into_the_title_in_chrome_lands_as_one_trimmed_line():
    env = {**os.environ, "CHROME": CHROME}
    env.pop("NO_CHROME", None)
    proc = subprocess.run([NODE, str(SUITE)], capture_output=True, text=True, timeout=180, env=env)
    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "title paste assertions in Chrome" in proc.stdout
