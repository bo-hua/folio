/* Snoozing an attention, run against the JavaScript folio actually ships.

   A finished turn needs you and says so on every card it sits on. Once you have read it
   and know you are not getting to it now, the ring is noise on top of the cards that do
   need you -- so it can be silenced for an hour, three, or a day. The session does not
   change: it stays `needs_you`, the rail still lists it and says how long is left. What
   changes is the counting -- the roll-up, the pill, the jump-to-next, which rows the
   Needs you list shows -- and that is all pulled out of static/app.js and run here with
   the page stubbed to what these pieces touch. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const APP = fs.readFileSync(path.join(__dirname, '..', 'folio', 'static', 'app.js'), 'utf8');
const lineWith = label => {
  const i = APP.indexOf(label);
  assert.ok(i > 0, `landmark missing from app.js: ${label}`);
  return APP.lastIndexOf('\n', i) + 1;                    // whole lines, so comments stay comments
};
const between = (from, to) => APP.slice(lineWith(from), lineWith(to));

// ---------------------------------------------------------------- the page, stubbed
// Only what the snooze pieces touch: a request recorder, the mutate helper's options (the
// toast and its Undo), and enough of a DOM for the menu to be built, placed and clicked.
const CALLS = [], TOASTS = [];
globalThis.api = (method, url, body) => { CALLS.push({ method, url, body }); return Promise.resolve({}); };
globalThis.mutate = (fn, opts) => { TOASTS.push(opts); return Promise.resolve(fn()); };
globalThis.$$ = () => [];

function element(tag) {
  const e = {
    nodeType: 1, tagName: tag.toUpperCase(), children: [], attrs: {}, style: {}, className: '', parent: null, on: {},
    get textContent() { return e.children.map(c => c.textContent).join(''); },
    classList: {
      list: () => e.className.split(/\s+/).filter(Boolean),
      add(...c) { e.className = [...new Set([...this.list(), ...c])].join(' '); },
      remove(...c) { e.className = this.list().filter(x => !c.includes(x)).join(' '); },
      contains(c) { return this.list().includes(c); },
    },
    setAttribute(k, v) { e.attrs[k] = v; },
    getAttribute(k) { return k in e.attrs ? e.attrs[k] : null; },
    append(...kids) { for (const k of kids) { k.parent = e; e.children.push(k); } },
    appendChild(k) { e.append(k); return k; },
    remove() { if (e.parent) e.parent.children = e.parent.children.filter(c => c !== e); e.parent = null; },
    contains(x) { return x === e || e.children.some(c => c.nodeType === 1 && c.contains(x)); },
    addEventListener(t, fn) { (e.on[t] = e.on[t] || []).push(fn); },
    dispatchEvent(ev) { for (const fn of e.on[ev.type] || []) fn({ target: e, currentTarget: e, preventDefault() {}, stopPropagation() {}, ...ev }); },
    getBoundingClientRect: () => ({ left: 100, right: 126, top: 40, bottom: 66, width: 26, height: 26 }),
  };
  return e;
}
globalThis.document = {
  body: element('body'),
  createElement: element,
  createTextNode: t => ({ nodeType: 3, textContent: String(t) }),
  createElementNS: () => { const e = element('svg'); e.innerHTML = ''; return e; },
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = { innerWidth: 1400, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
const inBody = cls => globalThis.document.body.children.find(c => c.classList.contains(cls));
const buttons = el => el.children.filter(c => c.tagName === 'BUTTON');

vm.runInThisContext(
  'let CARDS = [], SESSIONS = [], VISIBLE = null; const collapsed = new Set();\n'
  + between('function h(tag,', 'const chevron =')
  + between('function ageText(', 'function shortPath(')
  + between('const isVisible =', 'function computeVisible()')
  + between('const cardById =', 'const sessTip =')
  + between('const railVisible =', 'const hiddenCount =')
  + between('function attn(id)', 'function lifecycleWhy(')
  + between('// Snoozing: the same shape as hiding', '// The button at the end of an unattached row')
  + between('let popKey = null', 'function openAreaMenu(')
  + between('// How long to stay quiet', '// What deleting an Area actually costs')
  + '\n;globalThis.UI = { set(c, s) { CARDS = c; SESSIONS = s; }, coll: collapsed, SNOOZE_OPTS, needy, snoozed, snoozeText,'
  + ' attn, attnSessions, standsIn, areaAttn, needsYouCount, snoozedCount, needsYouCards, railRows, snoozeSessions, openSnoozeMenu };\n',
  { filename: 'app.js-extract' },
);
const U = globalThis.UI;

// One area, a parent with a child, and an unrelated card. Three sessions need you: one on
// the parent, snoozed for an hour; one on the child, still ringing; one on the third card,
// snoozed for three hours. The clock is this process's, as it is in the browser.
const mins = m => new Date(Date.now() + m * 60000).toISOString();
const A = { id: 'A', name: 'Survey', parent: null, area: 'Work', lifecycle: 'active' };
const B = { id: 'B', name: 'Prototype', parent: 'A', area: 'Work', lifecycle: 'active' };
const C = { id: 'C', name: 'Write-up', parent: null, area: 'Work', lifecycle: 'active' };
const zzA = { id: 'zzA', short: 'zzA', title: 'the sweep', state: 'needs_you', snoozed: true, snoozeUntil: mins(57), items: ['A'] };
const hot = { id: 'hot', short: 'hot', title: 'the rerun', state: 'needs_you', snoozed: false, snoozeUntil: null, items: ['B'] };
const zzC = { id: 'zzC', short: 'zzC', title: 'the memo', state: 'needs_you', snoozed: true, snoozeUntil: mins(179), items: ['C'] };
const busy = { id: 'busy', short: 'busy', title: 'still going', state: 'working', items: ['C'] };
U.set([A, B, C], [zzA, hot, zzC, busy]);
const ids = xs => xs.map(x => x.id);

// ---------------------------------------------------------------- what a snooze is
assert.equal(U.snoozed(zzA), true);
assert.equal(U.needy(zzA), false, 'a snoozed session is not counted as needing you');
assert.equal(U.needy(hot), true);
assert.equal(U.snoozed(hot), false);
assert.equal(U.needy(busy), false, 'and working is not needing you either way');
// the page trusts the server's word, not its own arithmetic on the clock
assert.equal(U.needy({ state: 'needs_you', snoozed: true, snoozeUntil: mins(-99) }), false,
  'the server decides when the quiet ends -- an expired stamp with the flag still set stays quiet');
assert.equal(U.needy({ state: 'needs_you' }), true, 'and a row with no snooze at all needs you');
assert.equal(U.snoozeText(zzA), '57m');
assert.equal(U.snoozeText([zzA, zzC]), '57m', 'for a group: when the first of them starts ringing again');

// ---------------------------------------------------------------- the roll-up
let a = U.attn('A');
assert.deepEqual([a.needs, a.snoozed], [1, 1], 'the child still rings; the card`s own session is quiet');
assert.deepEqual([a.ownNeeds, a.ownSnoozed], [0, 1], 'and it says which of them is its own');
assert.deepEqual([a.descNeeds, a.descSnoozed], [1, 0]);
a = U.attn('C');
assert.deepEqual([a.needs, a.snoozed, a.working], [0, 1, 1], 'a card with only a snoozed session does not ring');
// the area header and the page's pill count sessions the same way
assert.deepEqual(U.areaAttn({ id: 'Work' }), { needs: 1, working: 1, snoozed: 2 });
assert.equal(U.needsYouCount(), 1, 'the pill counts what is still asking for you');
assert.equal(U.snoozedCount(), 2, '...and says how many are waiting quietly');
assert.deepEqual(ids(U.needsYouCards()), ['B'], 'J jumps past a snoozed card, not to it');

// silence the last one and the board goes quiet without anything being lost
U.set([A, B, C], [zzA, { ...hot, snoozed: true, snoozeUntil: mins(1440) }, zzC, busy]);
assert.equal(U.needsYouCount(), 0);
assert.equal(U.snoozedCount(), 3);
assert.deepEqual(U.needsYouCards(), []);
assert.equal(U.attn('A').needs, 0, 'no card rings');
U.set([A, B, C], [zzA, hot, zzC, busy]);

// ---------------------------------------------------------------- who a card's snooze covers
// Expanded, a card owns its own sessions: snoozing "Survey" must not silence the child's.
assert.deepEqual(ids(U.attnSessions('A', U.needy)), [], 'the ringing session is the child`s, not Survey`s');
assert.deepEqual(ids(U.attnSessions('A', U.snoozed)), ['zzA']);
assert.deepEqual(ids(U.attnSessions('B', U.needy)), ['hot']);
// Collapsed, the parent is the only thing on screen and its ring is the child's ring, so the
// button under that ring has to reach the child's session too.
assert.equal(U.standsIn('A'), false);
U.coll.add('A');
assert.equal(U.standsIn('A'), true);
assert.deepEqual(ids(U.attnSessions('A', U.needy)), ['hot'], 'a collapsed parent snoozes what is inside it');
assert.deepEqual(ids(U.attnSessions('A', U.snoozed)), ['zzA']);
U.coll.delete('A');
// the inspector counts the whole subtree whatever the canvas is doing, so it asks outright
assert.deepEqual(ids(U.attnSessions('A', U.needy, true)), ['hot']);
assert.deepEqual(ids(U.attnSessions('A', U.needy, false)), []);

// ---------------------------------------------------------------- which rows Needs you shows
const ALL = [zzA, hot, zzC, busy];
let r = U.railRows(ALL, 'attention', false);
assert.deepEqual(ids(r.rows), ['hot'], 'Needs you leaves out what you snoozed');
assert.equal(r.tucked, 2, 'and counts them, so the line under the list can offer them back');
r = U.railRows(ALL, 'attention', true);
assert.deepEqual(ids(r.rows), ['zzA', 'hot', 'zzC'], 'asked for them, the snoozed ones come back');
assert.equal(r.tucked, 2);
assert.deepEqual(ids(U.railRows(ALL, 'all', false).rows), ['zzA', 'hot', 'zzC', 'busy'], 'All shows everything, snoozed or not');
assert.equal(U.railRows(ALL, 'all', false).tucked, 0);

// ---------------------------------------------------------------- what the API is asked
const reset = () => { CALLS.length = 0; TOASTS.length = 0; };
(async function run() {
  reset();
  await U.snoozeSessions([hot], 180);
  assert.deepEqual(CALLS, [{ method: 'POST', url: '/api/sessions/snooze', body: { session_ids: ['hot'], minutes: 180 } }]);
  assert.ok(TOASTS[0].msg.includes('Snoozed “the rerun” for 3 hours') && TOASTS[0].msg.includes('still needs you'), TOASTS[0].msg);
  const undo = TOASTS[0].undo;
  reset();
  await undo();
  assert.deepEqual(CALLS, [{ method: 'POST', url: '/api/sessions/snooze', body: { session_ids: ['hot'], minutes: 0 } }],
    'Undo wakes it: 0 minutes');

  // a card's worth of sessions is one request, so it is one Undo
  reset();
  await U.snoozeSessions([zzA, hot], 60);
  assert.deepEqual(CALLS, [{ method: 'POST', url: '/api/sessions/snooze', body: { session_ids: ['zzA', 'hot'], minutes: 60 } }]);
  assert.ok(TOASTS[0].msg.startsWith('Snoozed 2 sessions for 1 hour'), TOASTS[0].msg);

  // waking is offered no Undo -- it takes a fresh choice of how long, and the menu is right there
  reset();
  await U.snoozeSessions([zzA], 0);
  assert.deepEqual(CALLS[0].body, { session_ids: ['zzA'], minutes: 0 });
  assert.equal(TOASTS[0].msg, 'Woke “the sweep”');
  assert.equal(TOASTS[0].undo, null);

  // nothing to snooze: no request at all
  reset();
  await U.snoozeSessions([], 60);
  assert.deepEqual(CALLS, []);

  // ---------------------------------------------------------------- the menu
  // Three lengths, in order, and the answer to "not now" is never a way to lose the session:
  // the menu says so in as many words.
  assert.deepEqual(U.SNOOZE_OPTS, [['1 hour', 60], ['3 hours', 180], ['1 day', 1440]]);
  const btn = element('button');
  U.openSnoozeMenu(btn, [hot]);
  const pop = inBody('pop');
  assert.ok(pop, 'the crescent opens a menu');
  assert.ok(pop.children[0].textContent.includes('“the rerun”'), 'named, so it is clear what goes quiet');
  assert.deepEqual(buttons(pop).map(b => b.textContent), ['1 hour', '3 hours', '1 day']);
  assert.ok(pop.textContent.includes('It still needs you'), 'and says the session is not being dismissed');
  reset();
  buttons(pop)[1].dispatchEvent({ type: 'click' });
  assert.deepEqual(CALLS[0].body, { session_ids: ['hot'], minutes: 180 }, 'the middle length is 3 hours');
  assert.ok(!inBody('pop'), 'and choosing closes it');

  U.openSnoozeMenu(btn, [hot]);
  assert.ok(inBody('pop') && btn.classList.contains('open'));
  U.openSnoozeMenu(btn, [hot]);
  assert.ok(!inBody('pop'), 'the same button toggles it shut');
  assert.ok(!btn.classList.contains('open'), 'and the button stops looking open');
  U.openSnoozeMenu(btn, []);
  assert.ok(!inBody('pop'), 'nothing to snooze opens nothing');

  console.log('snooze assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
