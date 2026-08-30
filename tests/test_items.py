from pathlib import Path

import pytest

from folio.items import ItemStore, get_section, parse_item, render_item, set_section, split_sections


@pytest.fixture
def store(tmp_path, clock):
    return ItemStore(tmp_path / "items", clock=clock)


def test_create_read_update_round_trip_preserves_notes_and_unknown_keys(store, clock):
    notes = "Some **notes**.\n\n```md\n## not a heading, inside a fence\n```\n\n- bullet"
    item = store.create("Better long-term ranking objective", "Ranking", notes=notes, context=[{"title": "Doc", "ref": "https://x"}])
    # hand-edit the file: add an AI state section and an unknown frontmatter key
    text = item.path.read_text()
    text = text.replace("status: idea\n", "status: idea\npriority: high\n")
    text = text.replace("## Notes", "## AI state\n\nCurrent belief: pairwise loss wins.\n\n## Notes")
    item.path.write_text(text)

    loaded = store.get(item.id)
    assert loaded.notes == notes
    assert loaded.ai_state == "Current belief: pairwise loss wins."
    assert loaded.extra == {"priority": "high"}
    assert loaded.context == [{"title": "Doc", "ref": "https://x"}]
    assert loaded.area == "Ranking"

    clock.value = "2026-08-29T11:00:00-07:00"
    loaded.status = "active"
    loaded.notes = loaded.notes + "\n\nappended line"
    store.save(loaded)

    again = store.get(item.id)
    assert again.status == "active"
    assert again.notes == notes + "\n\nappended line"
    assert again.ai_state == "Current belief: pairwise loss wins."
    assert again.extra == {"priority": "high"}
    raw = item.path.read_text()
    assert "priority: high" in raw and "## AI state" in raw and "## Notes" in raw
    assert raw.index("## AI state") < raw.index("## Notes")


def test_hand_written_spec_example_is_understood(store):
    path = store.items_dir / "Ranking" / "objective.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        "---\n"
        "id: abc12345\n"
        "name: Better long-term ranking objective\n"
        "created: 2026-08-01T09:00:00-07:00\n"
        "updated: 2026-08-02T09:00:00-07:00\n"
        "status: active\n"
        "sessions:\n"
        "  - id: 11111111-2222-3333-4444-555555555555\n"
        "    title: Survey existing approaches\n"
        "  - id: 66666666-7777-8888-9999-000000000000\n"
        "    title: Prototype alternative objective\n"
        "context:\n"
        "  - title: Ranking design notes\n"
        "    ref: notion://page\n"
        "---\n\n"
        "## AI state\n\nOne paragraph.\n\n"
        "## Notes\n\nFree-form *human* notes.\n"
    )
    item = store.get("abc12345")
    assert item.name == "Better long-term ranking objective"
    assert item.created == "2026-08-01T09:00:00-07:00"  # unquoted YAML timestamp normalised back to a string
    assert item.session_ids() == ["11111111-2222-3333-4444-555555555555", "66666666-7777-8888-9999-000000000000"]
    assert item.sessions[1]["title"] == "Prototype alternative objective"
    assert item.ai_state == "One paragraph."
    assert item.notes == "Free-form *human* notes."
    # re-render is stable and still parses identically
    assert parse_item(render_item(item)).sessions == item.sessions


def test_timestamps(store, clock):
    clock.value = "2026-08-29T10:00:00-07:00"
    item = store.create("Idea", "Inbox")
    assert item.created == item.updated == "2026-08-29T10:00:00-07:00"
    clock.value = "2026-08-29T12:34:56-07:00"
    item.name = "Renamed idea"
    store.save(item)
    reloaded = store.get(item.id)
    assert reloaded.created == "2026-08-29T10:00:00-07:00"
    assert reloaded.updated == "2026-08-29T12:34:56-07:00"


def test_parent_child_derivation(store):
    parent = store.create("Big thing", "Area")
    c1 = store.create("Part one", "Area", parent=parent.id)
    c2 = store.create("Part two", "Area", parent=parent.id)
    gc = store.create("Sub part", "Other", parent=c1.id)
    assert sorted(c.id for c in store.children(parent.id)) == sorted([c1.id, c2.id])
    assert sorted(c.id for c in store.descendants(parent.id)) == sorted([c1.id, c2.id, gc.id])
    assert f"parent: {parent.id}" in c1.path.read_text()
    assert c1.id not in parent.path.read_text()  # children are never duplicated into the parent
    with pytest.raises(ValueError):
        store.create("Orphan", "Area", parent="nope")


def test_attach_and_detach_session_persist(store):
    item = store.create("Thing", "Area")
    store.attach_session(item, "sess-aaa", "Survey")
    store.attach_session(store.get(item.id), "sess-bbb", "Prototype")
    reloaded = store.get(item.id)
    assert reloaded.sessions == [{"id": "sess-aaa", "title": "Survey"}, {"id": "sess-bbb", "title": "Prototype"}]
    store.attach_session(reloaded, "sess-aaa", "Survey (renamed)")  # re-attach updates title, no dup
    assert store.get(item.id).sessions[0] == {"id": "sess-aaa", "title": "Survey (renamed)"}
    assert len(store.get(item.id).sessions) == 2
    store.detach_session(store.get(item.id), "sess-aaa")
    assert store.get(item.id).session_ids() == ["sess-bbb"]
    assert "sess-aaa" not in item.path.read_text()


def test_slug_collision_and_move(store):
    a = store.create("Same name", "Area")
    b = store.create("Same name", "Area")
    assert a.path != b.path and a.path.exists() and b.path.exists()
    store.move(a, "Elsewhere")
    assert store.get(a.id).area == "Elsewhere"
    assert sorted(store.areas()) == ["Area", "Elsewhere"]


def test_sections():
    body = "intro\n\n## AI state\n\nstate\n\n## Notes\n\nhello\n```\n## fenced\n```\n\n## Goal\n\nheadings inside notes stay in notes\n"
    pre, secs = split_sections(body)
    assert pre.strip() == "intro"
    assert [h for h, _ in secs] == ["AI state", "Notes"]
    assert get_section(body, "notes") == "hello\n```\n## fenced\n```\n\n## Goal\n\nheadings inside notes stay in notes"
    new = set_section(body, "Notes", "replaced")
    assert get_section(new, "Notes") == "replaced" and get_section(new, "AI state") == "state"
    assert "## Goal" not in new  # the heading belonged to the notes content that was replaced
    # notes that *start* with a heading round-trip intact
    started = set_section("", "Notes", "## Goal\n\ntext")
    assert get_section(started, "Notes") == "## Goal\n\ntext"
    assert new.startswith("intro\n")
    assert get_section(set_section("", "Notes", "x"), "Notes") == "x"


def test_status_validation(store):
    with pytest.raises(ValueError):
        store.create("Bad", "Area", status="blocked")
