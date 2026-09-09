/* A session on several cards, run against the JavaScript folio actually ships.

   A session used to belong to one card: attaching it elsewhere moved it. One piece
   of work spans cards -- the survey and the prototype it led to, a parent and the
   child it is really about -- so a session now carries the list of cards it is on,
   and the board has two gestures: a rail row onto a card *adds* it there, a chip
   (its place on one card) onto another card *moves* it from that card. The pure
   pieces -- which sessions a card has, the attention roll-up, which rows the filter
   keeps, what a drop does, and what the API is asked -- are pulled out of
   static/app.js and run here with the page stubbed to a few globals. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const APP = fs.readFileSync(path.join(__dirname, '..', 'folio', 'static', 'app.js'), 'utf8');
const lineWith = label => {
  const i = APP.indexOf(label);
  assert.ok(i > 0, `landmark missing from app.js: ${label}`);
  return APP.lastIndexOf('\n', i) + 1;
};
const between = (from, to) => APP.slice(lineWith(from), lineWith(to));

// ---------------------------------------------------------------- the page, stubbed
const CALLS = [], TOASTS = [], HIDDEN = new Set();
globalThis.api = (method, url, body) => { CALLS.push({ method, url, body }); return Promise.resolve({}); };
globalThis.mutate = (fn, opts) => { TOASTS.push(opts); return Promise.resolve(fn()); };
globalThis.flashCard = () => {};
globalThis.isVisible = c => !HIDDEN.has(c.id);

vm.runInThisContext(
  'let CARDS = [], SESSIONS = [];\n'
  + between('const cardById =', 'const sessTip =')
  + between('const railVisible =', 'const hiddenCount =')
  + between('function attn(id)', 'function needsYouCards(')
  + between('const attachApi =', 'function setStatus(')
  + between('function sessDropTarget(', "const rail = $('#rail'); let sdrag")
  + '\n;globalThis.UI = { set(c, s) { CARDS = c; SESSIONS = s; }, sessOf, cardsOf, otherCardsOf, railVisible, railRows, attn, areaAttn, needsYouCount, attachSession, detachSession, sessDropTarget };\n',
  { filename: 'app.js-extract' },
);
const { set, sessOf, cardsOf, otherCardsOf, railVisible, railRows, attn, areaAttn, needsYouCount, attachSession, detachSession, sessDropTarget } = globalThis.UI;

// One area. A parent (Survey) with a child (Prototype), and an unrelated card. One session
// sits on both the parent and the child, one on the unrelated card, one on nothing yet.
const A = { id: 'A', name: 'Survey', parent: null, area: 'Work', lifecycle: 'active' };
const B = { id: 'B', name: 'Prototype', parent: 'A', area: 'Work', lifecycle: 'active' };
const C = { id: 'C', name: 'Write-up', parent: null, area: 'Work', lifecycle: 'active' };
const s1 = { id: 's1', short: 's1', title: 'the sweep', state: 'needs_you', items: ['A', 'B'] };
const s2 = { id: 's2', short: 's2', title: '', autoTitle: 'draft the memo', state: 'working', items: ['C'] };
const s3 = { id: 's3', short: 's3', title: '', autoTitle: '', state: 'ready', items: [] };
set([A, B, C], [s1, s2, s3]);
const ids = xs => xs.map(x => x.id);

// ---------------------------------------------------------------- which sessions a card has
assert.deepEqual(ids(sessOf('A')), ['s1']);
assert.deepEqual(ids(sessOf('B')), ['s1'], 'the same session shows on both cards it is on');
assert.deepEqual(ids(sessOf('C')), ['s2']);
assert.deepEqual(ids(cardsOf(s1)), ['A', 'B']);
assert.deepEqual(ids(otherCardsOf(s1, 'A')), ['B']);
assert.deepEqual(cardsOf({ items: ['A', 'gone'] }).map(c => c.id), ['A'], 'a card the page does not know is skipped, not a crash');

// ---------------------------------------------------------------- the attention roll-up
// s1 needs you and sits on Survey *and* its child: that is one session needing you, not two.
let a = attn('A');
assert.equal(a.needs, 1, 'a session on a card and its child is counted once');
assert.equal(a.ownNeeds, 1); assert.equal(a.descNeeds, 0);
a = attn('B'); assert.equal(a.needs, 1); assert.equal(a.ownNeeds, 1);
a = attn('C'); assert.equal(a.working, 1); assert.equal(a.needs, 0);
// the area header and the page's pill count sessions the same way: one needs you, one is working
assert.deepEqual(areaAttn({ id: 'Work' }), { needs: 1, working: 1 });
assert.equal(needsYouCount(), 1, 'the pill says "1 needs you", not one per card the session is on');
set([A, B, C], [{ ...s1, items: ['A', 'C'] }, s2, s3]); // the same session on two *top-level* cards
assert.deepEqual(areaAttn({ id: 'Work' }), { needs: 1, working: 1 }, 'still one, across separate trees');
set([A, B, C], [s1, s2, s3]);

// ---------------------------------------------------------------- which rows the filter keeps
assert.ok(railVisible(s1) && railVisible(s2) && railVisible(s3));
HIDDEN.add('B');
assert.ok(railVisible(s1), 'the row stays while any of its cards is visible');
HIDDEN.add('A');
assert.ok(!railVisible(s1), 'the row goes only when every card it is on is hidden');
assert.ok(railVisible(s3), 'an unattached row has no card to follow, so it always stays');
HIDDEN.clear();

// ---------------------------------------------------------------- hiding, and Unattached
// Unattached lists sessions on no card, and most never get one, so it silts up. Hiding a row
// takes it out of that list and nothing else -- All still has it, and the count of what was
// hidden puts them all back on screen.
const s4 = { id: 's4', short: 's4', title: '', autoTitle: 'a one-off', state: 'ended', items: [], hidden: true };
const ALL = [s1, s2, s3, s4];
assert.deepEqual(ids(railRows(ALL, 'all', false).rows), ['s1', 's2', 's3', 's4'], 'All shows everything, hidden or not');
assert.equal(railRows(ALL, 'all', false).tucked, 0, 'nothing is dropped outside Unattached, so nothing to offer back');
let r = railRows(ALL, 'unattached', false);
assert.deepEqual(ids(r.rows), ['s3'], 'Unattached is what is on no card and not hidden');
assert.equal(r.tucked, 1, 'and says how many hiding took out');
r = railRows(ALL, 'unattached', true);
assert.deepEqual(ids(r.rows), ['s3', 's4'], 'asked for them, the hidden ones come back');
assert.equal(r.tucked, 1);
assert.deepEqual(ids(railRows(ALL, 'attention', false).rows), ['s1'], 'Needs you ignores hiding entirely');
const s5 = { ...s1, hidden: true };
assert.deepEqual(ids(railRows([s5, s3], 'unattached', false).rows), ['s3'], 'a hidden session on a card was never in this list');
assert.equal(railRows([s5, s3], 'unattached', false).tucked, 0, 'so it is not counted as one held back either');

// ---------------------------------------------------------------- what a drop does
const over = (o = {}) => ({ rail: false, stage: false, chrome: false, ...o });
let t = sessDropTarget(s1, null, 'C', over());
assert.deepEqual(t, { kind: 'card', id: 'C', label: 'Attach to “Write-up”' }, 'a rail row onto a new card attaches');
assert.equal(sessDropTarget(s1, null, 'A', over()), null, 'onto a card it is already on: nothing');
t = sessDropTarget(s1, 'A', 'C', over());
assert.deepEqual(t, { kind: 'card', id: 'C', label: 'Move to “Write-up”' }, 'a chip onto another card moves');
assert.equal(sessDropTarget(s1, 'A', 'B', over()), null, 'a chip onto a card it is already on: nothing');
t = sessDropTarget(s1, 'A', null, over({ stage: true }));
assert.deepEqual(t, { kind: 'detach', id: 'A', label: 'Release to detach from “Survey”' }, 'a chip onto empty canvas leaves its card only');
t = sessDropTarget(s1, null, null, over({ rail: true }));
assert.deepEqual(t, { kind: 'detach', id: null, label: 'Release to detach from all 2 cards' }, 'a rail row onto the rail leaves every card');
t = sessDropTarget(s2, null, null, over({ stage: true }));
assert.equal(t.label, 'Release to detach from “Write-up”', 'one card: named');
assert.equal(sessDropTarget(s3, null, null, over({ stage: true })), null, 'an unattached row has nothing to detach from');
assert.equal(sessDropTarget(s1, 'A', null, over({ stage: true, chrome: true })), null, 'over the inspector or controls: nothing');
assert.equal(sessDropTarget(s1, 'A', null, over()), null, 'off the page entirely: nothing');

// ---------------------------------------------------------------- what the API is asked
const reset = () => { CALLS.length = 0; TOASTS.length = 0; };
(async () => {
  // attach: adds to the new card, touches no other
  reset();
  await attachSession(s1, 'C');
  assert.deepEqual(CALLS, [{ method: 'POST', url: '/api/items/C/sessions', body: { session_id: 's1', title: 'the sweep' } }], 'no `from`: nothing is left behind');
  assert.ok(TOASTS[0].msg.includes('Attached “the sweep” to “Write-up”') && TOASTS[0].msg.includes('“Survey”, “Prototype” too'), TOASTS[0].msg);
  const undoAttach = TOASTS[0].undo; reset();
  await undoAttach();
  assert.deepEqual(CALLS, [{ method: 'DELETE', url: '/api/items/C/sessions/s1', body: undefined }], 'undo of an attach detaches from that card only');

  // a first attach says the card came alive
  reset();
  await attachSession(s3, 'C');
  assert.ok(TOASTS[0].msg.endsWith('— it’s now active'), TOASTS[0].msg);

  // move: one request, `from` names the card to leave
  reset();
  await attachSession(s1, 'C', 'A');
  assert.deepEqual(CALLS, [{ method: 'POST', url: '/api/items/C/sessions', body: { session_id: 's1', title: 'the sweep', from: 'A' } }]);
  assert.equal(TOASTS[0].msg, 'Moved “the sweep” from “Survey” to “Write-up”');
  const undoMove = TOASTS[0].undo; reset();
  await undoMove();
  assert.deepEqual(CALLS[0].body, { session_id: 's1', title: 'the sweep', from: 'C' }, 'undo moves it back the same way');
  assert.equal(CALLS[0].url, '/api/items/A/sessions');

  // detach from one card: the others keep it, and the toast says so
  reset();
  await detachSession(s1, 'A');
  assert.deepEqual(CALLS, [{ method: 'DELETE', url: '/api/items/A/sessions/s1', body: undefined }]);
  assert.equal(TOASTS[0].msg, 'Detached “the sweep” from “Survey” — still on “Prototype”');
  const undoDetach = TOASTS[0].undo; reset();
  await undoDetach();
  assert.deepEqual(CALLS, [{ method: 'POST', url: '/api/items/A/sessions', body: { session_id: 's1', title: 'the sweep' } }]);

  // detach from the last card it was on: back in the rail
  reset();
  await detachSession(s2, 'C');
  assert.equal(TOASTS[0].msg, 'Detached “draft the memo” from “Write-up” — it’s back in the rail');

  // a rail row dragged off the board: every card lets go, and undo puts them all back
  reset();
  await detachSession(s1);
  assert.deepEqual(CALLS.map(c => c.method + ' ' + c.url).sort(), ['DELETE /api/items/A/sessions/s1', 'DELETE /api/items/B/sessions/s1']);
  assert.equal(TOASTS[0].msg, 'Detached “the sweep” from 2 cards — it’s back in the rail');
  const undoAll = TOASTS[0].undo; reset();
  await undoAll();
  assert.deepEqual(CALLS.map(c => c.method + ' ' + c.url).sort(), ['POST /api/items/A/sessions', 'POST /api/items/B/sessions']);
  reset();
  await detachSession(s3);
  assert.deepEqual(CALLS, [], 'nothing attached, nothing to ask');

  console.log('multi-card session assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
