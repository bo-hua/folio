# folio

**A local, single-user home for work you do with Claude Code — organized around the
problem you are solving, not around the sessions you opened while solving it.**

folio is a small web app plus CLI that runs on the machine where you run Claude Code.
It keeps a durable, hand-editable Markdown file per piece of work, attaches Claude
sessions to it, and joins that against live session state and git worktrees so one
page can answer: *what am I working on, and what is blocked on me right now?*

No database, no cloud, no account, no auth. One Python process, ~3k lines, two
runtime dependencies. Your data is a directory of Markdown files you can grep,
diff, and edit in any editor.

---

## The problem

A Claude Code session is the unit of *interaction*. It is almost never the unit of
*work*.

One real task — "make the long-term ranking objective actually long-term" — spans a
session to survey prior art, a session that forks off to prototype, two more after
you come back on Monday, one that got compacted into uselessness and abandoned, and
a background session still churning in a worktree you have forgotten the name of.
Meanwhile three unrelated tasks are in flight in adjacent terminal tabs.

So you end up asking questions the tools cannot answer:

* Which of my seven live sessions is **waiting on me** right now — a permission
  prompt, a question — versus still working?
* Which session was the one exploring the alternative objective? What was I going
  to do next on it?
* Where does *this* piece of work stand, three days and five sessions later, when
  every transcript is gone from my terminal scrollback?
* What am I actually carrying? Not "what's in my shell history" — what problems am
  I currently on the hook for?

Terminal tabs answer none of that. Neither does a generic task tracker, which knows
nothing about your sessions. The two halves — *durable intent* and *ephemeral
runtime* — live in different places and never meet.

## What folio does

folio holds the durable half and **derives** the ephemeral half, then shows them
side by side.

* **Durable (you own it, it's Markdown).** An *Item* is one `.md` file: name,
  status, notes, context links, and the ids of the Claude sessions that belong to
  it. Items nest (a prototype under an investigation). They live in *Areas*, which
  are just directories.
* **Ephemeral (folio derives it, never stores it in your files).** A metadata-only
  Claude Code hook records each session's coarse state — *working / needs you /
  ready / ended*. `git worktree list` supplies worktrees and branches. Claude Code's
  own transcript supplies each session's title and last prompt, so the rail says
  *"long-term ranking objective"* rather than `5caf6282`. All three are re-read on
  every request and joined to the Markdown by session id.
* **The join is the product.** The dashboard opens with a **Needs you** strip
  across every Area, then **Working**, then your Items by status. A child item's
  attention bubbles up to its parent card, so a background session hitting a
  permission prompt three levels down still surfaces at the top of the page.

Sessions are attached to Items, not the other way round. Sessions come and go;
the Item is what persists.

### It observes. It never drives.

The hook is a pure observer: Claude pipes it one JSON event on stdin, it records
coarse metadata and exits 0 **without printing anything**, so it can never approve,
deny, block, or otherwise alter a permission decision. It stores session ids,
states, timestamps, cwd, permission mode, a best-effort pid, and the path of
Claude Code's transcript — **never** prompts, responses, tool arguments, transcript
*contents*, or code.

folio also never launches, steers, or kills a session. "Resume" hands you the
correct shell command to copy. That boundary is deliberate: folio is safe to leave
running because there is nothing it can do to your agents.

## Is this for you?

Good fit if you:

* run **several Claude Code sessions in parallel**, often in git worktrees, often
  background sessions you check on later;
* work on a **devbox over SSH** and want a browser view of it from your laptop;
* want work notes that survive the session, in **files you own**, greppable and
  diffable, not locked in an app;
* like small, boring, inspectable tools.

Probably not for you if you want a team tracker (folio is single-user, loopback-only,
no auth, no sharing), an agent orchestrator (see above — it only watches), a
transcript viewer, or something that works across many repositories at once (the
MVP tracks exactly one).

## Concepts

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

### Design rules

* **Markdown is the source of truth.** Every Item is a small, hand-editable file.
  Edit it in your editor while folio is running; folio re-reads on every request.
  The UI rewrites only the section it owns and preserves unknown frontmatter keys.
* **Runtime is derived, not stored.** Worktrees come from git. Session state comes
  from the hook. Children come from scanning `parent:` fields. Nothing derived is
  duplicated into your files, so nothing can go stale.
* **Deliberately small.** One Python process (stdlib `http.server`), two runtime
  dependencies (`pyyaml`, `markdown`), a vanilla-JS UI, no build step, no database,
  no cloud, no auth, no cache — every request re-reads the item files (fine for
  hundreds).

## Quick start (local)

```bash
cd ~/code/folio
uv venv .venv --python 3.12                    # or: python3 -m venv .venv
uv pip install --python .venv/bin/python -e '.[dev]'   # or: .venv/bin/pip install -e '.[dev]'

.venv/bin/folio init --repo /path/to/the/one/git/repo   # writes ~/.cc-workspace/config.toml
.venv/bin/folio hooks install --dry-run                 # inspect the Claude hook merge
.venv/bin/folio hooks install                           # then restart running Claude sessions
.venv/bin/folio serve                                   # http://127.0.0.1:4317/
```

`folio serve` refuses to bind to anything but a loopback address.

**Restart `folio serve` after editing folio itself.** The HTML/CSS/JS is read
from disk on every request, but the running process keeps the Python it started
with — so an un-restarted server hands the browser buttons whose endpoints it
has never heard of, and they fail with `no such endpoint`. The dashboard detects
this (server start time vs. the newest mtime under `folio/`) and shows a banner.

Other commands: `folio worktrees` (what git reports), `folio sessions [--all]`
(what the hook has observed), `folio hooks print|install|uninstall [--dry-run]`,
`folio tidy [--dry-run]` (rename item files whose filename drifted from their name).

Data directory: `~/.cc-workspace` by default, or `--data-dir PATH` / `FOLIO_DATA_DIR=PATH`.

## A day with folio

1. **Capture.** An idea arrives mid-morning. Type it into "Quick idea in Ranking"
   on the dashboard and press Enter — one keystroke, an Item exists, you move on.
2. **Start.** You open it, set status *active*, and start a Claude session in a
   worktree the usual way. Back in folio, **Attach Claude session** lists sessions
   the hook has recently seen inside your repo; pick yours and give it a title
   ("Survey existing approaches").
3. **Fan out.** The survey suggests a prototype. Add it as a **child item**, attach
   the forked session to the child. The parent card now shows both.
4. **Triage.** Two hours later you have five sessions running. Instead of cycling
   terminal tabs, you look at the dashboard: *Needs you · permission* on one card,
   *Working* on two, the rest quiet. You handle the one that is actually blocked.
5. **Come back.** Next morning, the Item page tells you where things stood — your
   notes, the AI-state paragraph, the attached sessions with their last update,
   worktree, and branch. **Resume / Attach** gives you the exact command for each
   session (`claude attach <short-id>` for a live background session, otherwise
   `cd <cwd> && claude --resume <id>`, plus stop-then-resume and `--fork-session`).
6. **Close out.** Status → *done*. It drops into "Recently done" for that Area and
   stops competing for your attention; the file and its history stay.

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

Back up `items/`; `runtime/` is disposable.

The file is called what the card is called — `Clarify card status.md`, spaces
and capitals intact — and follows it: rename a card and the file is renamed with
it, so the directory reads like the card list in any Markdown editor. Only the
characters a filesystem or Obsidian refuses are replaced (`:` becomes ` - `, and
`/ \ < > " | ? * [ ] # ^` become spaces), and a very long name is trimmed at a
word boundary. Only `id` identifies an item, so a filename is safe to change by
hand — `folio tidy` puts any that have drifted back in step (`--dry-run` first
to see the moves).

### Item file

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

Children, worktrees, branches and live Claude state are **never** written into
the Markdown; they are derived when the page renders.

## Claude Code hook (runtime state)

`folio hook` is a pure observer. Claude Code pipes one JSON event to it on stdin;
it records coarse metadata and exits 0 **without printing anything**, so it can
never approve, deny, block or otherwise alter a permission decision.

What is stored per session (`runtime/sessions/<id>.json`):
`session_id`, `state` (working / needs_you / ready / ended), `attention`
(permission / question), `last_event`, `updated_at`, `first_seen`, `cwd`,
`transcript_path`, `permission_mode`, best-effort `pid`. **Never** prompts,
responses, tool arguments, transcript contents or code.

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

### Session titles (derived, never stored)

A session id tells you nothing, and naming every session by hand is work nobody
does. Claude Code already writes a short title for each session into its own
transcript (`~/.claude/projects/<slug>/<session-id>.jsonl`), refreshed as the
session goes:

```json
{"aiTitle": "delete area data cleanup", "sessionId": "fced8226-…", "type": "ai-title"}
{"lastPrompt": "merge",                 "sessionId": "fced8226-…", "type": "last-prompt"}
```

`folio/transcript.py` reads those two fields — and nothing else — on every request
and hands them to the rail as `auto_title` and `last_prompt`. They are **never**
written into `runtime/sessions/` or into your Markdown; the record keeps only the
transcript's *path*, and folio can find the file by session id without it.

Precedence for a session's name is **your title → Claude's title → the short id**,
so renaming a session in the inspector still wins and still lives in the Item's
Markdown, where you can grep it.

Transcripts reach tens of megabytes, so folio reads a 256 KB tail and scans it
backwards for the newest of each line (both are rewritten every turn), falling
back to a whole-file scan for sessions that stopped early, and caching per
(path, mtime, size) — a warm overview costs microseconds. Claude Code owns this
format; if it changes, every read fails silently and sessions simply go back to
showing their id.

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

One screen, three regions. Nothing on it is positioned by you; you only change
*relations*, and the app lays everything out.

* **Sessions rail (left)** – everything the hook has observed for the configured
  repo, grouped by state (*Needs you · Working · Ready · Ended*), filterable to
  *Unattached* (your inbox) or *Needs you*; tick *other repos* to include
  sessions elsewhere. Each row leads with the session's name — yours if you set
  one, otherwise the title Claude Code gave it — over its last prompt, branch,
  short id and age. Drag a row onto any card to attach it (a session lives on one
  card; dropping it on another card moves it). Click a row to fly to its card.
* **Canvas (centre)** – Areas side by side; each lays its cards into stable
  columns. Children render *inside* their parent along a tree rail, all the way
  down — a card just gets bigger. The chevron chip collapses a subtree (it turns
  into a stacked deck with a composition strip); **Collapse all** does the whole
  workspace. Lifecycle is a small glyph before the title; the one loud thing is
  **attention**: a card whose session needs you glows amber, Area headers and the
  top-bar pill carry counts, and **J** walks you through them.
  Drag a card onto another card's body to make it a child; onto a card's top or
  bottom edge to place it before/after as a sibling; onto an Area's empty space
  to make it top-level there (that is also how you move a child out). Drag a
  session chip off a card onto empty canvas (or back onto the rail) to detach it.
  Structural changes toast with **Undo**. Scroll pans, ⌘/ctrl‑scroll zooms, **F** fits.
* **Inspector (right, on select)** – rename, derived state with **Mark done** /
  **Park** (with a note), attached sessions with live state and **Open / Resume**
  (shows and copies the right command: `claude attach <short-id>` for a running
  background session, otherwise `cd <cwd> && claude --resume <id>`, plus
  alternatives), children with quick-add, **↑ Move out**, Notes (Markdown),
  context refs, AI state when present, and **Delete** (cascades to everything
  nested, after a confirm).
* **Focus filter (top bar)** – *All · Hide done · Focus*, or **H** to cycle.
  Two different questions: *Hide done* is about the lifecycle **you** set — it
  leaves out cards you marked done. *Focus* is about **Claude** — it keeps only
  cards carrying a live session (*needs you · working · ready*, the same boundary
  the rail draws before *Ended / inactive*), whatever their lifecycle, so a done
  card someone is still running on stays and an untouched idea does not. Hiding
  is by subtree, not by card: a card the mode would drop stays when something
  inside it survives — it is the way in — and a card whose session **needs you**
  is never hidden, because a filter that swallows an alert is worse than no
  filter. Counts stay honest (`9 of 14 cards`, an area's `3 of 5 cards`, a
  parent's `2 hidden` chip), the pill beside the control says how many are out of
  sight and clears the filter when clicked, and whatever you select comes back
  onto the canvas while it is open — including a dimmed child clicked in the
  Inspector.
* **+ Idea** adds to the Inbox; **+** on an Area header adds there; **+ Area**
  creates a directory. Area headers offer **Delete area** on hover.

Deep links: `/#card=<id>`. Collapsed state, the camera and the focus filter are
remembered per browser.

Item lifecycle (`idea`, `active`, `done`, `parked`) is what the item *is*; *Needs
you* / *Working* is ephemeral runtime state. They are shown side by side, never merged.

## Running on a devbox behind SSH port forwarding

This is the intended setup: Claude Code, the repo, its worktrees and folio all live
on the devbox; only a browser tab lives on the laptop.

On the devbox:

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

## HTTP API

The UI is a client of a small JSON API; anything the UI does, a script can do too.

| method | path | purpose |
|---|---|---|
| GET | `/api/overview` | everything the dashboard needs (areas, items, rolled-up runtime state, whether the server is running stale code) |
| GET | `/api/repo` | git worktree snapshot |
| GET, POST | `/api/areas` | list / create Areas |
| DELETE | `/api/areas/<name>` | delete an Area and its items (cascade) |
| POST | `/api/items` | create an Item |
| GET, PATCH, DELETE | `/api/items/<id>` | read / update / delete an Item |
| POST | `/api/items/<id>/sessions` | attach a session |
| PATCH, DELETE | `/api/items/<id>/sessions/<sid>` | retitle / detach a session |
| GET | `/api/sessions[?all=1]` | sessions the hook has observed |
| GET | `/api/sessions/<sid>/resume` | how to get back into that session |

## Tests

```bash
.venv/bin/python -m pytest -q
```

Covers Markdown round-trips without destroying notes/unknown keys, timestamp
behaviour, parent→child derivation, real `git worktree` discovery + cwd→worktree
matching (incl. symlinked paths), hook event→state parsing, metadata-only
persistence, item-level attention aggregation, attach/detach persistence, area
deletion (cascade + cross-area detach), the settings.json merge, the hook CLI as a
silent observer, transcript title extraction (tail window, whole-file fallback,
junk and lookalike lines, cache invalidation), and an end-to-end HTTP flow against
a fixture repo.

## Architecture notes / replacing pieces later

The Claude-specific surface is deliberately confined to one small module, so folio
is not permanently married to Claude Code.

* `folio/items.py` – Markdown store (no knowledge of Claude or git).
* `folio/gitinfo.py` – `git worktree list --porcelain` + longest-prefix cwd match.
* `folio/runtime.py` – **the Claude-specific boundary**: `transition()` maps hook
  events to coarse states; everything downstream only sees `working / needs_you /
  ready / ended / inactive / unknown`. Another agent system would provide a
  different `transition()` and hook.
* `folio/transcript.py` – **also Claude-specific**: reads `aiTitle` / `lastPrompt`
  out of Claude Code's transcript so sessions have names. Purely additive — delete
  it and sessions fall back to their ids.
* `folio/hook.py` / `folio/hooks.py` – the observer entrypoint, and the
  settings.json merge/unmerge.
* `folio/server.py` – JSON API + static files. `resume_command()` is a plain
  string on purpose; a richer resume mechanism can replace it without touching
  the Markdown.
* `folio/static/` – the whole UI: one HTML file, one CSS file, one JS file, one SVG favicon.
* No cache/index: every request re-reads the item files (fine for hundreds).
* `POST /api/items/<id>/move` is the canvas's one structural edit (parent / area / before / after);
  it renumbers sibling `order`. `DELETE /api/items/<id>` cascades. Attaching a session
  detaches it from any other item unless `exclusive: false`.

## Non-goals

folio deliberately does **not**: launch, steer, approve, or kill Claude sessions;
read or store transcripts, prompts, or tool arguments; sync to a server; support
multiple users or auth; or replace your issue tracker for team-visible work.

## Known limitations (MVP)

* Exactly one configured repository. Sessions elsewhere are visible with `--all` /
  "show all" but are not matched to a worktree.
* Runtime state depends on the hook: a prose question looks like an ordinary turn
  end until Claude's `idle_prompt`; a killed session emits no `SessionEnd`, so it is
  shown as *inactive* only via pid/staleness heuristics.
* Every card is expanded by default; deep trees may want to start collapsed (not yet).
* Resume is command-copy only (no embedded terminal); notes are a plain textarea;
  no automatic AI-state generation; no transcript viewer; no auth (loopback only).
* Renaming an Area = renaming its directory; renaming an Item keeps its filename.
