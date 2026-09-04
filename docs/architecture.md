# Architecture

## Design rules

- **Markdown is the source of truth.** Every item is a small, hand-editable file.
  Edit it while folio is running; folio re-reads on every request. The UI rewrites
  only the section it owns and preserves unknown frontmatter keys.
- **Runtime is derived, not stored.** Worktrees come from git. Session state comes
  from the hook. Children come from scanning `parent:` fields. Nothing derived is
  duplicated into your files, so nothing can go stale.
- **Deliberately small.** One Python process (stdlib `http.server`), two runtime
  dependencies (`pyyaml`, `markdown`), a vanilla-JS UI, no build step, no database,
  no cloud, no auth, no cache — every request re-reads the item files (fine for
  hundreds).

## Module map

The Claude-specific surface is confined to two small modules, so folio is not
permanently married to Claude Code.

| module | role |
|---|---|
| `folio/items.py` | Markdown store (no knowledge of Claude or git) |
| `folio/gitinfo.py` | `git worktree list --porcelain` + longest-prefix cwd match |
| `folio/runtime.py` | **the Claude-specific boundary**: `transition()` maps hook events to coarse states; everything downstream only sees `working / needs_you / ready / ended / inactive / unknown`. Another agent system would supply a different `transition()` and hook. |
| `folio/transcript.py` | **also Claude-specific**: reads `aiTitle` / `lastPrompt` out of Claude Code's transcript so sessions have names. Purely additive — delete it and sessions fall back to their ids. |
| `folio/hook.py`, `folio/hooks.py` | the observer entrypoint, and the settings.json merge/unmerge |
| `folio/brief.py` | one card as a block of text for a prompt: name, notes, sessions, children, ancestors' notes. Pure formatting over the same snapshot the board renders. |
| `folio/server.py` | JSON API + static files. `resume_command()` is a plain string on purpose; a richer resume mechanism can replace it without touching the Markdown. |
| `folio/static/` | the whole UI: one HTML file, one CSS file, one JS file, one SVG favicon |

## Tests

```bash
.venv/bin/python -m pytest -q
```

Covers Markdown round-trips without destroying notes or unknown keys, timestamp
behaviour, parent→child derivation, real `git worktree` discovery + cwd→worktree
matching (incl. symlinked paths), hook event→state parsing, metadata-only
persistence, item-level attention aggregation, attach/detach persistence, area
deletion (cascade + cross-area detach), the settings.json merge, the hook CLI as a
silent observer, transcript title extraction (tail window, whole-file fallback, junk
and lookalike lines, cache invalidation), and an end-to-end HTTP flow against a
fixture repo.

`tests/test_server.py` drives a real server over HTTP against a fixture repo — new
endpoints and new static assets belong there, asserting status *and* `Content-Type`.

## Restart after editing folio itself

HTML/CSS/JS is read from disk on every request, so static changes need only a
browser hard-reload. **Python changes need a server restart** — an un-restarted
server hands the browser buttons whose endpoints it has never heard of, and they
fail with `no such endpoint`. The board detects this (server start time vs. the
newest mtime under `folio/`), `/api/overview` reports `stale: true`, and the UI
shows a banner.

## Known limitations (MVP)

- Exactly one configured repository. Sessions elsewhere are visible with `--all` /
  "other repos" but are not matched to a worktree.
- Runtime state depends on the hook: a prose question looks like an ordinary turn
  end until Claude's `idle_prompt`; a killed session emits no `SessionEnd`, so it is
  shown as *inactive* only via pid/staleness heuristics.
- Every card is expanded by default; only a long list (more than six children)
  folds its done children into one line. Deep trees may still want to start collapsed.
- Resume is command-copy only (no embedded terminal); notes are a plain textarea;
  no automatic AI-state generation; no transcript viewer; no auth (loopback only).
- Renaming an area = renaming its directory.
