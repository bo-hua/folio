# HTTP API

The UI is a client of a small JSON API; anything the UI does, a script can do too.
Everything is served from the loopback bind address (`127.0.0.1:4317` by default).

| method | path | purpose |
|---|---|---|
| GET | `/api/overview` | everything the board needs (areas, items, rolled-up runtime state, whether the server is running stale code, and `spares.standing_by`: Claude Code's pre-started next background sessions, which are counted here rather than listed) |
| GET | `/api/repo` | git worktree snapshot |
| GET, POST | `/api/areas` | list / create areas |
| DELETE | `/api/areas/<name>` | delete an area and its items (cascade) |
| POST | `/api/items` | create an item |
| GET, PATCH, DELETE | `/api/items/<id>` | read / update / delete an item |
| POST | `/api/items/<id>/move` | the canvas's one structural edit: parent / area / before / after |
| GET | `/api/items/<id>/brief` | the card as one block of text to paste into a Claude prompt (what the copy button copies) |
| POST | `/api/items/<id>/sessions` | attach a session |
| PATCH, DELETE | `/api/items/<id>/sessions/<sid>` | retitle / detach a session |
| GET | `/api/sessions[?all=1]` | sessions the hook has observed, plus the same `spares` count |
| PATCH | `/api/sessions/<sid>` | hide a session from the rail's *Unattached* list, or unhide it |
| POST | `/api/sessions/hide` | the same for a list of sessions, in one request |
| GET | `/api/sessions/<sid>/resume` | how to get back into that session |

Notes:

- `POST /api/items/<id>/move` renumbers sibling `order`.
- `DELETE /api/items/<id>` cascades to everything nested under it.
- A session can sit on any number of cards. `POST /api/items/<id>/sessions` adds it
  to that card and leaves its other cards alone; pass `from: <item id>` to leave
  that one card at the same time (a move), or `exclusive: true` to leave every
  other card. Each session in `/api/overview` carries `items` (every card it is
  on) and `item` (the first of them, or `null`).
- `PATCH /api/items/<id>/sessions/<sid>` with `title` renames the session on every
  card it sits on: the title belongs to the session, not to one card.
- `PATCH /api/sessions/<sid>` with `{"hidden": true}` takes a session out of the rail's
  *Unattached* list (`false` puts it back), and `POST /api/sessions/hide` with
  `{"session_ids": [...], "hidden": true}` does a whole list in one request, returning
  the ids it changed — that is the UI's *Hide all N*, and one Undo. Every session
  carries `hidden` (bool). Hiding affects that one list: every other view still shows
  the session, and the rail always says how many are hidden and can list them again.
  It is the one field of a session record a person sets, so it lives on the runtime
  record with the rest of that session's state and needs one to exist (`404` if the hook
  has never seen the session, `400` without a `hidden` key; ids in a batch that have no
  record are skipped rather than failing it).
- Every session carries `spare` (bool). A spare is a background session Claude Code
  started ahead of the next job and nothing has prompted yet: not listed until its
  first prompt lands, unless you attached it to a card yourself. See
  [hook.md](hook.md#the-spare-session).
- `GET /api/items/<id>/brief` returns `{id, name, text}`. `text` is the card's name,
  id and file, its notes, links, attached sessions (state, branch, cwd, last
  prompt), children, and the notes of every card above it. It never starts with
  `#`, `/` or `!`, so it is safe to paste into Claude Code on its own. Pasted into
  a session's prompt it also attaches that session to the card: the hook recognises
  the `id:` line ([hook.md](hook.md#pointing-a-session-at-a-card)).

Example:

```bash
curl -s http://127.0.0.1:4317/api/overview | jq '.areas[].name'
curl -s http://127.0.0.1:4317/api/sessions | jq '.[] | {short_id, state, title}'
curl -s http://127.0.0.1:4317/api/items/k7m2p9xw/brief | jq -r .text | pbcopy   # same as the card's copy button
```
