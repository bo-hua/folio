/* A paste into a card's title lands as one trimmed line, run against the JavaScript
   folio actually ships.

   The title is a one-row textarea that grows with its text, and the name is only
   tidied when it blurs. What you copy usually ends in a newline -- a line from a
   terminal, a heading from a doc -- so pasted as-is it opened a blank second row
   under the title with the caret on it. The paste handler in static/app.js folds the
   pasted text onto one line and drops its trailing whitespace before it lands.

   Two halves. titlePaste() is pulled out of app.js and checked under node. Then,
   when Chrome is around (found via $CHROME or the usual places), the paste listener
   itself is driven in headless Chrome over the DevTools protocol: a synthetic paste
   event carrying text/plain on a real textarea, because whether
   execCommand('insertText') writes into a textarea, moves the caret and fires input
   is the browser's business, not ours. Set NO_CHROME=1 to run only the node half. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const APP = fs.readFileSync(path.join(__dirname, '..', 'folio', 'static', 'app.js'), 'utf8');
const lineWith = label => {
  const i = APP.indexOf(label);
  assert.ok(i > 0, `landmark missing from app.js: ${label}`);
  return APP.lastIndexOf('\n', i) + 1;
};
const between = (from, to) => APP.slice(lineWith(from), lineWith(to));
// The comment above titlePaste, the function, and the paste listener -- up to the next listener.
const PASTE_CODE = between('// A paste into the title lands as one line', "$('#inspector').addEventListener('submit'");
assert.ok(PASTE_CODE.includes('function titlePaste(') && PASTE_CODE.includes("addEventListener('paste'"), 'the paste code moved; fix the landmarks');

// ---------------------------------------------------------------- the pure half: what the pasted text becomes
vm.runInThisContext(between('function titlePaste(', "$('#inspector').addEventListener('paste'") + '\n;globalThis.titlePaste = titlePaste;\n', { filename: 'app.js-extract' });
const { titlePaste } = globalThis;
let pure = 0;
const is = (got, want, why) => { assert.strictEqual(got, want, why); pure++; };
is(titlePaste('Fix the thing\n', true), 'Fix the thing', 'the newline a copied line carries is dropped');
is(titlePaste('Fix the thing \r\n\r\n', true), 'Fix the thing', 'so is a run of Windows line endings and spaces');
is(titlePaste('  padded  ', true), 'padded', 'at the start of the title, leading whitespace goes too');
is(titlePaste(' baz\n', false), ' baz', 'mid-title, a leading space is kept -- it may be the one you need');
is(titlePaste('line one\nline two\n', true), 'line one line two', 'a multi-line paste folds onto one line');
is(titlePaste('a\t\tb   c', true), 'a b c', 'runs of whitespace become one space, as the saved name would');
is(titlePaste('\n\n', true), '', 'nothing but whitespace pastes as nothing');
is(titlePaste('\n', false), '', 'also mid-title');
console.log(`ok — ${pure} title paste assertions (pure)`);

// ---------------------------------------------------------------- the browser half: the paste listener on a real textarea
const CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const CHROME = process.env.NO_CHROME ? null : CANDIDATES.find(p => p && fs.existsSync(p));
if (!CHROME) { console.log(process.env.NO_CHROME ? 'browser half skipped (NO_CHROME)' : 'no Chrome found: browser half skipped (set $CHROME)'); process.exit(0); }

// The page: the inspector as far as the paste handler cares -- a title textarea with
// data-act="rename" inside #inspector, and $ as app.js defines it. The handler code
// is the extract from app.js, verbatim. `inputs` counts input events, the signal that
// fitTitle() (the textarea's oninput in the real page) would have run.
const PAGE = `<!doctype html><meta charset="utf-8"><title>title paste test</title>
<div id="inspector"><textarea data-act="rename" rows="1" aria-label="Card name"></textarea></div>
<script>
const $ = (s, r = document) => r.querySelector(s);
${PASTE_CODE}
window.T = $('textarea');
window.inputs = 0; T.addEventListener('input', () => { inputs++; });
window.setup = function (value, start, end) {      // the title as it stands, and where the selection is
  T.value = value; T.focus(); T.setSelectionRange(start, end === undefined ? start : end); inputs = 0;
};
window.paste = function (text) {
  const dt = new DataTransfer(); dt.setData('text/plain', text);
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  const handled = !T.dispatchEvent(ev);         // false = the handler let the browser's own paste through
  return { value: T.value, start: T.selectionStart, end: T.selectionEnd, inputs, handled };
};
window.undo = function () { document.execCommand('undo'); return T.value; };
</script>`;

const SCENARIOS = [
  { name: 'a copied line, with its newline, pasted over "Untitled idea"', value: 'Untitled idea', sel: [0, 13], text: 'Fix the flaky test\n', want: 'Fix the flaky test' },
  { name: 'trailing spaces and blank lines pasted into an empty title', value: '', sel: [0], text: 'Ship it  \n\n', want: 'Ship it' },
  { name: 'a padded line pasted at the very start loses its lead too', value: '', sel: [0], text: '   padded\n', want: 'padded' },
  { name: 'two lines pasted into an empty title become one line', value: '', sel: [0], text: 'line one\nline two\n', want: 'line one line two' },
  { name: 'pasted mid-title, a leading space is kept and the caret follows the text', value: 'foo bar', sel: [3], text: ' baz\n', want: 'foo baz bar', caret: 7 },
  { name: 'pasted at the end, the caret sits right after the text, not on a new row', value: 'foo', sel: [3], text: ' bar\n', want: 'foo bar', caret: 7 },
  { name: 'nothing but whitespace, nowhere selected, changes nothing', value: 'keep', sel: [4], text: '\n', want: 'keep', caret: 4, quiet: true },
  { name: 'nothing but whitespace over a selection clears the selection', value: 'keep this', sel: [5, 9], text: '\n', want: 'keep ', caret: 5 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 20000 + Math.floor(Math.random() * 20000);    // parallel runs must not share a port
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-title-paste-'));
const pageFile = path.join(tmp, 'page.html');
fs.writeFileSync(pageFile, PAGE);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, 'profile')}`,
  '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
function finish(code) {
  try { chrome.kill('SIGKILL'); } catch (e) { /* already gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  process.exit(code);
}
setTimeout(() => { console.error('timed out waiting on Chrome'); finish(2); }, 90000);

function targets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/list`, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

(async () => {
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    try { page = (await targets()).find(t => t.type === 'page'); } catch (e) { await sleep(200); }
  }
  if (!page) throw new Error('Chrome did not open a page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = m => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } };
  const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const run = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception.description || JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });   // execCommand needs a focused document
  await send('Page.navigate', { url: 'file://' + pageFile });
  for (let i = 0; i < 50 && !(await run('typeof setup === "function" && typeof titlePaste === "function"')); i++) await sleep(100);

  let ran = 0;
  for (const sc of SCENARIOS) {
    const got = await run(`(() => { setup(${JSON.stringify(sc.value)}, ${sc.sel.join(', ')}); return paste(${JSON.stringify(sc.text)}); })()`);
    const tag = `${sc.name}\n  got ${JSON.stringify(got)}`;
    ran++; assert.ok(got.handled, `${tag}\n  the handler did not take the paste over from the browser`);
    ran++; assert.strictEqual(got.value, sc.want, `${tag}\n  want value ${JSON.stringify(sc.want)}`);
    ran++; assert.ok(!got.value.includes('\n'), `${tag}\n  a newline got into the title`);
    const caret = sc.caret === undefined ? sc.want.length : sc.caret;
    ran++; assert.deepStrictEqual([got.start, got.end], [caret, caret], `${tag}\n  the caret should be collapsed at ${caret}`);
    ran++; assert.strictEqual(got.inputs > 0, !sc.quiet, `${tag}\n  ${sc.quiet ? 'a no-op paste fired input' : 'no input event, so the title would not have re-fit its height'}`);
  }
  // The paste is one step on the undo stack: ⌘Z brings the old title back.
  await run(`setup('Untitled idea', 0, 13); paste('Fix the flaky test\\n')`);
  ran++; assert.strictEqual(await run('undo()'), 'Untitled idea', 'undo after a paste did not restore the previous title');
  console.log(`ok — ${ran} title paste assertions in Chrome`);
  finish(0);
})().catch(e => { console.error(e && e.stack || e); finish(1); });
