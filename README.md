# folio

Organize AI-assisted work around the **project / purpose / problem** being solved,
not around the individual Claude Code sessions created while solving it.

```
Area  (a directory)
  └── Item  (one Markdown file: name, status, notes, context refs …)
        ├── optional child Items      (child stores `parent: <id>`; derived, never duplicated)
        └── 0..N Claude Code sessions (ids + human titles; live state joined at runtime)
```

* **Markdown is the source of truth.** Every Item is a small, hand-editable `.md`
  file with YAML frontmatter under `~/.cc-workspace/items/<Area>/`.
* **Runtime is derived, not stored.** Git worktrees/branches come from `git worktree
  list`; Claude session state comes from a metadata-only hook. The UI joins the two
  with the Markdown by session id.
* **Deliberately small.** One Python process (stdlib `http.server`), two runtime
  dependencies (`pyyaml`, `markdown`), a vanilla-JS UI, no database, no cloud, no auth.

## Quick start (local)

```bash
cd ~/code/folio
uv venv .venv --python 3.12                    # or: python3 -m venv .venv
uv pip install --python .venv/bin/python -e '.[dev]'   # or: .venv/bin/pip install -e '.[dev]'

.venv/bin/folio init --repo /path/to/the/one/git/repo   # writes ~/.cc-workspace/config.toml
.venv/bin/folio hooks print                              # show the Claude hook config (see below)
.venv/bin/folio serve                                    # http://127.0.0.1:4317/
```

`folio serve` refuses to bind to anything but a loopback address.

**Restart `folio serve` after editing folio itself.** The HTML/CSS/JS is read
from disk on every request, but the running process keeps the Python it started
with -- so an un-restarted server hands the browser buttons whose endpoints it
has never heard of, and they fail with `no such endpoint`. The dashboard detects
this (server start time vs. the newest mtime under `folio/`) and shows a banner.

Other commands: `folio worktrees` (what git reports), `folio sessions [--all]`
(what the hook has observed), `folio hooks install|uninstall [--dry-run]`.

Data directory: `~/.cc-workspace` by default, or `--data-dir PATH` / `FOLIO_DATA_DIR=PATH`.

## Data layout (all user data lives outside this repo)

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

### Item file

```markdown
---
id: k7m2p9xw                       # stable, opaque; filename is just a readable slug
name: Better long-term ranking objective
created: '2026-08-29T18:30:00-07:00'
updated: '2026-08-29T19:02:11-07:00'
status: active                     # idea | active | waiting | done | parked
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

Children, worktrees, branches and live Claude state are **never** written into
the Markdown; they are derived when the page renders.

## Claude Code hook (runtime state)

`folio hook` is a pure observer. Claude Code pipes one JSON event to it on stdin;
it records coarse metadata and exits 0 **without printing anything**, so it can
never approve, deny, block or otherwise alter a permission decision.

What is stored per session (`runtime/sessions/<id>.json`):
`session_id`, `state` (working / needs_you / ready / ended), `attention`
(permission / question), `last_event`, `updated_at`, `first_seen`, `cwd`,
`permission_mode`, best-effort `pid`. **Never** prompts, responses, tool
arguments, transcripts or code.

State mapping (Claude Code 2.1.x hook events):

| event | state |
|---|---|
| `SessionStart`, `Stop`, `Notification/idle_prompt` | ready (waiting for your next prompt) |
| `UserPromptSubmit`, `Pre/PostToolUse`, `Subagent*`, `*Compact` | working |
| `PermissionRequest` (any tool) | **needs you** · permission |
| `PermissionRequest` with `tool_name == AskUserQuestion`, `Notification/elicitation_dialog` | **needs you** · question |
| `SessionEnd` | ended |
| no events for 12 h, or the recorded `pid` is gone | inactive (derived) |

Events emitted from inside subagents (they carry `agent_id`) do not change the
main session's state.

### Installing the hook

Option A — let folio merge it (backs up first, never removes existing hooks):

```bash
.venv/bin/folio hooks install --dry-run    # inspect the merged ~/.claude/settings.json
.venv/bin/folio hooks install              # writes it; backup at settings.json.bak-<timestamp>
```

Option B — merge by hand: paste the output of `folio hooks print` into the
`"hooks"` object of `~/.claude/settings.json` (create the key if missing). Each
event gets one extra group `{"hooks": [{"type": "command", "command": "<abs path>/.venv/bin/folio hook", "timeout": 10}]}`
appended next to whatever is already configured.

Restart running Claude Code sessions afterwards. `folio hooks uninstall` removes
only the folio entries. The command uses the venv's absolute path, so nothing
about your global Python changes. If the data dir is non-default the command
carries `--data-dir` explicitly (Claude does not inherit `FOLIO_DATA_DIR`).

To test without touching user-level settings, install into a project:
`folio hooks install --settings /path/to/repo/.claude/settings.json`.

## Using the UI

* **Dashboard** – *Needs you* / *Working* strips across all Areas, then each Area
  in columns Active · Waiting · Ideas · Parked · Recently done. Cards show attached
  session counts and child rows; a child's attention bubbles up to the parent card.
  Type into "Quick idea in …" and press Enter to create an idea in one step.
  **+ New area** creates a directory; **Delete area** (per Area header, after a
  confirm) removes the directory with every item in it. Items in *other* Areas
  whose parent lived there are kept and become top-level.
* **Item** – rename, status/area/parent selects, attached Claude sessions with live
  state · last update · worktree · branch · cwd, **Resume / Attach** (shows and copies
  the right command: `claude attach <short-id>` for a *running background* session,
  otherwise `cd <cwd> && claude --resume <id>`, plus stop-then-resume and
  `--fork-session` alternatives), **Attach Claude session** (pick from recently
  observed sessions inside the configured repo, or paste an id), child cards with
  quick-add, AI state, editable Notes (Markdown), context refs (URLs are links,
  paths get a Copy button).
* **Sessions** – everything the hook has observed for the configured repo, with
  attach-to-item and copy-resume actions.

Item workflow status (`active`, `waiting`, …) is human state; *Needs you* /
*Working* is ephemeral runtime state. They are shown side by side, never merged.

## Running on a devbox behind SSH port forwarding

On the devbox (same machine as Claude Code + the repo + its worktrees):

```bash
git clone <this repo> ~/code/folio && cd ~/code/folio
python3 -m venv .venv && .venv/bin/pip install -e .      # or the uv commands above
.venv/bin/folio init --repo /home/bhua/ans
.venv/bin/folio hooks install --dry-run && .venv/bin/folio hooks install
.venv/bin/folio serve --bind 127.0.0.1:4317              # or put bind in config.toml
```

On the laptop:

```bash
ssh -L 4317:127.0.0.1:4317 devbox
# then open http://127.0.0.1:4317/ in the laptop browser
```

Nothing but the loopback interface is ever exposed; the app itself has no SSH,
auth or cloud component. Moving between machines is a `config.toml` change.

## Tests

```bash
.venv/bin/python -m pytest -q
```

Covers Markdown round-trips without destroying notes/unknown keys, timestamp
behaviour, parent→child derivation, real `git worktree` discovery + cwd→worktree
matching (incl. symlinked paths), hook event→state parsing, metadata-only
persistence, item-level attention aggregation, attach/detach persistence, area
deletion (cascade + cross-area detach), the
settings.json merge, the hook CLI as a silent observer, and an end-to-end HTTP
flow against a fixture repo.

## Architecture notes / replacing pieces later

* `folio/items.py` – Markdown store (no knowledge of Claude or git).
* `folio/gitinfo.py` – `git worktree list --porcelain` + longest-prefix cwd match.
* `folio/runtime.py` – **the Claude-specific boundary**: `transition()` maps hook
  events to coarse states; everything downstream only sees `working / needs_you /
  ready / ended / inactive / unknown`. Another agent system would provide a
  different `transition()` and hook.
* `folio/server.py` – JSON API + static files. `resume_command()` is a plain
  string on purpose; a richer resume mechanism can replace it without touching
  the Markdown.
* No cache/index: every request re-reads the item files (fine for hundreds).

## Known limitations (MVP)

* Exactly one configured repository. Sessions elsewhere are visible with `--all` /
  "show all" but are not matched to a worktree.
* Runtime state depends on the hook: a prose question looks like an ordinary turn
  end until Claude's `idle_prompt`; a killed session emits no `SessionEnd`, so it is
  shown as *inactive* only via pid/staleness heuristics.
* "Recently done" shows the 5 most recently updated done items per Area.
* Resume is command-copy only (no embedded terminal); notes are a plain textarea;
  no automatic AI-state generation; no transcript viewer; no auth (loopback only).
* Renaming an Area = renaming its directory; renaming an Item keeps its filename.
