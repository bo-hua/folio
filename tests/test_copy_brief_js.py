"""Runs the copy-for-Claude client tests (tests/copy_brief_test.js) under node.

The clipboard API refuses more often than it looks -- no permission, a gesture
that expired during the fetch -- so the fallback that shows the text selected is
the part worth exercising. The suite pulls the real functions out of
static/app.js. Skipped when node is not installed.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SUITE = Path(__file__).with_name("copy_brief_test.js")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_copy_brief_lands_on_the_clipboard_or_in_a_dialog():
    proc = subprocess.run([NODE, str(SUITE)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "copy-brief assertions passed" in proc.stdout
