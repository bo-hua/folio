"""`folio hook` attaches the session to the card whose brief the prompt carries."""
import json
import os
import subprocess
import sys

from folio import hook
from folio.brief import card_id_in_text, render_brief
from folio.items import ItemStore

SID = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b"
HEADER = (
    "folio card “Fix the thing”\n"
    "id: k7m2p9xw · status: idea · in: Folio › Polish and small fixes\n"
    "file: ~/.cc-workspace/items/Folio/fix-the-thing.md\n"
    "\n## Notes\n(no notes yet)\n"
)


def prompt_event(prompt, sid=SID, **extra):
    ev = {"session_id": sid, "hook_event_name": "UserPromptSubmit", "prompt": prompt, "cwd": "/repo",
          "permission_mode": "default", "transcript_path": "/home/u/.claude/projects/x/y.jsonl"}
    ev.update(extra)
    return ev


def brief_of(store, item):
    return render_brief(item, store.list_items(), [], {})


def test_card_id_in_text_recognises_only_the_brief_header():
    assert card_id_in_text(HEADER) == "k7m2p9xw"
    assert card_id_in_text("work on task - " + HEADER) == "k7m2p9xw"  # the usual prefix
    assert card_id_in_text("carefully please:\n\n" + HEADER + "\nthanks") == "k7m2p9xw"
    assert card_id_in_text("> " + HEADER.replace("\n", "\n> ")) == "k7m2p9xw"  # quoted paste
    assert card_id_in_text("    " + HEADER.replace("\n", "\n    ")) == "k7m2p9xw"  # indented paste
    # first brief wins when two are pasted
    assert card_id_in_text(HEADER + "\n" + HEADER.replace("k7m2p9xw", "zzzzzzzz")) == "k7m2p9xw"
    # merely talking about a card is not pasting its brief
    assert card_id_in_text("look at card k7m2p9xw and tell me its status: idea") is None
    assert card_id_in_text("id: k7m2p9xw") is None
    assert card_id_in_text("the id: k7m2p9xw · status: idea line") is None
    assert card_id_in_text("") is None
    assert card_id_in_text(None) is None


def test_rendered_brief_round_trips(tmp_path):
    store = ItemStore(tmp_path / "items")
    item = store.create("Fix the thing", "Folio")
    assert card_id_in_text("work on task - " + brief_of(store, item)) == item.id


def test_prompt_with_brief_attaches_session_and_stores_no_prompt(tmp_path):
    store = ItemStore(tmp_path / "items")
    item = store.create("Fix the thing", "Folio")
    assert item.status == "idea"
    hook.run(json.dumps(prompt_event("work on task - " + brief_of(store, item) + "\nSECRET DETAIL")), tmp_path)
    got = store.get(item.id)
    assert got.session_ids() == [SID]
    assert got.status == "active"  # a session on it: no longer just an idea
    # the prompt itself never lands anywhere in the data dir
    for p in tmp_path.rglob("*"):
        if p.is_file():
            assert "SECRET DETAIL" not in p.read_text(encoding="utf-8"), p
    # the runtime record is still written as before
    rec = json.loads((tmp_path / "runtime" / "sessions" / f"{SID}.json").read_text())
    assert rec["state"] == "working"


def test_attach_is_idempotent_and_never_moves_a_session(tmp_path):
    store = ItemStore(tmp_path / "items")
    a = store.create("A", "Folio")
    b = store.create("B", "Folio")
    ev = json.dumps(prompt_event("work on task - " + brief_of(store, a)))
    hook.run(ev, tmp_path)
    assert store.get(a.id).session_ids() == [SID]
    mtime = os.stat(store.get(a.id).path).st_mtime_ns
    hook.run(ev, tmp_path)  # the same brief again: nothing rewritten
    assert store.get(a.id).session_ids() == [SID]
    assert os.stat(store.get(a.id).path).st_mtime_ns == mtime
    # B's brief pasted into a session that already belongs to A: A keeps it
    hook.run(json.dumps(prompt_event("compare with this one:\n" + brief_of(store, b))), tmp_path)
    assert store.get(a.id).session_ids() == [SID]
    assert store.get(b.id).session_ids() == []
    # a different, unattached session pasting B's brief lands on B
    hook.run(json.dumps(prompt_event(brief_of(store, b), sid="second-session")), tmp_path)
    assert store.get(b.id).session_ids() == ["second-session"]
    assert store.get(a.id).session_ids() == [SID]


def test_attach_ignores_other_events_unknown_cards_and_subagents(tmp_path):
    store = ItemStore(tmp_path / "items")
    item = store.create("A", "Folio")
    brief = brief_of(store, item)
    hook.run(json.dumps(prompt_event(brief, agent_id="sub1")), tmp_path)  # a subagent's prompt is not yours
    hook.run(json.dumps(prompt_event(brief, hook_event_name="PreToolUse")), tmp_path)  # only a submitted prompt
    hook.run(json.dumps(prompt_event(brief.replace(item.id, "nosuchid"))), tmp_path)  # unknown card
    hook.run(json.dumps(prompt_event("work on the thing")), tmp_path)  # no brief at all
    hook.run(json.dumps(prompt_event(["not", "a", "string"])), tmp_path)  # odd payloads never fail
    hook.run(json.dumps(prompt_event(brief, session_id="../escape")), tmp_path)  # unsafe id
    assert store.get(item.id).session_ids() == []
    hook.run(json.dumps(prompt_event(brief)), tmp_path)  # sanity: the same brief, the plain way, does attach
    assert store.get(item.id).session_ids() == [SID]


def test_hook_subprocess_attaches_and_prints_nothing(tmp_path):
    store = ItemStore(tmp_path / "items")
    item = store.create("A", "Folio")
    proc = subprocess.run(
        [sys.executable, "-m", "folio.cli", "hook", "--data-dir", str(tmp_path)],
        input=json.dumps(prompt_event("work on task - " + brief_of(store, item))),
        capture_output=True, text=True, timeout=60, check=False,
    )
    assert proc.returncode == 0 and proc.stdout == ""  # still silent: cannot influence Claude
    assert store.get(item.id).session_ids() == [SID]
    assert store.get(item.id).status == "active"
