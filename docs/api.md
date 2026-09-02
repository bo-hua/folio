# HTTP API

The UI is a client of a small JSON API; anything the UI does, a script can do too.
Everything is served from the loopback bind address (`127.0.0.1:4317` by default).

| method | path | purpose |
|---|---|---|
| GET | `/api/overview` | everything the board needs (areas, items, rolled-up runtime state, whether the server is running stale code) |
| GET | `/api/repo` | git worktree snapshot |
| GET, POST | `/api/areas` | list / create areas |
| DELETE | `/api/areas/<name>` | delete an area and its items (cascade) |
| POST | `/api/items` | create an item |
| GET, PATCH, DELETE | `/api/items/<id>` | read / update / delete an item |
| POST | `/api/items/<id>/move` | the canvas's one structural edit: parent / area / before / after |
| POST | `/api/items/<id>/sessions` | attach a session |
| PATCH, DELETE | `/api/items/<id>/sessions/<sid>` | retitle / detach a session |
| GET | `/api/sessions[?all=1]` | sessions the hook has observed |
| GET | `/api/sessions/<sid>/resume` | how to get back into that session |

Notes:

- `POST /api/items/<id>/move` renumbers sibling `order`.
- `DELETE /api/items/<id>` cascades to everything nested under it.
- Attaching a session detaches it from any other item unless `exclusive: false` —
  a session lives on exactly one card.

Example:

```bash
curl -s http://127.0.0.1:4317/api/overview | jq '.areas[].name'
curl -s http://127.0.0.1:4317/api/sessions | jq '.[] | {short_id, state, title}'
```
