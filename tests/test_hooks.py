import json
import subprocess
import sys
from pathlib import Path

from folio import hooks

EXISTING = {
    "model": "claude-fable-5[1m]",
    "enabledPlugins": {"k12-teacher-skills@k12-teacher-skills": True},
    "effortLevel": "xhigh",
    "hooks": {
        "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "/usr/local/bin/other-hook"}]}],
    },
}
CMD = "/x/.venv/bin/folio hook"


def test_merge_preserves_everything_and_is_idempotent():
    merged = hooks.merge_settings(EXISTING, CMD)
    assert merged["model"] == EXISTING["model"] and merged["enabledPlugins"] == EXISTING["enabledPlugins"]
    pre = merged["hooks"]["PreToolUse"]
    assert pre[0] == EXISTING["hooks"]["PreToolUse"][0]  # the pre-existing hook is untouched and first
    assert pre[1]["hooks"][0]["command"] == CMD
    assert set(hooks.HOOK_EVENTS) <= set(merged["hooks"])
    assert hooks.merge_settings(merged, CMD) == merged  # second install adds nothing
    assert EXISTING["hooks"]["PreToolUse"] == [EXISTING["hooks"]["PreToolUse"][0]]  # input not mutated


def test_remove_only_ours():
    merged = hooks.merge_settings(EXISTING, CMD)
    removed = hooks.remove_settings(merged)
    assert removed == EXISTING


def test_write_settings_backs_up(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(EXISTING))
    backup = hooks.write_settings(path, hooks.merge_settings(EXISTING, CMD))
    assert backup and backup.exists() and json.loads(backup.read_text()) == EXISTING
    assert CMD in path.read_text()


def test_hook_command_points_at_this_venv(tmp_path):
    cmd = hooks.hook_command(tmp_path)
    assert cmd.startswith(str(Path(sys.executable).parent / "folio")) or cmd.startswith(f"{sys.executable} -m folio.cli hook")
    assert "miniforge" not in cmd  # never the resolved base interpreter
    assert f"--data-dir {tmp_path.resolve()}" in cmd
    assert "--data-dir" not in hooks.hook_command(None)


def run_hook(tmp_path, payload: str):
    return subprocess.run(
        [sys.executable, "-m", "folio.cli", "hook", "--data-dir", str(tmp_path)],
        input=payload, capture_output=True, text=True, timeout=30,
    )


def test_hook_cli_is_a_silent_observer(tmp_path):
    event = {"session_id": "abc-123", "hook_event_name": "PermissionRequest", "tool_name": "Bash",
             "tool_input": {"command": "echo SENSITIVE"}, "cwd": "/somewhere", "permission_mode": "default"}
    proc = run_hook(tmp_path, json.dumps(event))
    assert proc.returncode == 0 and proc.stdout == ""  # empty stdout => cannot influence permission decisions
    rec = json.loads((tmp_path / "runtime" / "sessions" / "abc-123.json").read_text())
    assert rec["state"] == "needs_you" and rec["attention"] == "permission" and rec["cwd"] == "/somewhere"
    assert "SENSITIVE" not in (tmp_path / "runtime" / "sessions" / "abc-123.json").read_text()
    # garbage input never fails
    proc = run_hook(tmp_path, "not json")
    assert proc.returncode == 0 and proc.stdout == ""
    proc = run_hook(tmp_path, "")
    assert proc.returncode == 0 and proc.stdout == ""
