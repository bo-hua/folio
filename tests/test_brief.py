"""The brief: one card as a block to paste into a prompt.

Pure formatting over Items and session views -- no server, no filesystem."""
from pathlib import Path

from folio.brief import NO_NOTES, ancestors, render_brief, tilde
from folio.items import Item

HOME = Path("/Users/me")


def item(id, name, area="Ranking", parent=None, notes="", status="idea", **kw) -> Item:
    it = Item(id=id, name=name, created="2026-08-29T10:00:00-07:00", updated="2026-08-29T10:00:00-07:00",
              status=status, parent=parent, area=area, path=HOME / ".cc-workspace" / "items" / area / f"{name}.md", **kw)
    if notes:
        it.notes = notes
    return it


def session(**kw) -> dict:
    base = {"id": "1f3a9c2e-7b41-4d6e-9a0f-1b2c3d4e5f60", "short_id": "1f3a9c2e", "title": "", "auto_title": "",
            "last_prompt": "", "state": "unknown", "attention": None, "branch": None, "cwd": None}
    return {**base, **kw}


def test_tilde_folds_home_and_leaves_the_rest_alone():
    assert tilde("/Users/me/code/x", HOME) == "~/code/x"
    assert tilde("/Users/me", HOME) == "~"
    assert tilde("/Users/melissa/code", HOME) == "/Users/melissa/code"  # a prefix, not the home dir
    assert tilde("/srv/repo", HOME) == "/srv/repo"
    assert tilde(None, HOME) == ""


def test_the_block_carries_name_id_file_notes_and_where_it_sits():
    root = item("r1", "Better ranking", notes="the goal: a longer-term objective")
    mid = item("m1", "Bigger features", parent="r1")            # no notes: named in the path, no section
    leaf = item("l1", "Prototype", parent="m1", notes="- try the discounted variant\n- compare offline")
    items = [root, mid, leaf]
    text = render_brief(leaf, items, [], {"r1": "active", "m1": "active", "l1": "idea"}, home=HOME)
    lines = text.splitlines()
    assert lines[0] == "folio card “Prototype”"
    assert lines[1] == "id: l1 · status: idea · in: Ranking › Better ranking › Bigger features"
    assert lines[2] == "file: ~/.cc-workspace/items/Ranking/Prototype.md"
    assert "## Notes\n- try the discounted variant\n- compare offline\n" in text
    # the ancestors nearest-first; the one with nothing to say is skipped, the root's notes come along
    assert "## Parent: Bigger features" not in text
    assert "## Parent of “Bigger features”: Better ranking (active)\nthe goal: a longer-term objective" in text
    assert text.endswith("\n") and "\n\n\n" not in text
    assert [a.id for a in ancestors(leaf, {i.id: i for i in items})] == ["m1", "r1"]


def test_never_starts_with_a_character_claude_code_treats_as_a_command():
    """Pasted alone, a leading `#` is a memory note, `/` a slash command, `!` a shell line."""
    for name in ("#hashtag idea", "/slash", "!bang", "plain"):
        text = render_brief(item("x", name), [item("x", name)], [], {}, home=HOME)
        assert text[0] not in "#/!", text[:20]


def test_empty_notes_say_so_and_empty_sections_are_left_out():
    card = item("c", "Bare")
    text = render_brief(card, [card], [], {"c": "idea"}, home=HOME)
    assert f"## Notes\n{NO_NOTES}\n" in text
    for heading in ("## Sessions", "## Children", "## Context", "## AI state", "## Parent"):
        assert heading not in text


def test_sessions_children_context_and_ai_state_each_get_a_section():
    card = item("c", "Feature", status="parked", park_note="after the numbers",
                context=[{"title": "Design doc", "ref": "https://example.com/doc"}, {"title": "", "ref": "~/notes.md"}])
    card.ai_state = "Prototype runs; eval pending."
    kid_a = item("k1", "Sub-task", parent="c")
    grandkid = item("g1", "Detail", parent="k1")
    kid_b = item("k2", "Other sub-task", parent="c")
    items = [card, kid_a, grandkid, kid_b]
    sessions = [
        session(title="Prototype run", state="needs_you", attention="permission", branch="feature", cwd="/Users/me/code/repo-feature",
                last_prompt="try the discounted variant"),
        session(id="2a7d5e1b-3c9f-4a8e-b2d1-6e7f8a9b0c1d", short_id="2a7d5e1b", auto_title="ranking survey", state="ended"),
        session(id="3333", short_id="3333"),
    ]
    text = render_brief(card, items, sessions, {"c": "parked", "k1": "active", "g1": "done", "k2": "idea"}, home=HOME)
    assert "id: c · status: parked — after the numbers · in: Ranking\n" in text
    assert "## AI state\nPrototype runs; eval pending.\n" in text
    assert "## Context\n- Design doc: https://example.com/doc\n- ~/notes.md\n" in text
    assert ("## Sessions\n"
            "- “Prototype run” (1f3a9c2e-7b41-4d6e-9a0f-1b2c3d4e5f60) — needs you, permission · branch feature · ~/code/repo-feature\n"
            "  last prompt: try the discounted variant\n"
            "- “ranking survey” (2a7d5e1b-3c9f-4a8e-b2d1-6e7f8a9b0c1d) — ended\n"
            "- “Untitled session” (3333) — no runtime info\n") in text
    assert "## Children\n- Sub-task — active (1 inside)\n- Other sub-task — idea\n" in text
    # the block ends with the last section, no trailing blank lines
    assert text.endswith("- Other sub-task — idea\n")


def test_ancestor_sections_carry_their_links_and_ai_state_too():
    root = item("r", "Goal", context=[{"title": "Spec", "ref": "https://example.com/spec"}])
    root.ai_state = "Two of three prototypes done."
    leaf = item("l", "Leaf", parent="r", notes="x")
    text = render_brief(leaf, [root, leaf], [], {"r": "active", "l": "idea"}, home=HOME)
    assert "## Parent: Goal (active)\nAI state:\nTwo of three prototypes done.\n\nContext:\n- Spec: https://example.com/spec\n" in text


def test_a_parent_cycle_or_dangling_parent_ends_the_chain_quietly():
    a = item("a", "A", parent="b")
    b = item("b", "B", parent="a")
    text = render_brief(a, [a, b], [], {}, home=HOME)
    assert "in: Ranking › B\n" in text
    orphan = item("o", "Orphan", parent="gone")
    assert "in: Ranking\n" in render_brief(orphan, [orphan], [], {}, home=HOME)
