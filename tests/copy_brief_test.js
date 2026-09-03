/* Copy for Claude, run against the JavaScript folio actually ships.

   The page asks the server for the brief and puts it on the clipboard. When the
   browser refuses -- the clipboard API needs permission and a live user gesture,
   and Safari lets the gesture expire while the fetch is in flight -- the text has
   to be handed over some other way: shown, selected, one ⌘C from done. Both paths
   are pulled out of static/app.js and run against a DOM stub. */
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

// ---------------------------------------------------------------- the DOM stub
const listeners = {};
function element(tag) {
  const e = {
    nodeType: 1, tagName: tag.toUpperCase(), children: [], attrs: {}, style: {}, className: '', value: '', parent: null, on: {},
    selected: false, focused: false,
    get textContent() { return e.children.map(c => c.textContent).join(''); },
    classList: {
      list: () => e.className.split(/\s+/).filter(Boolean),
      add(...c) { e.className = [...new Set([...this.list(), ...c])].join(' '); },
      remove(...c) { e.className = this.list().filter(x => !c.includes(x)).join(' '); },
      contains(c) { return this.list().includes(c); },
    },
    setAttribute(k, v) { e.attrs[k] = v; },
    append(...kids) { for (const k of kids) { k.parent = e; e.children.push(k); } },
    appendChild(k) { e.append(k); return k; },
    remove() { if (e.parent) e.parent.children = e.parent.children.filter(c => c !== e); e.parent = null; },
    addEventListener(t, fn) { (e.on[t] = e.on[t] || []).push(fn); },
    dispatchEvent(ev) { for (const fn of e.on[ev.type] || []) fn({ target: e, preventDefault() {}, stopPropagation() {}, ...ev }); },
    focus() { e.focused = true; globalThis.document.activeElement = e; },
    select() { e.selected = true; },
  };
  return e;
}
globalThis.document = {
  body: element('body'), activeElement: null, createElement: element,
  createTextNode: s => ({ nodeType: 3, textContent: s, children: [] }),
  addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter(f => f !== fn); },
};
globalThis.requestAnimationFrame = fn => fn();
const press = key => (listeners.keydown || []).slice().forEach(fn => fn({ key, preventDefault() {}, stopPropagation() {} }));
const inBody = cls => globalThis.document.body.children.find(c => c.classList.contains(cls));
const find = (root, pred) => { let hit = null; (function walk(n) { for (const c of n.children) { if (c.nodeType === 1) { if (!hit && pred(c)) hit = c; walk(c); } } })(root); return hit; };
const tick = () => new Promise(r => setImmediate(r));

// ---------------------------------------------------------------- the app stub
const REQUESTS = [], TOASTS = [], ERRORS = [], FLASHED = [];
let clipboard = [], clipboardBroken = false, briefFails = false;
globalThis.api = (method, url) => {
  REQUESTS.push([method, url]);
  return briefFails ? Promise.reject(new Error('item not found')) : Promise.resolve({ id: 'a1', name: 'Rerank', text: 'folio card “Rerank”\nid: a1 · status: idea · in: Ranking\n\n## Notes\nhello\n' });
};
globalThis.toast = msg => { TOASTS.push(msg); };
globalThis.toastError = e => { ERRORS.push(e.message); };
globalThis.flashCard = id => { FLASHED.push(id); };
// node 21+ ships a read-only `navigator` global; define over it rather than assign
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: t => clipboardBroken ? Promise.reject(new Error('NotAllowedError')) : (clipboard.push(t), Promise.resolve()) } } });

vm.runInThisContext(
  between('function h(tag,', 'const chevron =')
  + between('copy for Claude', '// ------------------------------------------------------------------ derived')
  + '\n;globalThis.UI = { copyBrief, showBriefToCopy };\n',
  { filename: 'app.js-extract' },
);
const { copyBrief } = globalThis.UI;
const CARD = { id: 'a1', name: 'Rerank' };

// ---------------------------------------------------------------- assertions
(async function run() {
  // The happy path: one GET, the server's text lands on the clipboard verbatim, the card says so.
  await copyBrief(CARD);
  assert.deepEqual(REQUESTS, [['GET', '/api/items/a1/brief']]);
  assert.equal(clipboard.length, 1);
  assert.ok(clipboard[0].startsWith('folio card “Rerank”'), 'the clipboard gets the server\'s block, untouched');
  assert.ok(clipboard[0].includes('## Notes\nhello'));
  assert.equal(TOASTS.length, 1);
  assert.ok(TOASTS[0].includes('Rerank') && TOASTS[0].toLowerCase().includes('paste'), `the toast names the card and says what to do: ${TOASTS[0]}`);
  assert.deepEqual(FLASHED, ['a1']);
  assert.ok(!inBody('scrim'), 'no dialog when the clipboard worked');

  // An id with characters that mean something in a URL is encoded, not spliced in.
  await copyBrief({ id: 'a/b?c', name: 'Odd' });
  assert.equal(REQUESTS[1][1], '/api/items/a%2Fb%3Fc/brief');

  // The server said no: an error toast, nothing on the clipboard, no dialog.
  briefFails = true; clipboard = [];
  await copyBrief(CARD);
  assert.deepEqual(ERRORS, ['item not found']);
  assert.equal(clipboard.length, 0);
  assert.ok(!inBody('scrim'));
  briefFails = false;

  // The browser said no: the text is shown, selected and focused, so ⌘C finishes the job.
  clipboardBroken = true;
  const toastsBefore = TOASTS.length;
  await copyBrief(CARD);
  await tick();
  const scrim = inBody('scrim');
  assert.ok(scrim, 'a refused clipboard write opens the fallback');
  const box = find(scrim, e => e.tagName === 'TEXTAREA');
  assert.ok(box, 'the fallback holds the text in a textarea');
  assert.equal(box.value, (await globalThis.api('GET', '/x')).text);
  assert.equal(box.attrs.readonly, '', 'read-only: it is for copying, not editing');
  assert.ok(box.focused && box.selected, 'focused and selected -- one keystroke from copied');
  assert.equal(globalThis.document.activeElement, box);
  assert.ok(scrim.children[0].textContent.includes('Rerank'), 'the dialog names the card');
  assert.ok(scrim.children[0].textContent.includes('⌘C'), 'and tells you the keystroke');
  assert.equal(TOASTS.length, toastsBefore, 'no "Copied" toast for something that was not copied');

  // Escape closes it; so does Done; so does clicking outside.
  press('Escape');
  assert.ok(!inBody('scrim'), 'Escape closes the fallback');
  await copyBrief(CARD); await tick();
  find(inBody('scrim'), e => e.tagName === 'BUTTON').dispatchEvent({ type: 'click' });
  assert.ok(!inBody('scrim'), 'Done closes the fallback');
  await copyBrief(CARD); await tick();
  const s3 = inBody('scrim');
  s3.dispatchEvent({ type: 'pointerdown', target: s3 });
  assert.ok(!inBody('scrim'), 'a click on the scrim closes the fallback');

  console.log('copy-brief assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
