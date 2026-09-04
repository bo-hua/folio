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
| GET | `/api/sessions/<sid>/resume` | how to get back into that session |

Notes:

- `POST /api/items/<id>/move` renumbers sibling `order`.
- `DELETE /api/items/<id>` cascades to everything nested under it.
- Attaching a session detaches it from any other item unless `exclusive: false` —
  a session lives on exactly one card.
- Every session carries `spare` (bool). A spare is a background session Claude Code
  started ahead of the next job and nothing has prompted yet: not listed until its
  first prompt lands, unless you attached it to a card yourself. See
  [hook.md](hook.md#the-spare-session).
- `GET /api/items/<id>/brief` returns `{id, name, text}`. `text` is the card's name,
  id and file, its notes, links, attached sessions (state, branch, cwd, last
  prompt), children, and the notes of every card above it. It never starts with
  `#`, `/` or `!`, so it is safe to paste into Claude Code on its own.

Example:

```bash
curl -s http://127.0.0.1:4317/api/overview | jq '.areas[].name'
curl -s http://127.0.0.1:4317/api/sessions | jq '.[] | {short_id, state, title}'
curl -s http://127.0.0.1:4317/api/items/k7m2p9xw/brief | jq -r .text | pbcopy   # same as the card's copy button
```
