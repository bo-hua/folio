"""Runs the multi-card session client tests (tests/sessions_test.js) under node.

A session can sit on several cards. The pieces of static/app.js that decide what
that means -- which sessions a card has, the attention roll-up counting a shared
session once, which rail rows the filter keeps, what a drop does (a rail row adds,
a chip moves), and what the API is asked -- are plain functions pulled out of the
file and run with the DOM stubbed to a few globals. Skipped when node is not
installed.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SUITE = Path(__file__).with_name("sessions_test.js")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_a_session_on_several_cards_in_the_client():
    proc = subprocess.run([NODE, str(SUITE)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "multi-card session assertions passed" in proc.stdout
