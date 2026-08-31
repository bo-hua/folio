# folio — working notes for Claude

## How we work together

The loop, in order:

1. **You say what to change.** One line is enough.
2. **I ask only if I am genuinely stuck** between readings that would lead to
   materially different work. Otherwise I pick the sensible reading, say what I
   assumed, and get on with it. No permission-seeking preamble.
3. **I do the whole job.** If it changes any file in this repo — code, tests,
   docs, this file — I work in a worktree (`EnterWorktree`), never in your
   checkout. Read-only questions need no worktree.
4. **I hand you a way to see it yourself.** See *Reporting a change* below. A
   branch you cannot run is not a deliverable.
5. **You look.** If something is off, say so and I keep working on the same
   branch. Iteration is the normal case, not a failure — I do not clean up or
   merge work you have not accepted.
6. **When you say it is good, I close it out**: merge to `main`, push, remove
   the worktree. Your approval at step 5 *is* the authorization for all three;
   I do not ask a second time.

Two standing rules that follow from this:

* **I never merge or push on my own initiative.** Step 6 requires your word.
  Until then the branch stays live and unmerged.
* **Verification is my job, not yours.** Step 4 means I have already run it.
  You are confirming, not testing.

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

**The port may not be yours.** Parallel sessions run their own folio servers on
nearby ports. A `200` from 4318 can easily be another session's process serving
`main`, and it will look exactly like success. Before trusting any response —
or handing the user a URL — prove the server is the one you started:

```bash
curl -s http://127.0.0.1:<port>/api/overview \
  | .venv/bin/python -c "import json,sys; print(json.load(sys.stdin)['data_dir'])"
curl -s http://127.0.0.1:<port>/static/style.css | grep -c "<a string only your change contains>"
```

A `0` from that grep means you are looking at someone else's server: pick
another port and start again. `lsof -nP -iTCP:4315-4330 -sTCP:LISTEN` shows
what is already taken.

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

## Closing out (step 6)

Merge, push, then remove the worktree — only after the user has accepted the
work.

**Other sessions' worktrees are not yours to delete.** Before removing anything
under `.claude/worktrees/`, check all three: is it `locked` in
`git worktree list`, is its branch merged into `main`, and does anything have a
working directory inside it?

```bash
git worktree list                                     # "locked" = hands off
git merge-base --is-ancestor "$(git -C <wt> rev-parse HEAD)" main && echo merged
git -C <wt> status --porcelain                        # empty = clean
lsof -a -d cwd -- <wt>
```

Read `lsof` carefully: **your own session's shell shows up too**, so output
alone does not mean "in use". What matters is whether *someone else's*
processes are there — a `python` running `folio serve`, a browser, a shell that
is not yours. `locked` plus an unmerged branch is the clearer signal.

Leave it alone unless it is merged, clean, and used by nobody but you.

**`ExitWorktree` cries wolf.** Removing a worktree warns that it "has N
commits" and that removal "will discard this work permanently", then reports
*Discarded 1 commit* — even when those commits are already merged and pushed.
It compares against the base branch and does not notice the merge. Prove it
either way before overriding, and again afterwards:

```bash
git merge-base --is-ancestor <sha> main
git merge-base --is-ancestor <sha> origin/main
```

If both pass, nothing is lost and `discard_changes: true` is safe. If either
fails, stop — that really would destroy work.

## Reporting a change

Close every feature with how the user can confirm it themselves. State:

1. **What to open** — an exact URL or command. The work is on an unmerged
   branch their own server cannot see, and they should not have to merge
   anything just to look: start a server from the branch on a verified spare
   port and give them that link. Merging is step 6, after they approve.
2. **What they should see** — the specific observable result, concrete enough
   to be wrong: which element, which screen, what changed about it.
3. **Any caveat that would make it look broken** — restart needed, browser
   hard-reload, Chrome's favicon cache (it survives `Cache-Control: no-store`),
   or that the preview server dies with the session.

Never hand over a URL you have not just fetched *and confirmed is your own
server* — see *The port may not be yours* above. A `200` from the wrong process
is the easiest way to report success on work the user cannot actually see.
