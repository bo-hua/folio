# folio — working notes for Claude

## Environment

* Always use the project venv: `.venv/bin/python`, `.venv/bin/folio`. Never the
  shared miniforge Python.
* The venv lives in the **main checkout only** (`~/code/folio/.venv`). Worktrees
  under `.claude/worktrees/` do not have one — call it by absolute path from
  there.
* Data dir: `~/.cc-workspace` (or `$FOLIO_DATA_DIR`). The server binds loopback
  only; default `127.0.0.1:4317`.

## Testing a change

Both steps are required before you report a feature as done. **Passing unit
tests is not evidence that a feature works** — it is evidence that the code
under test works when imported the way the test imports it, which is often not
the way the user runs it.

### 1. Run the suite, and extend it

```bash
.venv/bin/python -m pytest -q
```

Add a test for what you changed. `tests/test_server.py` drives a real server
over HTTP against a fixture repo — new endpoints and new static assets belong
there, asserting status *and* `Content-Type`.

### 2. Exercise the real app

Start a server **from the code you just wrote**, on a spare port so you never
disturb the user's, and actually hit the thing you changed:

```bash
PYTHONPATH=<worktree root> ~/code/folio/.venv/bin/python -m folio.cli serve --bind 127.0.0.1:4318
curl -s -i http://127.0.0.1:4318/<path you touched>
```

`PYTHONPATH` is not optional from a worktree — see below.

What counts as exercising it:

* **New API endpoint** — `curl` it and read the JSON, including an error case.
* **New static asset** — fetch it: expect `200` and the right `Content-Type`.
  Also fetch `/` and confirm the page actually references it.
* **UI / CSS / icon work** — look at it. Render to PNG and open it with the
  Read tool rather than reasoning about the markup:
  `qlmanage -t -s 512 -o <outdir> file.svg`, then `sips -z 16 16 …` to check an
  icon survives tab size. Do not ship a visual change you have not seen.

## The worktree trap — read before you say "it works"

`folio serve` resolves its UI as `Path(folio.__file__).parent / "static"`, and
the venv holds an **editable install pinned to the main checkout**. So
`.venv/bin/folio serve`, run from anywhere including a worktree, serves
`~/code/folio/folio/static` — *not* your branch.

Consequences:

* A file you added on a worktree branch is invisible to the user's running
  server until the branch is merged. It will 404. Verifying against
  `127.0.0.1:4317` proves nothing about your change.
* To run your own branch's code, set `PYTHONPATH` to the worktree root, as
  above. Confirm you got the right one before trusting the result.
* Static files (HTML/CSS/JS/SVG) are re-read from disk on every request, so
  they need no restart — only a browser hard-reload. **Python changes need a
  server restart**; `/api/overview` reports `stale: true` and the UI shows
  "server is running older code" when the process is behind the disk.

## Reporting a change

Close every feature with how the user can confirm it themselves. State:

1. **How to get the code** — branch name and the exact merge command, if the
   work is on a worktree branch and their server therefore cannot see it yet.
2. **What to run or open** — the exact command or URL.
3. **What they should see** — the specific observable result.
4. **Any caveat that would make it look broken** — restart needed, browser
   hard-reload, Chrome's favicon cache (it survives `Cache-Control: no-store`).

Never hand over a URL you have not just fetched yourself.
