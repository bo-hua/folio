/* Pasting into the note editor, in a real browser.

   The paste handler in folio/static/editor.js hands the browser HTML through
   execCommand('insertHTML'), and what Chrome does with that depends on where the
   caret is: paragraphs pasted into a list item land inside the <li>, or loose
   inside the <ul>, and a note came back as one item reading
   "Semantic IDPretrainingSFTRL". No stand-in DOM reproduces that, so this suite
   drives headless Chrome over the DevTools protocol: load a page holding one
   editor, place the caret, dispatch a paste event carrying text/plain, and read
   the Markdown the editor would save.

   Needs node 22+ (built-in WebSocket) and Chrome, found via $CHROME or the usual
   places. Run with `node tests/paste_test.js`, or through pytest, which skips
   when either is missing. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EDITOR = path.join(__dirname, '..', 'folio', 'static', 'editor.js');
const CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const CHROME = CANDIDATES.find(p => p && fs.existsSync(p));
if (!CHROME) { console.error('no Chrome found: set $CHROME'); process.exit(3); }

// The page: one editor, plus the hooks the scenarios drive.
const PAGE = `<!doctype html><meta charset="utf-8"><title>paste test</title>
<script src="file://${EDITOR}"></script>
<div id="host"></div>
<script>
window.setup = function (html) {
  const host = document.getElementById('host');
  host.innerHTML = '';
  const ed = NoteEditor.create({ value: '', save: null });
  host.appendChild(ed.el);
  window.DOC = ed.el.querySelector('.md-doc');
  if (html !== undefined) DOC.innerHTML = html;
};
window.caretEnd = function (sel) {            // caret at the end of the first element matching sel, or of the note
  const el = sel ? DOC.querySelector(sel) : DOC;
  DOC.focus();
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
};
window.caretIn = function (sel, offset) {     // caret inside the element's first text node
  const el = DOC.querySelector(sel);
  DOC.focus();
  const tn = [...el.childNodes].find(n => n.nodeType === 3);
  const r = document.createRange(); r.setStart(tn, offset); r.collapse(true);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
};
window.paste = function (text) {
  const dt = new DataTransfer(); dt.setData('text/plain', text);
  DOC.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return { html: DOC.innerHTML, md: NoteEditor.htmlToMd(DOC) };
};
</script>`;

// What someone copies out of a notes app: a bullet with a soft line break, a
// paragraph, then bullets with children under them.
const OUTLINE = [
  '- **Main goal:** Make reasoning work in recommenders.',
  'To make this happen, **SID/language alignment** matters.',
  '',
  'General approach',
  '',
  '- Semantic ID',
  '\t- A notable design choice.',
  '\t- Collaborative-filtering info stays out of the SID.',
  '- Pretraining',
  '\t- Create alignment data.',
  '- SFT',
  '\t- Design explicit **CoT** traces.',
  '- RL',
  '\t- A specialized RL stage.',
].join('\n');
const OUTLINE_MD = [
  '- **Main goal:** Make reasoning work in recommenders. To make this happen, **SID/language alignment** matters.',
  '',
  'General approach',
  '',
  '- Semantic ID',
  '    - A notable design choice.',
  '    - Collaborative-filtering info stays out of the SID.',
  '- Pretraining',
  '    - Create alignment data.',
  '- SFT',
  '    - Design explicit **CoT** traces.',
  '- RL',
  '    - A specialized RL stage.',
].join('\n');
// The same outline with each heading as a plain line above its bullets.
const HEADED = 'Semantic ID\n- A notable design choice.\n- Collaborative-filtering info.\n\nPretraining\n- Create alignment data.\n\nSFT\n- Design explicit traces.\n\nRL\n- A specialized RL stage.';
const HEADED_MD = 'Semantic ID\n\n- A notable design choice.\n- Collaborative-filtering info.\n\nPretraining\n\n- Create alignment data.\n\nSFT\n\n- Design explicit traces.\n\nRL\n\n- A specialized RL stage.';
const BARE_LIST = '- Semantic ID\n\t- A notable design choice.\n- Pretraining\n\t- Create alignment data.';

const SCENARIOS = [
  { name: 'the outline pasted into an empty note', html: undefined, place: 'caretEnd(null)', text: OUTLINE, want: OUTLINE_MD },
  { name: 'the outline pasted into an empty bullet (typed "- " first)', html: '<ul><li><br></li></ul>', place: "caretEnd('li')", text: OUTLINE, want: OUTLINE_MD },
  { name: 'headings over their bullets, pasted into an empty bullet', html: '<ul><li><br></li></ul>', place: "caretEnd('li')", text: HEADED, want: HEADED_MD },
  { name: 'the outline pasted into an empty nested bullet', html: '<ul><li>x<ul><li><br></li></ul></li></ul>', place: "caretEnd('li li')", text: OUTLINE, want: '- x\n\n' + OUTLINE_MD },
  { name: 'the outline pasted at the end of a filled bullet', html: '<ul><li>first point</li></ul>', place: "caretEnd('li')", text: OUTLINE, want: '- first point\n\n' + OUTLINE_MD },
  { name: 'the outline pasted into the middle of a bullet', html: '<ul><li>first point</li><li>next</li></ul>', place: "caretIn('li', 5)", text: OUTLINE, want: '- first\n\n' + OUTLINE_MD + '\n\n- point\n- next' },
  { name: 'the outline pasted after a bullet that has children', html: '<ul><li>Semantic ID<ul><li>a</li><li>b</li></ul></li><li>next</li></ul>', place: "caretIn('li', 11)", text: OUTLINE, want: '- Semantic ID\n    - a\n    - b\n\n' + OUTLINE_MD + '\n\n- next' },
  { name: 'the outline pasted into an empty to-do leaves no stray box', html: '<ul><li class="task"><input type="checkbox" contenteditable="false"><br></li></ul>', place: "caretEnd('li')", text: OUTLINE, want: OUTLINE_MD, noInput: true },
  { name: 'a bare list pasted into a filled bullet joins the list', html: '<ul><li>General approach</li></ul>', place: "caretEnd('li')", text: BARE_LIST, want: '- General approach\n- Semantic ID\n    - A notable design choice.\n- Pretraining\n    - Create alignment data.' },
  { name: 'a bare list pasted into an empty bullet takes its place', html: '<ul><li><br></li></ul>', place: "caretEnd('li')", text: BARE_LIST, want: '- Semantic ID\n    - A notable design choice.\n- Pretraining\n    - Create alignment data.' },
  { name: 'two lines of prose pasted into an empty bullet stay in it', html: '<ul><li><br></li></ul>', place: "caretEnd('li')", text: 'first line\nsecond line', want: '- first line second line' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 20000 + Math.floor(Math.random() * 20000);    // parallel runs must not share a port
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-paste-'));
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
  for (let i = 0; i < 50 && !(await run('typeof NoteEditor === "object" && typeof setup === "function"')); i++) await sleep(100);

  let ran = 0;
  for (const sc of SCENARIOS) {
    const got = await run(`(() => { setup(${JSON.stringify(sc.html)}); ${sc.place}; return paste(${JSON.stringify(sc.text)}); })()`);
    ran++;
    assert.strictEqual(got.md, sc.want, `${sc.name}\n  got  ${JSON.stringify(got.md)}\n  want ${JSON.stringify(sc.want)}\n  dom  ${got.html}`);
    if (sc.noInput) { ran++; assert.ok(!got.html.includes('<input'), `${sc.name}: a checkbox was left behind in ${got.html}`); }
  }
  console.log(`ok — ${ran} note-editor paste assertions in Chrome`);
  finish(0);
})().catch(e => { console.error(e && e.stack || e); finish(1); });
