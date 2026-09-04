/* The inspector keeps its scroll position across a redraw, run against the JavaScript
   folio actually ships.

   The poll rebuilds the card panel every few seconds: `.ins-body` is a new element,
   and the notes box -- the one node kept across renders -- is out of the document
   for a moment, which resets its own scroll. Reading a long note, you were thrown
   back to its first line on every refresh. keepScroll() is pulled out of
   static/app.js and run here against a hand-rolled DOM: a tree of nodes with a
   class, a scrollTop, and querySelector / querySelectorAll for the two shapes the
   code uses ('.class' and '*'). */
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

// ---------------------------------------------------------------- a DOM the size of the problem
function node(cls, ...kids) {
  const n = {
    className: cls, scrollTop: 0, isConnected: true, kids,
    all() { return n.kids.flatMap(k => [k, ...k.all()]); },
    querySelector(sel) { assert.ok(sel.startsWith('.'), `only class selectors here: ${sel}`); return n.all().find(k => k.className === sel.slice(1)) || null; },
    querySelectorAll(sel) { assert.equal(sel, '*', `only '*' here: ${sel}`); return n.all(); },
  };
  return n;
}
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

vm.runInThisContext(
  between('const $ = (s, r = document)', 'function h(tag')
  + between('/* The poll redraws this panel every few seconds', '// ------------------------------------------------------------------ notes editor')
  + '\n;globalThis.UI = { keepScroll, setShown: v => { insShown = v; }, shown: () => insShown };\n',
  { filename: 'app.js-extract' },
);
const { keepScroll, setShown, shown } = globalThis.UI;

// The inspector as drawn: a body you scrolled down, and inside it the notes box,
// scrolled further, plus a session row that is not scrolled at all.
const doc = node('md-doc');
const editor = node('md-editor', doc, node('md-hint'));
const sess = node('ins-sess');
let body = node('ins-body', node('sec', sess), node('sec', editor));
const ins = node('inspector', node('ins-head'), body);

// ---------------------------------------------------------------- first draw of a card: nothing to keep
body.scrollTop = 420; doc.scrollTop = 77;
let restore = keepScroll(ins, 'card-a');
assert.equal(shown(), 'card-a', 'the inspector now remembers which card it drew');
let fresh = node('ins-body', node('sec', sess), node('sec', editor));
ins.kids = [node('ins-head'), fresh]; doc.scrollTop = 0;   // what a rebuild does: new body, notes box back at 0 after its detour out of the document
restore();
assert.equal(fresh.scrollTop, 0, 'a card just opened starts at the top');
assert.equal(doc.scrollTop, 0, 'and so does its notes box');

// ---------------------------------------------------------------- a redraw of the same card: the poll must not move you
body = fresh; body.scrollTop = 420; doc.scrollTop = 77;
restore = keepScroll(ins, 'card-a');
fresh = node('ins-body', node('sec', sess), node('sec', editor));
ins.kids = [node('ins-head'), fresh]; doc.scrollTop = 0;
restore();
assert.equal(fresh.scrollTop, 420, 'the panel body is back where you had scrolled it');
assert.equal(doc.scrollTop, 77, 'the notes box is back where you were reading');
assert.equal(sess.scrollTop, 0, 'what was not scrolled is not touched');

// ---------------------------------------------------------------- a node that did not come back is left alone
body = fresh; body.scrollTop = 300; doc.scrollTop = 50;
restore = keepScroll(ins, 'card-a');
fresh = node('ins-body', node('sec', sess));   // the notes box is gone this time (say the detail has not loaded yet)
ins.kids = [node('ins-head'), fresh]; doc.isConnected = false; doc.scrollTop = 0;
assert.doesNotThrow(restore);
assert.equal(fresh.scrollTop, 300);
assert.equal(doc.scrollTop, 0, 'a detached node is not written to');
doc.isConnected = true;

// ---------------------------------------------------------------- another card: start at the top, whatever the last one was at
body = fresh; body.scrollTop = 300;
restore = keepScroll(ins, 'card-b');
assert.equal(shown(), 'card-b');
fresh = node('ins-body', node('sec', sess), node('sec', editor));
ins.kids = [node('ins-head'), fresh];
restore();
assert.equal(fresh.scrollTop, 0, 'a different card is not scrolled to where the previous one was');

// ---------------------------------------------------------------- closed and reopened: renderInspector forgets the card, so it starts at the top
body = fresh; body.scrollTop = 200;
setShown(null);   // what the !c branch of renderInspector does when the panel closes
restore = keepScroll(ins, 'card-b');
fresh = node('ins-body', node('sec', sess), node('sec', editor));
ins.kids = [node('ins-head'), fresh];
restore();
assert.equal(fresh.scrollTop, 0, 'reopening a card is a fresh look at it');

// ---------------------------------------------------------------- the wiring in renderInspector itself
const ri = between('function renderInspector()', '/* The poll redraws this panel every few seconds');
assert.ok(ri.includes("insShown = null; return; }"), 'closing the panel forgets the card');
assert.ok(ri.includes('const restoreScroll = keepScroll(ins, c.id);'), 'the position is read before the panel is wiped');
assert.ok(ri.indexOf('keepScroll(ins, c.id)') < ri.indexOf("ins.innerHTML = ''"), '…and before innerHTML is cleared');
assert.ok(ri.trimEnd().endsWith('restoreScroll();\n}'), 'and put back as the last thing the redraw does');

console.log('inspector scroll assertions passed');
