"""Git worktree discovery for the ONE configured repository.

Git itself is the source of truth (`git worktree list --porcelain`). Nothing
here is persisted; the server re-derives it on demand.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class Worktree:
    path: str  # as reported by git
    real_path: str  # symlinks resolved, used for cwd matching
    head: str | None
    branch: str | None  # short branch name, None when detached/bare
    is_main: bool
    detached: bool = False
    bare: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


class GitError(RuntimeError):
    pass


def parse_worktree_porcelain(text: str) -> list[Worktree]:
    worktrees: list[Worktree] = []
    block: dict = {}

    def flush() -> None:
        if not block.get("worktree"):
            return
        branch = block.get("branch")
        if branch and branch.startswith("refs/heads/"):
            branch = branch[len("refs/heads/") :]
        path = block["worktree"]
        worktrees.append(
            Worktree(
                path=path,
                real_path=os.path.realpath(path),
                head=block.get("HEAD"),
                branch=branch,
                is_main=not worktrees,  # git lists the main worktree first
                detached="detached" in block,
                bare="bare" in block,
            )
        )

    for line in text.splitlines():
        line = line.rstrip("\n")
        if not line:
            flush()
            block = {}
            continue
        key, _, value = line.partition(" ")
        block[key] = value if value else True
    flush()
    return worktrees


def list_worktrees(repo: Path | str) -> list[Worktree]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), "worktree", "list", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GitError(f"could not run git: {exc}") from exc
    if proc.returncode != 0:
        raise GitError(proc.stderr.strip() or f"git exited {proc.returncode}")
    return parse_worktree_porcelain(proc.stdout)


def match_cwd(cwd: str | None, worktrees: list[Worktree]) -> Worktree | None:
    """Longest-prefix match of a session cwd against the repo's worktrees."""
    if not cwd:
        return None
    real = os.path.realpath(cwd)
    best: Worktree | None = None
    for wt in worktrees:
        root = wt.real_path.rstrip(os.sep) or os.sep
        if real == root or real.startswith(root + os.sep):
            if best is None or len(root) > len(best.real_path.rstrip(os.sep)):
                best = wt
    return best


def repo_snapshot(repo: Path | str | None) -> dict:
    """Everything the UI needs to know about the repo, or a clear error."""
    if not repo:
        return {"path": None, "worktrees": [], "error": "no repository configured (run `folio init --repo PATH`)"}
    try:
        worktrees = list_worktrees(repo)
        return {"path": str(repo), "worktrees": [w.to_dict() for w in worktrees], "error": None}
    except GitError as exc:
        return {"path": str(repo), "worktrees": [], "error": str(exc)}
