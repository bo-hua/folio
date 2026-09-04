"""`folio` command line: init, serve, hook, hooks {print,install,uninstall}, worktrees, sessions, tidy."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .config import DEFAULT_BIND, load_config, resolve_data_dir, write_config


def cmd_init(args) -> int:
    from .items import ItemStore

    data_dir = resolve_data_dir(args.data_dir)
    repo = Path(args.repo).expanduser().resolve()
    if not (repo / ".git").exists() and not (repo / "HEAD").exists():
        print(f"warning: {repo} does not look like a git repository", file=sys.stderr)
    path = write_config(data_dir, repo, args.bind)
    store = ItemStore(data_dir / "items")
    store.create_area(args.area)
    (data_dir / "runtime" / "sessions").mkdir(parents=True, exist_ok=True)
    print(f"wrote {path}")
    print(f"items dir: {store.items_dir} (area '{args.area}' created)")
    print("next: `folio hooks print` to see the Claude hook config, then `folio serve`")
    return 0


def cmd_tidy(args) -> int:
    """Rename item files whose filename drifted from the item's name."""
    from .items import ItemStore

    data_dir = resolve_data_dir(args.data_dir)
    store = ItemStore(data_dir / "items")
    if args.dry_run:
        stale = [
            (i.path, store.planned_path(i))
            for i in store.list_items()
            if store.planned_path(i) is not None
        ]
        for old_path, new_path in stale:
            print(f"{old_path.name} -> {new_path.name}  ({old_path.parent.name})")
        print(f"{len(stale)} file(s) would be renamed (dry run)")
        return 0
    moved = store.retitle_files()
    for old_path, new_path in moved:
        print(f"{old_path.name} -> {new_path.name}  ({new_path.parent.name})")
    print(f"renamed {len(moved)} file(s)")
    return 0


def cmd_serve(args) -> int:
    from .server import serve

    data_dir = resolve_data_dir(args.data_dir)
    config = load_config(data_dir)
    if args.repo:
        config.repo = Path(args.repo).expanduser().resolve()
    if config.repo is None:
        print("no repository configured. Run: folio init --repo /path/to/repo", file=sys.stderr)
        return 2
    try:
        serve(config, bind=args.bind, verbose=args.verbose)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


def cmd_hook(args) -> int:
    from .hook import main as hook_main

    return hook_main(args.data_dir)


def cmd_hooks(args) -> int:
    from . import hooks

    data_dir = resolve_data_dir(args.data_dir)
    command = hooks.hook_command(data_dir)
    settings_path = Path(args.settings).expanduser() if args.settings else hooks.default_settings_path()
    if args.action == "print":
        print(json.dumps(hooks.hook_settings(command), indent=2))
        print(f"\n# merge the object above into {settings_path} (or run: folio hooks install)", file=sys.stderr)
        return 0
    try:
        existing = hooks.load_settings(settings_path)
        merged = hooks.merge_settings(existing, command) if args.action == "install" else hooks.remove_settings(existing)
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if merged == existing:
        print(f"{settings_path}: already up to date, nothing to do")
        return 0
    if args.dry_run:
        print(json.dumps(merged, indent=2))
        print(f"\n# dry run: {settings_path} not modified", file=sys.stderr)
        return 0
    backup = hooks.write_settings(settings_path, merged)
    print(f"updated {settings_path}" + (f" (backup: {backup})" if backup else ""))
    if args.action == "install":
        print(f"hook command: {command}")
        print("restart running Claude Code sessions to pick up the change")
    return 0


def cmd_worktrees(args) -> int:
    from .gitinfo import repo_snapshot

    config = load_config(resolve_data_dir(args.data_dir))
    snap = repo_snapshot(Path(args.repo).expanduser() if args.repo else config.repo)
    if snap["error"]:
        print(f"error: {snap['error']}", file=sys.stderr)
        return 2
    print(f"repo: {snap['path']}")
    for wt in snap["worktrees"]:
        kind = "main" if wt["is_main"] else "worktree"
        branch = wt["branch"] or ("detached" if wt["detached"] else "-")
        print(f"  {kind:9} {branch:30} {wt['path']}")
    return 0


def cmd_sessions(args) -> int:
    from .server import App

    config = load_config(resolve_data_dir(args.data_dir))
    data = App(config).recent_sessions(include_all=args.all)
    if not data["sessions"]:
        print("no sessions observed" + ("" if args.all else " inside the configured repo (try --all)"))
    for s in data["sessions"]:
        where = s["worktree"] or s["cwd"] or "-"
        branch = f"[{s['branch']}]" if s["branch"] else ""
        print(f"{(s['updated_at'] or '-')[:19]:20} {s['short_id']:9} {s['state']:9} {where} {branch}")
        title = s["title"] or s["auto_title"]
        if title:
            print(f"{'':20} {title}")
    standing_by = (data.get("spares") or {}).get("standing_by", 0)
    if standing_by:
        # Claude Code's pre-started next background session: no prompt yet, nothing to resume.
        noun = "spare session" if standing_by == 1 else "spare sessions"
        print(f"(+{standing_by} {noun} standing by for the next background job -- not listed until prompted)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--data-dir", help="data directory (default: $FOLIO_DATA_DIR or ~/.cc-workspace)")

    parser = argparse.ArgumentParser(prog="folio", description="Organize AI-assisted work around durable items.")
    parser.add_argument("--version", action="version", version=f"folio {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init", parents=[common], help="write config.toml and create the data directory")
    p.add_argument("--repo", required=True, help="the one git repository to track")
    p.add_argument("--bind", default=DEFAULT_BIND, help=f"server bind address (default {DEFAULT_BIND})")
    p.add_argument("--area", default="Inbox", help="name of the first Area to create")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("serve", parents=[common], help="run the web UI (loopback only)")
    p.add_argument("--bind", help="override HOST:PORT from config.toml; must be a loopback address")
    p.add_argument("--repo", help="override the repository from config.toml")
    p.add_argument("-v", "--verbose", action="store_true", help="log every request")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("hook", parents=[common], help="Claude Code hook entrypoint (reads one event from stdin)")
    p.set_defaults(func=cmd_hook)

    p = sub.add_parser("hooks", parents=[common], help="print / install / uninstall the Claude Code hook config")
    p.add_argument("action", choices=("print", "install", "uninstall"))
    p.add_argument("--settings", help="settings.json to modify (default ~/.claude/settings.json)")
    p.add_argument("--dry-run", action="store_true", help="show the merged result without writing")
    p.set_defaults(func=cmd_hooks)

    p = sub.add_parser("worktrees", parents=[common], help="list the configured repo's worktrees")
    p.add_argument("--repo")
    p.set_defaults(func=cmd_worktrees)

    p = sub.add_parser("tidy", parents=[common], help="rename item files whose filename no longer matches their name")
    p.add_argument("--dry-run", action="store_true", help="show what would be renamed without touching anything")
    p.set_defaults(func=cmd_tidy)

    p = sub.add_parser("sessions", parents=[common], help="list recently observed Claude sessions")
    p.add_argument("--all", action="store_true", help="include sessions outside the configured repo")
    p.set_defaults(func=cmd_sessions)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
