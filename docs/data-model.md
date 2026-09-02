# Data model

```
Area  (a directory)
  └── Item  (one Markdown file: name, status, notes, context refs …)
        ├── optional child Items      (child stores `parent: <id>`; derived, never duplicated)
        └── 0..N Claude Code sessions (ids + human titles; live state joined at runtime)
```

| | what it is | where it lives |
|---|---|---|
| **Area** | a bucket — a project, a theme, an `Inbox` | a directory under `items/` |
| **Item** | one piece of work; the durable unit | one `.md` file with YAML frontmatter |
| **Child item** | a sub-problem or spin-off | an Item whose frontmatter has `parent: <id>` |
| **Session** | a Claude Code session attached to an Item | an id + title in the Item's frontmatter |
| **Status** | *derived* idea / active, or the two states a person sets: done / parked (+ optional `park_note`) | frontmatter `status:` |
| **Runtime state** | *machine* state: working / needs you / ready / ended / inactive | derived from the hook, never written to Markdown |

Status and runtime state are shown side by side and **never merged** — "I consider
this parked" and "a session on it is asking for permission" are different facts.

**Markdown is the source of truth.** Edit an item in your editor while folio is
running; folio re-reads on every request. The UI rewrites only the section it owns
and preserves unknown frontmatter keys.

## Where your data lives

All of it sits outside this repo, under `~/.cc-workspace` by default
(`--data-dir PATH` or `FOLIO_DATA_DIR=PATH` to move it):

```
~/.cc-workspace/
  config.toml                 repo = "/path/to/repo", bind = "127.0.0.1:4317"
  items/
    Ranking/                  <- an Area is just a directory
      better-long-term-objective.md
      prototype-alt-objective.md   (parent: <id of the file above>)
    Inbox/
      some-raw-idea.md
  runtime/
    sessions/<session-id>.json   ephemeral Claude state written by the hook (safe to delete)
    hook-errors.log              only present if the hook ever hit an exception
```

Back up `items/`; `runtime/` is disposable.

## Filenames follow card names

The file is called what the card is called — `Clarify card status.md`, spaces and
capitals intact — and follows it: rename a card and the file is renamed with it, so
the directory reads like the card list in any Markdown editor.

Only the characters a filesystem or Obsidian refuses are replaced (`:` becomes
` - `, and `/ \ < > " | ? * [ ] # ^` become spaces), and a very long name is trimmed
at a word boundary.

Only `id` identifies an item, so a filename is safe to change by hand. `folio tidy`
puts any that have drifted back in step (`--dry-run` first to see the moves).

## Item file

```markdown
---
id: k7m2p9xw                       # stable, opaque; the filename carries no meaning
name: Better long-term ranking objective
created: '2026-08-29T18:30:00-07:00'
updated: '2026-08-29T19:02:11-07:00'
status: active                     # done | parked are yours; idea | active are derived and re-snapshotted on save
order: 2                           # position among siblings (assigned when you drag; absent = by created)
park_note: after prototype numbers # optional, shown while parked (legacy `waiting` reads as parked)
parent: 3fq8ztra                   # optional
sessions:
- id: 1f3a9c2e-7b41-4d6e-9a0f-1b2c3d4e5f60
  title: Survey existing approaches
- id: 2a7d5e1b-3c9f-4a8e-b2d1-6e7f8a9b0c1d
  title: Prototype alternative objective
context:
- title: Ranking design notes
  ref: https://notion.so/...
---

## AI state

Optional one-paragraph current-state summary (displayed; not auto-generated in the MVP).

## Notes

Free-form human Markdown. The UI edits exactly this section and leaves
everything else in the file untouched. Unknown frontmatter keys are preserved.
```

Children, worktrees, branches and live Claude state are **never** written into the
Markdown; they are derived when the page renders.

## A day with folio

1. **Capture.** An idea arrives mid-morning. Type it into "Quick idea in Ranking"
   and press Enter — one keystroke, a card exists, you move on.
2. **Start.** Open it, start a Claude session in a worktree the usual way, then
   **Attach Claude session** and give it a title ("Survey existing approaches").
3. **Fan out.** The survey suggests a prototype. Add it as a **child**, attach the
   forked session to the child. The parent card shows both.
4. **Triage.** Two hours later, five sessions are running. Instead of cycling
   terminal tabs, look at the board: *needs you · permission* on one card, *working*
   on two, the rest quiet. Handle the one that is actually blocked.
5. **Come back.** Next morning the card tells you where things stood — notes,
   attached sessions with their last update, worktree, and branch, and the exact
   command to get back into each.
6. **Close out.** **Mark done.** It stops competing for your attention; the file and
   its history stay.
