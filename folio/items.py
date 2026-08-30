"""Markdown work items: the durable source of truth.

Layout (inside the data dir):

    items/<Area>/<slug>.md

An Area is simply a directory. An Item is one Markdown file with a small YAML
frontmatter and a free-form body. The body may contain an optional
`## AI state` section and a `## Notes` section; everything else is preserved
verbatim. Nothing about children, worktrees, branches or live Claude state is
stored here -- those are derived at runtime.
"""
from __future__ import annotations

import os
import re
import secrets
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Iterable

import yaml

STATUSES = ("idea", "active", "waiting", "done", "parked")
DEFAULT_STATUS = "idea"
KNOWN_KEYS = ("id", "name", "created", "updated", "status", "parent", "sessions", "context")
_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
_FENCE_RE = re.compile(r"^(```|~~~)")
_H2_RE = re.compile(r"^## +(.+?)\s*$")


def now_iso() -> str:
    return datetime.now().astimezone().replace(microsecond=0).isoformat()


def new_id() -> str:
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(8))


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:60].strip("-") or "item"


# --------------------------------------------------------------------------- #
# Body sections
# --------------------------------------------------------------------------- #

def split_sections(body: str) -> tuple[str, list[tuple[str, str]]]:
    """Split a Markdown body into (preamble, [(h2 heading, content), ...]).

    Only `## ` headings outside fenced code blocks start a section. Content is
    kept raw so that re-joining is lossless apart from section-boundary blank
    lines.
    """
    preamble_lines: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    in_fence = False
    for line in body.split("\n"):
        if _FENCE_RE.match(line):
            in_fence = not in_fence
        m = None if in_fence else _H2_RE.match(line)
        if m:
            sections.append((m.group(1), []))
        elif sections:
            sections[-1][1].append(line)
        else:
            preamble_lines.append(line)
    return "\n".join(preamble_lines), [(h, "\n".join(ls)) for h, ls in sections]


def join_sections(preamble: str, sections: Iterable[tuple[str, str]]) -> str:
    parts: list[str] = []
    pre = preamble.strip("\n")
    if pre:
        parts.append(pre + "\n")
    for heading, content in sections:
        content = content.strip("\n")
        parts.append(f"## {heading}\n\n{content}\n" if content else f"## {heading}\n")
    return "\n".join(parts)


def get_section(body: str, heading: str) -> str | None:
    _, sections = split_sections(body)
    for h, content in sections:
        if h.strip().lower() == heading.lower():
            return content.strip("\n")
    return None


def set_section(body: str, heading: str, text: str) -> str:
    """Return body with the named section's content replaced (or appended)."""
    preamble, sections = split_sections(body)
    out: list[tuple[str, str]] = []
    replaced = False
    for h, content in sections:
        if not replaced and h.strip().lower() == heading.lower():
            out.append((h, text))
            replaced = True
        else:
            out.append((h, content))
    if not replaced:
        out.append((heading, text))
    return join_sections(preamble, out)


# --------------------------------------------------------------------------- #
# Item model + (de)serialization
# --------------------------------------------------------------------------- #

@dataclass
class Item:
    id: str
    name: str
    created: str
    updated: str
    status: str = DEFAULT_STATUS
    parent: str | None = None
    sessions: list[dict] = field(default_factory=list)  # [{"id": ..., "title": ...}]
    context: list[dict] = field(default_factory=list)  # [{"title": ..., "ref": ...}]
    body: str = ""
    extra: dict = field(default_factory=dict)  # unknown frontmatter keys, preserved
    area: str = ""  # derived from directory
    path: Path | None = None  # where it lives on disk

    @property
    def notes(self) -> str:
        return get_section(self.body, "Notes") or ""

    @notes.setter
    def notes(self, text: str) -> None:
        self.body = set_section(self.body, "Notes", text)

    @property
    def ai_state(self) -> str | None:
        return get_section(self.body, "AI state")

    @ai_state.setter
    def ai_state(self, text: str) -> None:
        self.body = set_section(self.body, "AI state", text)

    def session_ids(self) -> list[str]:
        return [s["id"] for s in self.sessions if s.get("id")]


def _str_ts(value) -> str:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value) if value is not None else ""


def _clean_pairs(values, key_a: str, key_b: str) -> list[dict]:
    out = []
    for v in values or []:
        if isinstance(v, dict) and v.get(key_a):
            out.append({key_a: str(v[key_a]), key_b: str(v.get(key_b) or "")})
        elif isinstance(v, str) and v:
            out.append({key_a: v, key_b: ""})
    return out


def parse_item(text: str) -> Item:
    lines = text.split("\n")
    fm: dict = {}
    body = text
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                loaded = yaml.safe_load("\n".join(lines[1:i])) or {}
                fm = loaded if isinstance(loaded, dict) else {}
                body = "\n".join(lines[i + 1 :]).lstrip("\n")
                break
    extra = {k: v for k, v in fm.items() if k not in KNOWN_KEYS}
    status = str(fm.get("status") or DEFAULT_STATUS)
    return Item(
        id=str(fm.get("id") or ""),
        name=str(fm.get("name") or ""),
        created=_str_ts(fm.get("created")),
        updated=_str_ts(fm.get("updated")),
        status=status,
        parent=str(fm["parent"]) if fm.get("parent") else None,
        sessions=_clean_pairs(fm.get("sessions"), "id", "title"),
        context=_clean_pairs(fm.get("context"), "title", "ref"),
        body=body,
        extra=extra,
    )


def render_item(item: Item) -> str:
    fm: dict = {
        "id": item.id,
        "name": item.name,
        "created": item.created,
        "updated": item.updated,
        "status": item.status,
    }
    if item.parent:
        fm["parent"] = item.parent
    fm["sessions"] = [{"id": s["id"], "title": s.get("title", "")} for s in item.sessions]
    if item.context:
        fm["context"] = [{"title": c.get("title", ""), "ref": c.get("ref", "")} for c in item.context]
    for k, v in item.extra.items():
        fm.setdefault(k, v)
    front = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True, default_flow_style=False, width=4096)
    body = item.body.strip("\n")
    return f"---\n{front}---\n" + (f"\n{body}\n" if body else "")


# --------------------------------------------------------------------------- #
# Store
# --------------------------------------------------------------------------- #

class ItemStore:
    """Filesystem-backed store. Re-reads from disk on every call: the files are
    the truth and may be edited by hand or by another tool at any time."""

    def __init__(self, items_dir: Path, clock: Callable[[], str] = now_iso):
        self.items_dir = Path(items_dir)
        self.clock = clock

    # -- areas ------------------------------------------------------------- #
    def areas(self) -> list[str]:
        if not self.items_dir.exists():
            return []
        return sorted(
            p.name for p in self.items_dir.iterdir() if p.is_dir() and not p.name.startswith((".", "_"))
        )

    def create_area(self, name: str) -> str:
        name = name.strip()
        if not name or "/" in name or name.startswith((".", "_")):
            raise ValueError("invalid area name")
        (self.items_dir / name).mkdir(parents=True, exist_ok=True)
        return name

    # -- reading ----------------------------------------------------------- #
    def list_items(self) -> list[Item]:
        items: list[Item] = []
        for area in self.areas():
            for path in sorted((self.items_dir / area).glob("*.md")):
                if path.name.startswith((".", "_")):
                    continue
                item = self.load(path)
                if item is not None:
                    items.append(item)
        return items

    def load(self, path: Path) -> Item | None:
        try:
            item = parse_item(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            return None
        if not item.id:
            return None
        item.area = path.parent.name
        item.path = path
        return item

    def get(self, item_id: str) -> Item | None:
        for item in self.list_items():
            if item.id == item_id:
                return item
        return None

    def children(self, parent_id: str, items: list[Item] | None = None) -> list[Item]:
        items = self.list_items() if items is None else items
        return [i for i in items if i.parent == parent_id]

    def descendants(self, item_id: str, items: list[Item] | None = None) -> list[Item]:
        items = self.list_items() if items is None else items
        by_parent: dict[str, list[Item]] = {}
        for i in items:
            if i.parent:
                by_parent.setdefault(i.parent, []).append(i)
        out: list[Item] = []
        stack = [item_id]
        seen = set()
        while stack:
            cur = stack.pop()
            for child in by_parent.get(cur, []):
                if child.id not in seen:
                    seen.add(child.id)
                    out.append(child)
                    stack.append(child.id)
        return out

    # -- writing ----------------------------------------------------------- #
    def create(
        self,
        name: str,
        area: str,
        status: str = DEFAULT_STATUS,
        parent: str | None = None,
        notes: str = "",
        context: list[dict] | None = None,
    ) -> Item:
        name = name.strip()
        if not name:
            raise ValueError("name is required")
        if status not in STATUSES:
            raise ValueError(f"unknown status {status!r}")
        area = self.create_area(area)
        existing = self.list_items()
        ids = {i.id for i in existing}
        item_id = new_id()
        while item_id in ids:
            item_id = new_id()
        if parent and parent not in ids:
            raise ValueError("unknown parent")
        ts = self.clock()
        item = Item(
            id=item_id,
            name=name,
            created=ts,
            updated=ts,
            status=status,
            parent=parent or None,
            context=_clean_pairs(context, "title", "ref"),
            area=area,
        )
        if notes.strip():
            item.notes = notes
        item.path = self._unique_path(area, name)
        self._write(item)
        return item

    def save(self, item: Item) -> Item:
        if item.path is None:
            raise ValueError("item has no path; use create()")
        if item.status not in STATUSES:
            raise ValueError(f"unknown status {item.status!r}")
        item.updated = self.clock()
        self._write(item)
        return item

    def move(self, item: Item, area: str) -> Item:
        area = self.create_area(area)
        if item.path is None:
            raise ValueError("item has no path")
        if item.area == area:
            return item
        new_path = self._unique_path(area, item.path.stem)
        os.replace(item.path, new_path)
        item.path = new_path
        item.area = area
        return self.save(item)

    def delete(self, item: Item) -> None:
        if item.path and item.path.exists():
            item.path.unlink()

    def attach_session(self, item: Item, session_id: str, title: str = "") -> Item:
        session_id = session_id.strip()
        if not session_id:
            raise ValueError("session id is required")
        for s in item.sessions:
            if s["id"] == session_id:
                if title:
                    s["title"] = title
                return self.save(item)
        item.sessions.append({"id": session_id, "title": title.strip()})
        return self.save(item)

    def detach_session(self, item: Item, session_id: str) -> Item:
        item.sessions = [s for s in item.sessions if s["id"] != session_id]
        return self.save(item)

    # -- internals --------------------------------------------------------- #
    def _unique_path(self, area: str, name: str) -> Path:
        base = slugify(name)
        path = self.items_dir / area / f"{base}.md"
        n = 2
        while path.exists():
            path = self.items_dir / area / f"{base}-{n}.md"
            n += 1
        return path

    def _write(self, item: Item) -> None:
        assert item.path is not None
        item.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = item.path.with_name(item.path.name + ".tmp")
        tmp.write_text(render_item(item), encoding="utf-8")
        os.replace(tmp, item.path)
