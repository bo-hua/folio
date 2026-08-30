import os

from folio.gitinfo import list_worktrees, match_cwd, parse_worktree_porcelain, repo_snapshot

SAMPLE = """worktree /home/u/ans
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /home/u/ans-wt-a
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature/a

worktree /home/u/ans-detached
HEAD 3333333333333333333333333333333333333333
detached

"""


def test_parse_porcelain():
    wts = parse_worktree_porcelain(SAMPLE)
    assert [w.path for w in wts] == ["/home/u/ans", "/home/u/ans-wt-a", "/home/u/ans-detached"]
    assert [w.branch for w in wts] == ["main", "feature/a", None]
    assert [w.is_main for w in wts] == [True, False, False]
    assert wts[2].detached is True


def test_match_cwd_longest_prefix():
    wts = parse_worktree_porcelain("worktree /r\nbranch refs/heads/main\n\nworktree /r/wt\nbranch refs/heads/x\n\n")
    assert match_cwd("/r/src", wts).branch == "main"
    assert match_cwd("/r/wt/deep/er", wts).branch == "x"
    assert match_cwd("/r/wtother", wts).branch == "main"  # prefix must end on a path boundary
    assert match_cwd("/elsewhere", wts) is None
    assert match_cwd(None, wts) is None


def test_real_repo_discovery_and_cwd_matching(fixture_repo, tmp_path):
    repo, wt = fixture_repo["repo"], fixture_repo["worktree"]
    wts = list_worktrees(repo)
    assert len(wts) == 2
    main, feature = wts
    assert main.is_main and main.branch == "main"
    assert feature.branch == "feature" and os.path.realpath(feature.path) == os.path.realpath(wt)
    assert match_cwd(str(wt / "src"), wts).branch == "feature"
    assert match_cwd(str(repo), wts).is_main
    # discovery also works when asked from a linked worktree
    assert len(list_worktrees(wt)) == 2
    # symlinked cwd (like /tmp -> /private/tmp on macOS) still matches via realpath
    link = tmp_path / "link"
    os.symlink(wt, link)
    assert match_cwd(str(link / "src"), wts).branch == "feature"


def test_repo_snapshot_errors(tmp_path):
    assert repo_snapshot(None)["error"]
    snap = repo_snapshot(tmp_path)  # not a git repo
    assert snap["error"] and snap["worktrees"] == []
