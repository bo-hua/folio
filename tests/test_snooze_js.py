"""Runs the snooze client tests (tests/snooze_test.js) under node.

A session that needs you can be silenced for an hour, three, or a day: the session
does not change, the counting does. The pieces of static/app.js that decide what
that means -- what counts as needing you, the roll-up, which sessions a card's own
snooze covers, which rows the Needs you list shows, what the API is asked and what
the menu offers -- are plain functions pulled out of the file and run with the DOM
stubbed to what they touch. Skipped when node is not installed.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SUITE = Path(__file__).with_name("snooze_test.js")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_snoozing_an_attention_in_the_client():
    proc = subprocess.run([NODE, str(SUITE)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "snooze assertions passed" in proc.stdout
