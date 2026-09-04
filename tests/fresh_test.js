/* The "checked … ago" indicator, run against the JavaScript folio actually ships.

   Two clocks show in the Sessions rail. The "3m" on a row is Claude Code's -- when
   its hook last fired for that session. The label in the rail head is folio's --
   when this page last read those records. Before the label existed the two were
   indistinguishable, and a paused poll (typing, dragging, a menu open) looked
   like a page that had simply gone quiet. The label logic is pulled out of
   static/app.js and run here with the DOM stubbed to a few globals. */
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
const pollMs = Number((APP.match(/^const POLL_MS = (\d+);/m) || [])[1]);
assert.ok(pollMs > 0, 'POLL_MS is declared');

// ---------------------------------------------------------------- the page, stubbed
const stubs = { hidden: false, editing: false, ptr: null, sdrag: null, popEl: null, scrim: null, toastShown: false, canRefresh: true };
let POLLS = 0, RENDERS = 0;
globalThis.document = { get hidden() { return stubs.hidden; } };
globalThis.isEditing = () => stubs.editing;
Object.defineProperty(globalThis, 'ptr', { get: () => stubs.ptr });
Object.defineProperty(globalThis, 'sdrag', { get: () => stubs.sdrag });
Object.defineProperty(globalThis, 'popEl', { get: () => stubs.popEl });
globalThis.$ = sel => sel === '#toast' ? { classList: { contains: c => c === 'show' && stubs.toastShown } } : sel === '.scrim' ? stubs.scrim : null;
globalThis.canRefresh = () => stubs.canRefresh;
globalThis.poll = () => { POLLS++; globalThis.UI.FRESH.tried = Date.now(); };
globalThis.renderFresh = () => { RENDERS++; };

vm.runInThisContext(
  `const POLL_MS = ${pollMs};\n`
  + between('function ageText(', 'function shortPath(')
  + between('const agoText =', 'function ancestors(')
  + between('// ------------------------------------------------------------------ freshness', 'function renderFresh()')
  + between('function tick()', '// mutation helper')
  + '\n;globalThis.UI = { FRESH, freshLabel, pauseReason, tick, pollNow, agoText, agoTip };\n',
  { filename: 'app.js-extract' },
);
const { FRESH, freshLabel, pauseReason, tick, pollNow, agoText, agoTip } = globalThis.UI;
const NOW = 1_800_000_000_000;

// ---------------------------------------------------------------- the label
// Nothing read yet: say so, do not invent an age.
let l = freshLabel({ at: 0, tried: 0, error: null }, NOW, null);
assert.equal(l.text, 'checking…'); assert.equal(l.cls, '');

// The normal case: a fresh read, counted in seconds so the tick is visible.
l = freshLabel({ at: NOW - 900, tried: NOW - 900, error: null }, NOW, null);
assert.equal(l.text, 'checked just now');
l = freshLabel({ at: NOW - 12_000, tried: NOW - 12_000, error: null }, NOW, null);
assert.equal(l.text, 'checked 12s ago'); assert.equal(l.cls, '');
assert.ok(l.title.includes(`every ${pollMs / 1000}s`), `the tooltip states the cadence: ${l.title}`);
assert.ok(l.title.includes('Claude Code last reported activity'), 'and explains the other clock on the rows');

// Past a minute the label falls back to the coarse ages the rows use.
l = freshLabel({ at: NOW - 130_000, tried: NOW - 1000, error: null }, NOW, null);
assert.equal(l.text, 'checked 2m ago');

// Paused: the label says so, keeps the age, and names the reason in the tooltip.
l = freshLabel({ at: NOW - 40_000, tried: NOW - 40_000, error: null }, NOW, 'you are typing');
assert.equal(l.cls, 'paused'); assert.equal(l.text, 'paused · checked 40s ago');
assert.ok(l.title.includes('you are typing') && l.title.includes('resumes on its own'), l.title);

// The server is gone: the last successful read stays visible, and the error is in the tooltip.
l = freshLabel({ at: NOW - 130_000, tried: NOW - 2000, error: 'Failed to fetch' }, NOW, 'you are typing');
assert.equal(l.cls, 'err', 'an error outranks a pause');
assert.equal(l.text, 'unreachable · 2m ago', 'short enough for the rail head; the age is when it was last reached');
assert.ok(l.title.includes('last successful read, 2m ago'), l.title);
assert.ok(l.title.includes('Failed to fetch') && l.title.includes('retry'), l.title);
l = freshLabel({ at: 0, tried: NOW, error: 'Failed to fetch' }, NOW, null);
assert.equal(l.text, 'server unreachable', 'never read and cannot read: no age to show');

// ---------------------------------------------------------------- why it paused
assert.equal(pauseReason(), null, 'nothing in the way: not paused');
stubs.editing = true; assert.equal(pauseReason(), 'you are typing'); stubs.editing = false;
stubs.ptr = {}; assert.equal(pauseReason(), 'you are dragging'); stubs.ptr = null;
stubs.sdrag = {}; assert.equal(pauseReason(), 'you are dragging'); stubs.sdrag = null;
stubs.popEl = {}; assert.equal(pauseReason(), 'a menu or dialog is open'); stubs.popEl = null;
stubs.scrim = {}; assert.equal(pauseReason(), 'a menu or dialog is open'); stubs.scrim = null;
stubs.toastShown = true; assert.equal(pauseReason(), 'a message is showing'); stubs.toastShown = false;
stubs.hidden = true; assert.equal(pauseReason(), 'this tab is in the background'); stubs.hidden = false;

// ---------------------------------------------------------------- the ticker
// One ticker does both jobs: it polls when a read is due and safe, and otherwise only redraws the label.
FRESH.at = 0; FRESH.tried = 0; FRESH.error = null;
tick(); assert.equal(POLLS, 1, 'the first tick reads at once');
tick(); assert.equal(POLLS, 1, 'a second later nothing is due'); assert.equal(RENDERS, 1, 'but the label still advances');
FRESH.tried = Date.now() - pollMs; tick(); assert.equal(POLLS, 2, 'a read is due once the interval has passed');
FRESH.tried = Date.now() - pollMs; stubs.canRefresh = false; tick(); assert.equal(POLLS, 2, 'not while it is unsafe'); assert.equal(RENDERS, 2, 'the label keeps ticking through a pause');
stubs.canRefresh = true;
FRESH.tried = Date.now(); pollNow(); assert.equal(POLLS, 3, 'coming back to the tab does not wait out the interval');

// ---------------------------------------------------------------- the other clock, labelled as such
assert.equal(agoText(null), 'no activity seen');
assert.equal(agoText(new Date(Date.now() - 10_000).toISOString()), 'active just now', 'the row age is prefixed so it cannot read as folio\'s');
assert.equal(agoText(new Date(Date.now() - 3 * 60_000).toISOString()), 'active 3m ago');
let tip = agoTip({ updated: new Date(Date.now() - 3 * 60_000).toISOString(), lastEvent: 'Stop' });
assert.ok(tip.includes('Claude Code last reported activity 3m ago (Stop)'), tip);
assert.ok(tip.includes("Claude's clock, not folio's") && tip.includes(`every ${pollMs / 1000}s`), tip);
tip = agoTip({ updated: null });
assert.ok(tip.includes('hook'), `no record at all points at the hook: ${tip}`);

console.log('freshness assertions passed');
