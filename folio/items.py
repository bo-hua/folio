"""Markdown work items: the durable source of truth.

Layout (inside the data dir):

    items/<Area>/<Item name>.md

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
import shutil
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Iterable

import yaml

# `status` semantics: only `done` and `parked` are chosen by a human. Anything else
# means "open" -- the UI derives idea/active from what is attached, and save()
# re-snapshots that derivation into the file so hand readers still see something
# truthful. `waiting` is legacy and is read as parked with the note "waiting".
STATUSES = ("idea", "active", "waiting", "done", "parked")
HUMAN_STATUSES = ("done", "parked")
DEFAULT_STATUS = "idea"
KNOWN_KEYS = ("id", "name", "created", "updated", "status", "parent", "order", "park_note", "sessions", "context")
_UNORDERED = 10**9  # items without an `order` sort after ordered siblings, by creation time
_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
_FENCE_RE = re.compile(r"^(```|~~~)")
_H2_RE = re.compile(r"^## +(.+?)\s*$")
KNOWN_SECTIONS = ("ai state", "notes")


def now_iso() -> str:
    return datetime.now().astimezone().replace(microsecond=0).isoformat()


def new_id() -> str:
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(8))


# Filenames are read by people -- in `ls`, and in a Markdown editor pointed at
# the data dir -- so an item's file is called what the item is called. These are
# the only characters that cannot survive: `/` and NUL are illegal everywhere,
# the rest are illegal on Windows/SMB or break Obsidian's filename rules and its
# `[[wikilinks]]`. A `:` becomes ` - ` because titles use it as a separator and
# "Foo - bar" reads better than "Foo bar".
_UNSAFE_RE = re.compile(r'[\\/<>"|?*\[\]#^\x00-\x1f]')
# Long enough that a real paper title survives whole; a path component holds 255
# bytes, so both caps leave room for ".md" and a "-2" suffix.
_NAME_MAX_CHARS = 120
_NAME_MAX_BYTES = 200


def filename_stem(name: str) -> str:
    """The filename, without `.md`, for an item called `name`.

    Keeps the name itself -- case, spaces, punctuation -- rather than reducing it
    to a URL-style slug. Nothing looks an item up by path (`id` lives in the
    frontmatter), so the filename's only job is to be legible to whoever is
    reading the directory.
    """
    stem = re.sub(r"\s*:+\s*", " - ", name)
    stem = _UNSAFE_RE.sub(" ", stem)
    # A leading "." or "_" would hide the file from list_items(); a trailing "."
    # or " " is illegal on Windows and quietly dropped by some SMB shares.
    stem = re.sub(r"\s+", " ", stem).strip(" ._-")
    if len(stem) > _NAME_MAX_CHARS or len(stem.encode("utf-8")) > _NAME_MAX_BYTES:
        cut = stem[:_NAME_MAX_CHARS]
        while len(cut.encode("utf-8")) > _NAME_MAX_BYTES:
            cut = cut[:-1]
        head, _, _ = cut.rpartition(" ")  # trim at a word boundary, when the name has one
        stem = (head or cut).rstrip(" .-")
    return stem or "item"


# --------------------------------------------------------------------------- #
# Body sections
# --------------------------------------------------------------------------- #

def split_sections(body: str) -> tuple[str, list[tuple[str, str]]]:
    """Split a Markdown body into (preamble, [(h2 heading, content), ...]).

    Only the *known* section headings (`## AI state`, `## Notes`) outside fenced
    code blocks start a section; any other `## ...` heading is ordinary content
    (people use headings inside their notes). Content is kept raw so that
    re-joining is lossless apart from section-boundary blank lines.
    """
    preamble_lines: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    in_fence = False
    for line in body.split("\n"):
        if _FENCE_RE.match(line):
            in_fence = not in_fence
        m = None if in_fence else _H2_RE.match(line)
        if m and m.group(1).strip().lower() not in KNOWN_SECTIONS:
            m = None
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
    order: int | None = None  # position among siblings; assigned by ItemStore.move_item
    park_note: str = ""  # why / until when, shown while parked
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

    @property
    def human_status(self) -> str | None:
        """`done` / `parked` when a person set it; None while the item is open."""
        if self.status in HUMAN_STATUSES:
            return self.status
        return "parked" if self.status == "waiting" else None

    @property
    def effective_park_note(self) -> str:
        if self.park_note:
            return self.park_note
        return "waiting" if self.status == "waiting" else ""

    def sort_key(self) -> tuple:
        return (self.order if self.order is not None else _UNORDERED, self.created, self.name)


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
    order = fm.get("order")
    try:
        order = int(order) if order is not None and not isinstance(order, bool) else None
    except (TypeError, ValueError):
        order = None
    return Item(
        id=str(fm.get("id") or ""),
        name=str(fm.get("name") or ""),
        created=_str_ts(fm.get("created")),
        updated=_str_ts(fm.get("updated")),
        status=status,
        parent=str(fm["parent"]) if fm.get("parent") else None,
        order=order,
        park_note=str(fm.get("park_note") or ""),
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
    if item.order is not None:
        fm["order"] = item.order
    if item.park_note:
        fm["park_note"] = item.park_note
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
        name = self._check_area_name(name)
        (self.items_dir / name).mkdir(parents=True, exist_ok=True)
        return name

    def delete_area(self, name: str) -> tuple[list[Item], list[Item]]:
        """Remove an Area directory together with every item in it.

        Items in *other* areas whose parent lived here are kept but detached
        (their `parent` is cleared) so no file is left pointing at an id that
        no longer exists. Returns (deleted items, detached items).
        """
        name = self._check_area_name(name)
        path = self.items_dir / name
        if not path.is_dir():
            raise LookupError(f"unknown area {name!r}")
        items = self.list_items()
        gone = [i for i in items if i.area == name]
        gone_ids = {i.id for i in gone}
        shutil.rmtree(path)
        detached: list[Item] = []
        for other in items:
            if other.area != name and other.parent in gone_ids:
                other.parent = None
                detached.append(self.save(other))
        return gone, detached

    @staticmethod
    def _check_area_name(name: str) -> str:
        name = name.strip()
        if not name or "/" in name or name.startswith((".", "_")):
            raise ValueError("invalid area name")
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
        items.sort(key=Item.sort_key)  # sibling order is `order`, then creation time
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

    def siblings(self, parent: str | None, area: str, items: list[Item]) -> list[Item]:
        """Items that share a container: a parent, or the top level of an Area."""
        if parent:
            return [i for i in items if i.parent == parent]
        return [i for i in items if not i.parent and i.area == area]

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
        if item.human_status is None:
            item.status = "idea"  # open items start as ideas; save() re-derives once sessions arrive
        item.path = self._unique_path(area, name)
        self._write(item)
        return item

    def save(self, item: Item) -> Item:
        if item.path is None:
            raise ValueError("item has no path; use create()")
        if item.status not in STATUSES:
            raise ValueError(f"unknown status {item.status!r}")
        if item.human_status is None:
            item.status = "active" if item.sessions else "idea"  # open: snapshot the derivation
        item.updated = self.clock()
        self._sync_filename(item)
        self._write(item)
        return item

    def set_human_status(self, item: Item, status: str | None, park_note: str | None = None) -> Item:
        """`done`, `parked` (optionally with a note) or None/"open" to hand the item back to derivation."""
        if status in (None, "", "open", "idea", "active"):
            item.status = "idea"
            item.park_note = ""
        elif status == "waiting":  # legacy spelling
            item.status = "parked"
            item.park_note = (park_note or "waiting").strip()
        elif status in HUMAN_STATUSES:
            item.status = status
            item.park_note = (park_note or "").strip() if status == "parked" else ""
        else:
            raise ValueError("status must be done, parked or open")
        return self.save(item)

    def _relocate(self, item: Item, area: str) -> None:
        """Move the file into another Area directory without saving."""
        area = self.create_area(area)
        if item.path is None:
            raise ValueError("item has no path")
        if item.area == area:
            return
        new_path = self._unique_path(area, item.path.stem)
        os.replace(item.path, new_path)
        item.path = new_path
        item.area = area

    def move(self, item: Item, area: str) -> Item:
        if item.area == self._check_area_name(area):
            return item
        self._relocate(item, area)
        return self.save(item)

    def move_item(
        self,
        item: Item,
        *,
        parent: str | None = None,
        area: str | None = None,
        before: str | None = None,
        after: str | None = None,
    ) -> Item:
        """Change the one thing the canvas edits: where an item sits in the tree.

        `parent` (or None for the top level of `area`, defaulting to the item's
        own Area), optionally placed `before`/`after` a sibling; otherwise last.
        The file moves into the container's Area directory and every sibling's
        `order` is renumbered 0..n-1 (only files whose order changed are written).
        """
        items = self.list_items()
        by_id = {i.id: i for i in items}
        if parent:
            if parent == item.id or parent not in by_id:
                raise ValueError("invalid parent")
            if parent in {d.id for d in self.descendants(item.id, items)}:
                raise ValueError("parent would create a cycle")
            target_area = by_id[parent].area
        else:
            target_area = self._check_area_name(area) if area else item.area
        item.parent = parent or None
        self._relocate(item, target_area)
        sibs = [i for i in self.siblings(item.parent, target_area, items) if i.id != item.id]
        pos = len(sibs)
        anchor = before or after
        if anchor:
            for idx, sib in enumerate(sibs):
                if sib.id == anchor:
                    pos = idx if before else idx + 1
                    break
        sibs.insert(pos, item)
        saved_self = False
        for n, sib in enumerate(sibs):
            if sib.order != n or sib is item:
                sib.order = n
                self.save(sib)
                saved_self = saved_self or sib is item
        if not saved_self:
            self.save(item)
        return item

    def delete(self, item: Item) -> None:
        if item.path and item.path.exists():
            item.path.unlink()

    def delete_tree(self, item: Item, items: list[Item] | None = None) -> list[Item]:
        """Delete an item together with every descendant (the UI confirms first)."""
        items = self.list_items() if items is None else items
        gone = [item, *self.descendants(item.id, items)]
        for it in gone:
            self.delete(it)
        return gone

    def detach_session_everywhere(self, session_id: str, items: list[Item] | None = None, except_id: str | None = None) -> list[Item]:
        """A session belongs to at most one item: remove it from every other one."""
        items = self.list_items() if items is None else items
        changed = []
        for it in items:
            if it.id != except_id and session_id in it.session_ids():
                changed.append(self.detach_session(it, session_id))
        return changed

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
    def _unique_path(self, area: str, name: str, ignore: Path | None = None) -> Path:
        """A free path for `name` in `area`. `ignore` is the file being renamed.

        On a case-insensitive filesystem the item's own file answers `exists()`
        for a case-only rename ("foo" -> "Foo"), so without `ignore` that rename
        would land on `Foo-2.md`.
        """
        base = filename_stem(name)
        path = self.items_dir / area / f"{base}.md"
        n = 2
        while path.exists() and not (ignore is not None and ignore.exists() and path.samefile(ignore)):
            path = self.items_dir / area / f"{base}-{n}.md"
            n += 1
        return path

    def planned_path(self, item: Item) -> Path | None:
        """Where `item`'s file belongs, or None when its filename already fits.

        Filenames are derived from the name, but for a long while only
        `create()` ever did the deriving -- so renaming a card left the file
        behind under its old name. The canvas creates every card as "Untitled
        idea" and renames it a second later, which is how a directory ends up
        full of `Untitled idea-7.md` files whose contents are something else
        entirely.
        """
        if item.path is None or not item.path.exists():
            return None
        desired = filename_stem(item.name)
        stem = item.path.stem
        # `Foo-2.md` is the legitimate name for a second item called "Foo": leave it.
        if stem == desired or re.fullmatch(rf"{re.escape(desired)}-\d+", stem):
            return None
        return self._unique_path(item.area, item.name, ignore=item.path)

    def _sync_filename(self, item: Item) -> None:
        """Restore the `items/<Area>/<Item name>.md` invariant after a rename."""
        new_path = self.planned_path(item)
        if new_path is None:
            return
        assert item.path is not None
        os.replace(item.path, new_path)
        item.path = new_path

    def retitle_files(self) -> list[tuple[Path, Path]]:
        """Rename every file whose filename has drifted from its item's name.

        Repairs items written before `save()` kept the two in step. Returns the
        (old, new) pairs actually moved; ids live in the frontmatter, so nothing
        outside the store refers to these paths.
        """
        moved: list[tuple[Path, Path]] = []
        for item in self.list_items():
            before = item.path
            self._sync_filename(item)
            if item.path != before:
                moved.append((before, item.path))
        return moved

    def _write(self, item: Item) -> None:
        assert item.path is not None
        item.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = item.path.with_name(item.path.name + ".tmp")
        tmp.write_text(render_item(item), encoding="utf-8")
        os.replace(tmp, item.path)
