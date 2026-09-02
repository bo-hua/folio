# The Claude Code hook

`folio hook` is a pure observer. Claude Code pipes one JSON event to it on stdin;
it records coarse metadata and exits 0 **without printing anything**, so it can
never approve, deny, block or otherwise alter a permission decision.

## What is stored

Per session, in `runtime/sessions/<id>.json`: `session_id`, `state` (working /
needs_you / ready / ended), `attention` (permission / question), `last_event`,
`updated_at`, `first_seen`, `cwd`, `transcript_path`, `permission_mode`,
best-effort `pid`, and `main_event_at` / `agent_event_at` (which side of the
session we last heard from — see *Subagents* below).

**Never** prompts, responses, tool arguments, transcript contents or code.

## Event → state

Claude Code 2.1.x hook events:

| event | state |
|---|---|
| `SessionStart`, `Stop`, `Notification/idle_prompt` | ready (waiting for your next prompt) |
| `UserPromptSubmit`, `Pre/PostToolUse`, `Subagent*`, `*Compact` | working |
| `PermissionRequest` (any tool) | **needs you** · permission |
| `PermissionRequest` with `tool_name == AskUserQuestion`, `Notification/elicitation_dialog` | **needs you** · question |
| `SessionEnd` | ended |
| no events for 12 h, or the recorded `pid` is gone | inactive (derived) |
| main agent idle but a subagent still running | working (derived) |

## Subagents

Tool events emitted from inside a subagent carry `agent_id`. They say nothing about
what the *main* agent is doing, so they never overwrite the stored state.

That alone is not enough. A subagent dispatched into the background outlives the
turn that spawned it: the main agent stops, emits `Stop`, and the session is stored
as **ready** while the work you can watch in the terminal is still running. So the
hook also records *which side of the session spoke last* — `main_event_at` versus
`agent_event_at` — and a stored `ready` whose newest event came from a subagent is
reported as **working**.

The comparison is deliberately a comparison and not a timeout: a subagent that
spends ten minutes inside one query stays working for all ten, and the instant the
main thread speaks again its event is the newer one and its own state is trusted
again. Nothing can wedge: if neither side ever speaks again the record goes stale
and falls to *inactive* on the usual 12-hour rule.

**Attention is exempt.** A `PermissionRequest` or a permission/elicitation
`Notification` is mapped *before* the `agent_id` check, so a prompt raised three
levels down still surfaces as **needs you** on the session that owns it. A filter
that swallows an alert is worse than no filter.

## Session titles (derived, never stored)

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
so renaming a session in the inspector still wins and still lives in the item's
Markdown, where you can grep it.

Transcripts reach tens of megabytes, so folio reads a 256 KB tail and scans it
backwards for the newest of each line (both are rewritten every turn), falling back
to a whole-file scan for sessions that stopped early, and caching per
(path, mtime, size) — a warm overview costs microseconds. Claude Code owns this
format; if it changes, every read fails silently and sessions simply go back to
showing their id.

## Installing

Option A — let folio merge it (backs up first, never removes existing hooks):

```bash
.venv/bin/folio hooks install --dry-run    # inspect the merged ~/.claude/settings.json
.venv/bin/folio hooks install              # writes it; backup at settings.json.bak-<timestamp>
```

Option B — merge by hand: paste the output of `folio hooks print` into the `"hooks"`
object of `~/.claude/settings.json` (create the key if missing). Each event gets one
extra group
`{"hooks": [{"type": "command", "command": "<abs path>/.venv/bin/folio hook", "timeout": 10}]}`
appended next to whatever is already configured.

Restart running Claude Code sessions afterwards. `folio hooks uninstall` removes
only the folio entries. The command uses the venv's absolute path, so nothing about
your global Python changes. If the data dir is non-default the command carries
`--data-dir` explicitly (Claude does not inherit `FOLIO_DATA_DIR`).

To test without touching user-level settings, install into a project:
`folio hooks install --settings /path/to/repo/.claude/settings.json`.
