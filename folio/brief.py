"""One card as a block of text to paste into a Claude prompt.

"Work on this feature (…)" needs more than a name. The brief carries what a
person would otherwise re-type: the notes, the cards above it (their notes too),
the cards inside it, which sessions have already touched it, and where the
Markdown file lives so the reader can go further on its own. Everything comes
from the same snapshot the board renders; nothing here is stored.

The text is Markdown-flavoured but deliberately does not begin with `#`, `/` or
`!` -- pasted alone into Claude Code, those first characters are a memory note,
a slash command and a shell command respectively.
"""
from __future__ import annotations

from pathlib import Path

from .items import Item

# Runtime states read as labels; anything not listed is already a word.
STATE_LABEL = {"needs_you": "needs you", "unknown": "no runtime info"}
NO_NOTES = "(no notes yet)"


def tilde(path: str | Path | None, home: Path | None = None) -> str:
    """`/Users/you/x` -> `~/x`, so the block reads the same on every machine."""
    if not path:
        return ""
    text, root = str(path), str(home or Path.home())
    if text == root or text.startswith(root.rstrip("/") + "/"):
        return "~" + text[len(root.rstrip("/")):]
    return text


def ancestors(item: Item, by_id: dict[str, Item]) -> list[Item]:
    """Parent, grandparent, ... nearest first. A cycle or a dangling id ends the walk."""
    out: list[Item] = []
    seen = {item.id}
    cur = item
    while cur.parent and cur.parent in by_id and cur.parent not in seen:
        cur = by_id[cur.parent]
        seen.add(cur.id)
        out.append(cur)
    return out


def _descendant_count(item_id: str, by_parent: dict[str, list[Item]]) -> int:
    n, stack, seen = 0, [item_id], set()
    while stack:
        for child in by_parent.get(stack.pop(), []):
            if child.id not in seen:
                seen.add(child.id)
                n += 1
                stack.append(child.id)
    return n


def _context_lines(context: list[dict]) -> list[str]:
    lines = []
    for c in context:
        title, ref = (c.get("title") or "").strip(), (c.get("ref") or "").strip()
        lines.append(f"- {title}: {ref}" if title and title != ref else f"- {ref or title}")
    return lines


def _session_lines(sessions: list[dict], home: Path | None) -> list[str]:
    lines = []
    for s in sessions:
        title = s.get("title") or s.get("auto_title") or "Untitled session"
        state = STATE_LABEL.get(s.get("state") or "unknown", s.get("state") or "unknown")
        bits = [state + (f", {s['attention']}" if s.get("attention") else "")]
        if s.get("branch"):
            bits.append(f"branch {s['branch']}")
        if s.get("cwd"):
            bits.append(tilde(s["cwd"], home))
        lines.append(f"- “{title}” ({s['id']}) — {' · '.join(bits)}")
        if s.get("last_prompt"):
            lines.append(f"  last prompt: {s['last_prompt']}")
    return lines


def _about(item: Item, home: Path | None) -> list[str]:
    """The body an ancestor contributes: its notes, AI state and links -- or nothing."""
    out: list[str] = []
    notes = item.notes.strip()
    if notes:
        out.append(notes)
    if item.ai_state and item.ai_state.strip():
        out += ["", "AI state:", item.ai_state.strip()] if out else ["AI state:", item.ai_state.strip()]
    if item.context:
        out += ["", "Context:", *_context_lines(item.context)] if out else ["Context:", *_context_lines(item.context)]
    return out


def render_brief(
    item: Item,
    items: list[Item],
    sessions: list[dict],
    lifecycles: dict[str, str],
    home: Path | None = None,
) -> str:
    """The block. `sessions` are the API's session views for `item`; `lifecycles`
    is id -> idea/active/done/parked as the board derives them."""
    by_id = {i.id: i for i in items}
    by_parent: dict[str, list[Item]] = {}
    for i in items:
        if i.parent:
            by_parent.setdefault(i.parent, []).append(i)
    lc = lambda i: lifecycles.get(i.id) or i.status  # noqa: E731

    chain = ancestors(item, by_id)
    where = " › ".join([item.area, *[a.name for a in reversed(chain)]])
    status = lc(item)
    if status == "parked" and item.effective_park_note:
        status += f" — {item.effective_park_note}"
    out = [f"folio card “{item.name}”", f"id: {item.id} · status: {status} · in: {where}"]
    if item.path:
        out.append(f"file: {tilde(item.path, home)}")

    out += ["", "## Notes", item.notes.strip() or NO_NOTES]
    if item.ai_state and item.ai_state.strip():
        out += ["", "## AI state", item.ai_state.strip()]
    if item.context:
        out += ["", "## Context", *_context_lines(item.context)]
    if sessions:
        out += ["", "## Sessions", *_session_lines(sessions, home)]
    kids = by_parent.get(item.id, [])
    if kids:
        out += ["", "## Children"]
        for k in kids:
            n = _descendant_count(k.id, by_parent)
            out.append(f"- {k.name} — {lc(k)}" + (f" ({n} inside)" if n else ""))
    for depth, anc in enumerate(chain):
        body = _about(anc, home)
        if not body:
            continue  # its name is already in the `in:` line; nothing more to say
        label = "Parent" if depth == 0 else f"Parent of “{chain[depth - 1].name}”"
        out += ["", f"## {label}: {anc.name} ({lc(anc)})", *body]
    return "\n".join(out).rstrip("\n") + "\n"
