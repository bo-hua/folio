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
    loaded.status = "done"  # a human state sticks; open items are re-derived on save (see test_canvas_model)
    loaded.notes = loaded.notes + "\n\nappended line"
    store.save(loaded)

    again = store.get(item.id)
    assert again.status == "done" and again.human_status == "done"
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


def test_delete_area_cascades_and_detaches_cross_area_children(store):
    parent = store.create("Big thing", "Ranking")
    child = store.create("Part one", "Ranking", parent=parent.id)
    cousin = store.create("Lives elsewhere", "Other", parent=child.id)
    unrelated = store.create("Unrelated", "Other")
    (store.items_dir / "Ranking" / ".DS_Store").write_bytes(b"")  # stray files never block deletion

    gone, detached = store.delete_area("Ranking")
    assert sorted(i.id for i in gone) == sorted([parent.id, child.id])
    assert [i.id for i in detached] == [cousin.id]
    assert not (store.items_dir / "Ranking").exists()
    assert store.areas() == ["Other"]
    assert store.get(parent.id) is None and store.get(child.id) is None
    # the cross-area grandchild survives as a top-level item; nothing points at a dead id
    assert store.get(cousin.id).parent is None
    assert "parent:" not in cousin.path.read_text()
    assert store.get(unrelated.id).parent is None and "Unrelated" in unrelated.path.read_text()

    with pytest.raises(LookupError):
        store.delete_area("Ranking")
    for bad in ("", "../Other", ".hidden", "_private"):
        with pytest.raises(ValueError):
            store.delete_area(bad)
    assert store.areas() == ["Other"]


def test_rename_moves_the_file_and_leaves_nothing_behind(store):
    item = store.create("Untitled idea", "Area")
    assert item.path.name == "untitled-idea.md"

    item.name = "Handle the default next session better"
    store.save(item)

    assert item.path.name == "handle-the-default-next-session-better.md"
    assert item.path.exists()
    assert sorted(p.name for p in (store.items_dir / "Area").glob("*.md")) == [
        "handle-the-default-next-session-better.md"
    ]
    assert store.get(item.id).name == "Handle the default next session better"


def test_saves_that_do_not_rename_leave_the_filename_alone(store):
    first = store.create("Same name", "Area")
    second = store.create("Same name", "Area")
    assert second.path.name == "same-name-2.md"  # a legitimate collision suffix

    store.attach_session(second, "sess-1")  # unrelated save
    store.save(second)
    assert second.path.name == "same-name-2.md"
    assert first.path.exists()


def test_retitle_files_repairs_names_that_drifted_before_the_fix(store):
    item = store.create("Untitled idea", "Area")
    # simulate the old bug: the name changes, the file does not
    item.path.write_text(item.path.read_text().replace("name: Untitled idea", "name: Rework the UI"))
    assert item.path.name == "untitled-idea.md"

    moved = store.retitle_files()
    assert [(o.name, n.name) for o, n in moved] == [("untitled-idea.md", "rework-the-ui.md")]
    assert not item.path.exists()
    assert (store.items_dir / "Area" / "rework-the-ui.md").exists()
    assert store.retitle_files() == []  # idempotent
