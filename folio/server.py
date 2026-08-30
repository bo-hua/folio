"""Single-process HTTP server: JSON API + static UI. Stdlib http.server only.

Joins the durable Markdown items with ephemeral Claude runtime state and live
git worktree information on every request; nothing is cached or copied.
"""
from __future__ import annotations

import ipaddress
import json
import re
import shlex
import sys
import threading
import traceback
from dataclasses import dataclass
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import markdown as md

from . import __version__
from .config import Config
from .gitinfo import Worktree, match_cwd, repo_snapshot
from .items import STATUSES, Item, ItemStore
from .runtime import NEEDS_YOU, UNKNOWN, RuntimeStore, aggregate_attention, effective_state, is_live, iso, utc_now

STATIC_DIR = Path(__file__).parent / "static"
_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def render_md(text: str | None) -> str:
    if not text:
        return ""
    return md.markdown(text, extensions=["fenced_code", "tables", "sane_lists"])


def resume_command(session_id: str, cwd: str | None) -> str:
    """`claude --resume` for a session that is not running (cd into its cwd first)."""
    cmd = f"claude --resume {shlex.quote(session_id)}"
    return f"cd {shlex.quote(cwd)} && {cmd}" if cwd else cmd


def resume_plan(session_id: str, record: dict | None, state: str) -> dict:
    """How to get back into this session on the server machine.

    Deliberately plain shell strings so a richer mechanism can replace them:
      - a live *background* session (`claude --bg`, jobs) must be re-opened with
        `claude attach <short-id>`; `--resume` is refused until it is stopped.
      - a live interactive session is open in some terminal already.
      - anything else: `cd <cwd> && claude --resume <id>`.
    """
    cwd = record.get("cwd") if record else None
    short = session_id[:8]
    resume = resume_command(session_id, cwd)
    fork = {"label": "Branch off a copy instead", "command": f"{resume} --fork-session"}
    if record and is_live(record, state) and record.get("background"):
        return {
            "kind": "attach",
            "command": f"claude attach {short}",
            "note": "This session is running as a Claude Code background session; attach to it. "
                    "Ctrl+Z drops back to your shell and it keeps running.",
            "alternatives": [
                {"label": "Stop it, then resume in this terminal", "command": f"claude stop {short} && {resume}"},
                fork,
            ],
        }
    if record and is_live(record, state):
        return {
            "kind": "resume",
            "command": resume,
            "note": "This session looks live (its process is still running) -- it is probably open in another "
                    "terminal; use that one. Resume here only if it is not.",
            "alternatives": [fork],
        }
    return {"kind": "resume", "command": resume, "note": None, "alternatives": [fork]}


@dataclass
class Snapshot:
    now: datetime
    repo: dict
    worktrees: list[Worktree]
    runtime: dict[str, dict]
    items: list[Item]

    @property
    def by_id(self) -> dict[str, Item]:
        return {i.id: i for i in self.items}


class App:
    def __init__(self, config: Config):
        self.config = config
        self.items = ItemStore(config.items_dir)
        self.runtime = RuntimeStore(config.runtime_dir)
        self.lock = threading.Lock()

    # ------------------------------------------------------------------ views
    def snapshot(self) -> Snapshot:
        repo = repo_snapshot(self.config.repo)
        return Snapshot(
            now=utc_now(),
            repo=repo,
            worktrees=[Worktree(**w) for w in repo["worktrees"]],
            runtime={r["session_id"]: r for r in self.runtime.list()},
            items=self.items.list_items(),
        )

    def session_view(self, sess: dict, snap: Snapshot) -> dict:
        sid = sess["id"]
        view = {
            "id": sid,
            "short_id": sid[:8],
            "title": sess.get("title") or "",
            "state": UNKNOWN,
            "attention": None,
            "last_event": None,
            "updated_at": None,
            "cwd": None,
            "permission_mode": None,
            "worktree": None,
            "branch": None,
            "is_main_worktree": None,
            "in_repo": False,
            "background": None,
            "resume": resume_plan(sid, None, UNKNOWN),
            "resume_command": resume_command(sid, None),
        }
        rec = snap.runtime.get(sid)
        if rec:
            state = effective_state(rec, snap.now)
            plan = resume_plan(sid, rec, state)
            view.update(
                state=state,
                attention=rec.get("attention") if state == NEEDS_YOU else None,
                last_event=rec.get("last_event"),
                updated_at=rec.get("updated_at"),
                cwd=rec.get("cwd"),
                permission_mode=rec.get("permission_mode"),
                background=rec.get("background"),
                resume=plan,
                resume_command=plan["command"],
            )
            wt = match_cwd(rec.get("cwd"), snap.worktrees)
            if wt:
                view.update(worktree=wt.path, branch=wt.branch, is_main_worktree=wt.is_main, in_repo=True)
        return view

    def item_summary(self, item: Item, snap: Snapshot) -> dict:
        sessions = [self.session_view(s, snap) for s in item.sessions]
        return {
            "id": item.id,
            "name": item.name,
            "status": item.status,
            "area": item.area,
            "parent": item.parent,
            "created": item.created,
            "updated": item.updated,
            "sessions": sessions,
            "attention": aggregate_attention([s["state"] for s in sessions]),
            "has_ai_state": item.ai_state is not None,
            "context_count": len(item.context),
            "children": [c.id for c in snap.items if c.parent == item.id],
        }

    def overview(self) -> dict:
        snap = self.snapshot()
        summaries = {i.id: self.item_summary(i, snap) for i in snap.items}

        def rollup_states(item_id: str, seen: set[str]) -> list[str]:
            if item_id in seen:
                return []
            seen.add(item_id)
            s = summaries[item_id]
            states = [sv["state"] for sv in s["sessions"]]
            for child in s["children"]:
                states += rollup_states(child, seen)
            return states

        for iid, s in summaries.items():
            s["rollup"] = aggregate_attention(rollup_states(iid, set()))
        return {
            "generated_at": iso(snap.now),
            "version": __version__,
            "repo": snap.repo,
            "data_dir": str(self.config.data_dir),
            "areas": [{"name": a, "count": sum(1 for i in snap.items if i.area == a)} for a in self.items.areas()],
            "statuses": list(STATUSES),
            "items": list(summaries.values()),
        }

    def item_detail(self, item_id: str) -> dict:
        snap = self.snapshot()
        item = snap.by_id.get(item_id)
        if item is None:
            raise ApiError(404, "item not found")
        detail = self.item_summary(item, snap)
        detail.update(
            notes=item.notes,
            notes_html=render_md(item.notes),
            ai_state=item.ai_state,
            ai_state_html=render_md(item.ai_state),
            context=item.context,
            extra=item.extra,
            path=str(item.path),
            children=[self.item_summary(c, snap) for c in snap.items if c.parent == item.id],
            parent_item=self.item_summary(snap.by_id[item.parent], snap) if item.parent in snap.by_id else None,
            areas=self.items.areas(),
            statuses=list(STATUSES),
            candidates=[{"id": i.id, "name": i.name, "area": i.area} for i in snap.items if i.id != item.id],
        )
        return detail

    def recent_sessions(self, include_all: bool = False, limit: int = 50) -> dict:
        snap = self.snapshot()
        attached: dict[str, list[dict]] = {}
        for item in snap.items:
            for sid in item.session_ids():
                attached.setdefault(sid, []).append({"id": item.id, "name": item.name})
        out = []
        for rec in self.runtime.list():
            view = self.session_view({"id": rec["session_id"], "title": ""}, snap)
            if not (view["in_repo"] or include_all):
                continue
            view["attached_to"] = attached.get(rec["session_id"], [])
            out.append(view)
        return {"generated_at": iso(snap.now), "repo": snap.repo, "sessions": out[:limit]}

    # -------------------------------------------------------------- mutations
    def _get_item(self, item_id: str) -> Item:
        item = self.items.get(item_id)
        if item is None:
            raise ApiError(404, "item not found")
        return item

    def create_item(self, body: dict) -> dict:
        try:
            item = self.items.create(
                name=str(body.get("name") or ""),
                area=str(body.get("area") or (self.items.areas() or ["Inbox"])[0]),
                status=str(body.get("status") or "idea"),
                parent=body.get("parent") or None,
                notes=str(body.get("notes") or ""),
                context=body.get("context") or [],
            )
        except ValueError as exc:
            raise ApiError(400, str(exc)) from exc
        return self.item_detail(item.id)

    def update_item(self, item_id: str, body: dict) -> dict:
        item = self._get_item(item_id)
        if "name" in body:
            name = str(body["name"]).strip()
            if not name:
                raise ApiError(400, "name cannot be empty")
            item.name = name
        if "status" in body:
            if body["status"] not in STATUSES:
                raise ApiError(400, f"status must be one of {', '.join(STATUSES)}")
            item.status = body["status"]
        if "notes" in body:
            item.notes = str(body["notes"] or "")
        if "ai_state" in body:
            item.ai_state = str(body["ai_state"] or "")
        if "context" in body:
            if not isinstance(body["context"], list):
                raise ApiError(400, "context must be a list")
            item.context = [
                {"title": str(c.get("title") or c.get("ref") or ""), "ref": str(c.get("ref") or "")}
                for c in body["context"]
                if isinstance(c, dict) and (c.get("ref") or c.get("title"))
            ]
        if "parent" in body:
            parent = body["parent"] or None
            if parent:
                all_items = self.items.list_items()
                if parent == item.id or parent not in {i.id for i in all_items}:
                    raise ApiError(400, "invalid parent")
                if parent in {d.id for d in self.items.descendants(item.id, all_items)}:
                    raise ApiError(400, "parent would create a cycle")
            item.parent = parent
        try:
            self.items.save(item)
            if "area" in body and body["area"] and body["area"] != item.area:
                self.items.move(item, str(body["area"]))
        except ValueError as exc:
            raise ApiError(400, str(exc)) from exc
        return self.item_detail(item.id)

    def delete_item(self, item_id: str) -> dict:
        item = self._get_item(item_id)
        if self.items.children(item.id):
            raise ApiError(409, "item has children; re-parent or delete them first")
        self.items.delete(item)
        return {"deleted": item_id}

    def attach_session(self, item_id: str, body: dict) -> dict:
        item = self._get_item(item_id)
        sid = str(body.get("session_id") or "").strip()
        if not _ID_RE.match(sid):
            raise ApiError(400, "session_id is required")
        self.items.attach_session(item, sid, str(body.get("title") or ""))
        return self.item_detail(item.id)

    def update_session(self, item_id: str, sid: str, body: dict) -> dict:
        item = self._get_item(item_id)
        for s in item.sessions:
            if s["id"] == sid:
                s["title"] = str(body.get("title") or "").strip()
                self.items.save(item)
                return self.item_detail(item.id)
        raise ApiError(404, "session not attached")

    def detach_session(self, item_id: str, sid: str) -> dict:
        item = self._get_item(item_id)
        self.items.detach_session(item, sid)
        return self.item_detail(item.id)

    def create_area(self, body: dict) -> dict:
        try:
            self.items.create_area(str(body.get("name") or ""))
        except ValueError as exc:
            raise ApiError(400, str(exc)) from exc
        return {"areas": self.items.areas()}

    def delete_area(self, name: str) -> dict:
        """Delete an Area and every item in it (the UI confirms first)."""
        name = unquote(name)
        try:
            gone, detached = self.items.delete_area(name)
        except LookupError as exc:
            raise ApiError(404, str(exc)) from exc
        except ValueError as exc:
            raise ApiError(400, str(exc)) from exc
        return {
            "deleted": name,
            "items_deleted": [i.id for i in gone],
            "items_detached": [i.id for i in detached],
            "areas": self.items.areas(),
        }

    def resume(self, sid: str) -> dict:
        if not _ID_RE.match(sid):
            raise ApiError(400, "bad session id")
        rec = self.runtime.get(sid)
        state = effective_state(rec) if rec else UNKNOWN
        plan = resume_plan(sid, rec, state)
        return {"session_id": sid, "cwd": rec.get("cwd") if rec else None, "state": state, **plan}

    # ---------------------------------------------------------------- routing
    ROUTES = (
        ("GET", r"^/api/overview$", "overview"),
        ("GET", r"^/api/repo$", "repo"),
        ("GET", r"^/api/areas$", "areas"),
        ("POST", r"^/api/areas$", "create_area"),
        ("DELETE", r"^/api/areas/([^/]+)$", "delete_area"),
        ("POST", r"^/api/items$", "create_item"),
        ("GET", r"^/api/items/([^/]+)$", "item_detail"),
        ("PATCH", r"^/api/items/([^/]+)$", "update_item"),
        ("DELETE", r"^/api/items/([^/]+)$", "delete_item"),
        ("POST", r"^/api/items/([^/]+)/sessions$", "attach_session"),
        ("PATCH", r"^/api/items/([^/]+)/sessions/([^/]+)$", "update_session"),
        ("DELETE", r"^/api/items/([^/]+)/sessions/([^/]+)$", "detach_session"),
        ("GET", r"^/api/sessions$", "recent_sessions"),
        ("GET", r"^/api/sessions/([^/]+)/resume$", "resume"),
    )

    def route(self, method: str, path: str, query: dict, body: dict | None) -> tuple[int, dict]:
        for m, pattern, name in self.ROUTES:
            match = re.match(pattern, path)
            if not match:
                continue
            if m != method:
                continue
            args = list(match.groups())
            if name == "repo":
                return 200, repo_snapshot(self.config.repo)
            if name == "areas":
                return 200, {"areas": self.items.areas()}
            if name == "recent_sessions":
                return 200, self.recent_sessions(include_all=query.get("all", ["0"])[0] in ("1", "true"))
            handler = getattr(self, name)
            if method in ("POST", "PATCH"):
                args.append(body or {})
            if method == "GET":
                return 200, handler(*args)
            with self.lock:
                return (201 if method == "POST" and name == "create_item" else 200), handler(*args)
        if any(re.match(p, path) for _, p, _ in self.ROUTES):
            raise ApiError(405, "method not allowed")
        raise ApiError(404, "no such endpoint")


class Handler(BaseHTTPRequestHandler):
    app: App
    protocol_version = "HTTP/1.1"
    server_version = f"folio/{__version__}"

    def log_message(self, fmt, *args):  # quiet by default; errors are printed elsewhere
        if self.server.verbose:  # type: ignore[attr-defined]
            super().log_message(fmt, *args)

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                body = None
                if raw:
                    try:
                        body = json.loads(raw)
                    except ValueError as exc:
                        raise ApiError(400, "invalid JSON body") from exc
                    if not isinstance(body, dict):
                        raise ApiError(400, "JSON body must be an object")
                status, payload = self.app.route(method, parsed.path, parse_qs(parsed.query), body)
                self._send_json(status, payload)
            elif method == "GET":
                self._send_static(parsed.path)
            else:
                raise ApiError(405, "method not allowed")
        except ApiError as exc:
            self._send_json(exc.status, {"error": exc.message})
        except Exception:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            self._send_json(500, {"error": "internal error (see server log)"})

    def _send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_static(self, path: str) -> None:
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        if rel.startswith("static/"):
            rel = rel[len("static/") :]
        target = (STATIC_DIR / rel).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
            if path.startswith("/api/") or "." in rel:
                raise ApiError(404, "not found")
            target = STATIC_DIR / "index.html"  # hash-routed SPA: any other path serves the shell
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(target.suffix, "application/octet-stream")
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def parse_bind(bind: str) -> tuple[str, int]:
    host, sep, port = bind.rpartition(":")
    if not sep:
        raise ValueError("bind must look like HOST:PORT")
    host = host.strip("[]") or "127.0.0.1"
    try:
        ip_ok = ipaddress.ip_address(host).is_loopback
    except ValueError:
        ip_ok = host == "localhost"
    if not ip_ok:
        raise ValueError(
            f"refusing to bind to non-loopback address {host!r}; folio is meant to be reached via SSH port forwarding"
        )
    return host, int(port)


class FolioServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    verbose = False


def make_server(config: Config, bind: str | None = None, verbose: bool = False) -> FolioServer:
    host, port = parse_bind(bind or config.bind)
    app = App(config)
    handler = type("BoundHandler", (Handler,), {"app": app})
    server = FolioServer((host, port), handler)
    server.verbose = verbose
    return server


def serve(config: Config, bind: str | None = None, verbose: bool = False) -> None:
    server = make_server(config, bind, verbose)
    host, port = server.server_address[:2]
    print(f"folio {__version__} serving http://{host}:{port}/", flush=True)
    print(f"  data dir : {config.data_dir}", flush=True)
    print(f"  repo     : {config.repo}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
