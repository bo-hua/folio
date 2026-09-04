"""Runs the "checked … ago" client tests (tests/fresh_test.js) under node.

The label that says when folio last read Claude Code's session records has three
faces -- live, paused (with the reason), unreachable -- and the ticker behind it
must poll only when a read is both due and safe. All of that is plain functions
pulled out of static/app.js; the DOM is a handful of stubbed globals. Skipped
when node is not installed.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SUITE = Path(__file__).with_name("fresh_test.js")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_the_freshness_label_and_its_ticker():
    proc = subprocess.run([NODE, str(SUITE)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "freshness assertions passed" in proc.stdout
