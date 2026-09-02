/* The Area delete guard, run against the JavaScript folio actually ships.

   Deleting an Area is irreversible on the server (rmtree, no undo), so the whole
   defence is in the browser: a menu that does not open onto the destructive item,
   and a dialog that stays inert until the Area's name is typed back. Both are
   pulled out of static/app.js -- nothing here is a copy -- and run against a DOM
   stub the size of what they touch. */
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

// ---------------------------------------------------------------- the DOM stub
const listeners = { document: {}, window: {} };
function element(tag) {
  const e = {
    nodeType: 1, tagName: tag.toUpperCase(), children: [], attrs: {}, style: {},
    className: '', value: '', disabled: false, parent: null, on: {},
    get textContent() { return e.children.map(c => c.textContent).join(''); },
    classList: {
      list: () => e.className.split(/\s+/).filter(Boolean),
      add(...c) { e.className = [...new Set([...this.list(), ...c])].join(' '); },
      remove(...c) { e.className = this.list().filter(x => !c.includes(x)).join(' '); },
      toggle(c, on) { on ? this.add(c) : this.remove(c); },
      contains(c) { return this.list().includes(c); },
    },
    setAttribute(k, v) { e.attrs[k] = v; if (k === 'disabled') e.disabled = true; },
    getAttribute(k) { return k in e.attrs ? e.attrs[k] : null; },
    append(...kids) { for (const k of kids) { k.parent = e; e.children.push(k); } },
    appendChild(k) { e.append(k); return k; },
    remove() { if (e.parent) e.parent.children = e.parent.children.filter(c => c !== e); e.parent = null; },
    contains(x) { return x === e || e.children.some(c => c.nodeType === 1 && c.contains(x)); },
    addEventListener(t, fn) { (e.on[t] = e.on[t] || []).push(fn); },
    dispatchEvent(ev) { for (const fn of e.on[ev.type] || []) fn({ target: e, preventDefault() {}, stopPropagation() {}, ...ev }); },
    querySelectorAll(sel) {
      const want = sel.split(',').map(s => s.trim());
      const hit = n => want.some(s => (s === 'input' && n.tagName === 'INPUT')
        || (s === 'button:not([disabled])' && n.tagName === 'BUTTON' && !n.disabled));
      const out = [];
      (function walk(n) { for (const c of n.children) if (c.nodeType === 1) { if (hit(c)) out.push(c); walk(c); } })(e);
      return out;
    },
    focus() { globalThis.document.activeElement = e; },
    getBoundingClientRect: () => ({ left: 100, right: 126, top: 40, bottom: 66, width: 26, height: 26 }),
  };
  return e;
}
globalThis.document = {
  body: element('body'),
  activeElement: null,
  createElement: element,
  createTextNode: s => ({ nodeType: 3, textContent: s, children: [] }),
  addEventListener(t, fn) { (listeners.document[t] = listeners.document[t] || []).push(fn); },
  removeEventListener(t, fn) { listeners.document[t] = (listeners.document[t] || []).filter(f => f !== fn); },
};
globalThis.window = {
  innerWidth: 1440, innerHeight: 900,
  addEventListener(t, fn) { (listeners.window[t] = listeners.window[t] || []).push(fn); },
  removeEventListener(t, fn) { listeners.window[t] = (listeners.window[t] || []).filter(f => f !== fn); },
};
globalThis.requestAnimationFrame = fn => fn();
const press = key => (listeners.document.keydown || []).slice().forEach(fn => fn({ key, preventDefault() {}, stopPropagation() {} }));
const inBody = cls => globalThis.document.body.children.find(c => c.classList.contains(cls));
const buttons = root => root.querySelectorAll('button:not([disabled])');
const tick = () => new Promise(r => setImmediate(r));

// ---------------------------------------------------------------- the app stub
const REQUESTS = [], NEW_CARDS = [];
globalThis.CARDS = [
  { id: 'a1', name: 'Rerank', area: 'Ranking', parent: null },
  { id: 'a2', name: 'Features', area: 'Ranking', parent: 'a1' },
  { id: 'b1', name: 'Notes', area: 'Inbox', parent: 'a1' },      // elsewhere, but hangs off a doomed card
  { id: 'b2', name: 'Loose', area: 'Inbox', parent: null },
];
globalThis.OV = { data_dir: '/Users/x/.cc-workspace' };
globalThis.AREAS = [{ id: 'Ranking', name: 'Ranking', count: 2 }, { id: 'Inbox', name: 'Inbox', count: 2 }];
globalThis.areaById = id => globalThis.AREAS.find(a => a.id === id);
globalThis.api = (method, url) => { REQUESTS.push([method, url]); return Promise.resolve({}); };
globalThis.mutate = run => Promise.resolve(run());
globalThis.newCard = spec => { NEW_CARDS.push(spec); };
globalThis.$$ = () => [];

vm.runInThisContext(
  between('function h(tag,', 'const chevron =')
  + between('area menu + type-to-confirm', 'clicks: canvas buttons')
  + '\n;globalThis.UI = { openAreaMenu, deleteArea, areaDamage, confirmMatches };\n',
  { filename: 'app.js-extract' },
);
const { openAreaMenu, deleteArea, areaDamage, confirmMatches } = globalThis.UI;
const RANKING = globalThis.areaById('Ranking');

// ---------------------------------------------------------------- assertions
(async function run() {
  // The gate is exact. Surrounding whitespace is forgiven; a near miss is not.
  assert.equal(confirmMatches('Ranking', 'Ranking'), true);
  assert.equal(confirmMatches('  Ranking\n', 'Ranking'), true);
  assert.equal(confirmMatches('ranking', 'Ranking'), false, 'case must matter');
  assert.equal(confirmMatches('Rank', 'Ranking'), false);
  assert.equal(confirmMatches('', 'Ranking'), false, 'an empty box never arms the button');
  assert.equal(confirmMatches('', ''), false);

  // The damage report counts what really goes, and what merely comes loose.
  const d = areaDamage(RANKING);
  assert.deepEqual([d.cards, d.orphaned], [2, 1]);
  assert.equal(d.dir, '/Users/x/.cc-workspace/items/Ranking');

  // The menu opens onto something harmless; the destructive item is last.
  const btn = element('button');
  openAreaMenu(btn, RANKING);
  const pop = inBody('pop');
  assert.ok(pop, 'the ⋯ opens a menu');
  const items = buttons(pop);
  assert.equal(items.length, 2);
  assert.equal(items[0].textContent, 'New idea in Ranking');
  assert.equal(items[items.length - 1].textContent, 'Delete this Area…');
  assert.ok(items[items.length - 1].classList.contains('harm'));
  items[0].dispatchEvent({ type: 'click' });                     // the harmless item works, and closes up
  assert.deepEqual(NEW_CARDS, [{ area: 'Ranking' }]);
  assert.ok(!inBody('pop'));
  openAreaMenu(btn, RANKING);
  openAreaMenu(btn, RANKING);                                    // the same button toggles it shut
  assert.ok(!inBody('pop'));
  openAreaMenu(btn, RANKING);
  press('Escape');
  assert.ok(!inBody('pop'), 'Escape closes the menu');
  assert.equal(REQUESTS.length, 0, 'opening and closing a menu deletes nothing');

  // Reaching the dialog deletes nothing, and the dialog names the damage.
  openAreaMenu(btn, RANKING);
  buttons(inBody('pop'))[1].dispatchEvent({ type: 'click' });
  await tick();
  const scrim = inBody('scrim');
  assert.ok(scrim, 'the delete item opens a dialog, not a request');
  assert.equal(REQUESTS.length, 0);
  const dlg = scrim.children[0];
  for (const want of ['Delete the Area “Ranking”?', '2 cards filed here', '1 card in other Areas',
    '/Users/x/.cc-workspace/items/Ranking', 'Nothing here can be undone', 'Type Ranking to confirm']) {
    assert.ok(dlg.textContent.includes(want), `the dialog should say: ${want}\n--- said ---\n${dlg.textContent}`);
  }
  const input = dlg.querySelectorAll('input')[0];
  const acts = dlg.children[dlg.children.length - 1];             // [Cancel, Delete]
  const go = acts.children[1];
  assert.equal(globalThis.document.activeElement, input, 'focus lands in the box, not on Delete');
  assert.equal(go.disabled, true, 'Delete starts dead');
  assert.equal(go.textContent, 'Delete this Area');

  // A wrong name keeps it dead, and Enter does nothing.
  input.value = 'ranking';
  input.dispatchEvent({ type: 'input' });
  assert.equal(go.disabled, true);
  assert.ok(!go.classList.contains('armed'));
  dlg.dispatchEvent({ type: 'submit' });
  await tick();
  assert.equal(REQUESTS.length, 0, 'Enter on a mistyped name must not delete');
  assert.ok(inBody('scrim'), 'and the dialog stays open');

  // Escape walks away clean, even with the right name typed.
  input.value = 'Ranking';
  input.dispatchEvent({ type: 'input' });
  assert.equal(go.disabled, false);
  assert.ok(go.classList.contains('armed'));
  press('Escape');
  await tick();
  assert.ok(!inBody('scrim'), 'Escape closes the dialog');
  assert.equal(REQUESTS.length, 0, 'Escape deletes nothing');

  // Cancel walks away clean too, armed or not.
  deleteArea(RANKING);
  await tick();
  const again = inBody('scrim').children[0];
  const box2 = again.querySelectorAll('input')[0];
  box2.value = 'Ranking';
  box2.dispatchEvent({ type: 'input' });
  buttons(again).find(b => b.classList.contains('cancel')).dispatchEvent({ type: 'click' });
  await tick();
  assert.ok(!inBody('scrim'));
  assert.equal(REQUESTS.length, 0, 'Cancel deletes nothing');

  // The exact name, and only then, deletes -- once, with the name URL-encoded.
  const spaced = { id: 'Client Work', name: 'Client Work', count: 0 };
  globalThis.AREAS.push(spaced);
  deleteArea(spaced);
  await tick();
  const last = inBody('scrim').children[0];
  assert.ok(last.textContent.includes('No cards are filed here'), 'an empty Area says so, and still asks');
  const box = last.querySelectorAll('input')[0];
  box.value = ' Client Work ';
  box.dispatchEvent({ type: 'input' });
  last.dispatchEvent({ type: 'submit' });
  await tick(); await tick();
  assert.deepEqual(REQUESTS, [['DELETE', '/api/areas/Client%20Work']]);
  assert.ok(!inBody('scrim'), 'the dialog closes behind the delete');

  console.log('area-delete assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
