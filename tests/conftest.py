import subprocess
from pathlib import Path

import pytest


class FakeClock:
    def __init__(self, start="2026-08-29T10:00:00-07:00"):
        self.value = start

    def __call__(self):
        return self.value


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", str(repo), *args],
        check=True, capture_output=True, text=True,
    ).stdout


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def fixture_repo(tmp_path: Path):
    """A real git repo with a main checkout plus one linked worktree on `feature`."""
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    (repo / "README.md").write_text("hi\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "init")
    wt = tmp_path / "repo-feature"
    git(repo, "worktree", "add", "-q", "-b", "feature", str(wt))
    (wt / "src").mkdir()
    return {"repo": repo, "worktree": wt}
