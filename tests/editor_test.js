/* Unit tests for the note editor's typing rules (folio/static/editor.js).

   The transforms are pure functions of {text, start, end}, so they can be checked
   without a browser. In the cases below `|` marks the caret and «guillemets» a
   selection — brackets would collide with the Markdown being tested. Run with
   `node tests/editor_test.js`, or through pytest, which shells out to node. */
'use strict';

const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', 'folio', 'static', 'editor.js'));
const T = E._t;

let ran = 0;
// "a|b" -> caret at 1; "a«bc»d" -> selection 1..3
function parse(s) {
  const a = s.indexOf('«');
  if (a >= 0) {
    const b = s.indexOf('»');
    return { text: s.slice(0, a) + s.slice(a + 1, b) + s.slice(b + 1), start: a, end: b - 1 };
  }
  const i = s.indexOf('|');
  return { text: s.slice(0, i) + s.slice(i + 1), start: i, end: i };
}
function show(d) {
  return d.start === d.end
    ? d.text.slice(0, d.start) + '|' + d.text.slice(d.start)
    : d.text.slice(0, d.start) + '«' + d.text.slice(d.start, d.end) + '»' + d.text.slice(d.end);
}
function is(name, got, want) {
  ran++;
  assert.strictEqual(show(got), want, `${name}\n  got  ${JSON.stringify(show(got))}\n  want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------- Enter
is('Enter continues a bullet', T.enter(parse('- milk|')), '- milk\n- |');
is('Enter splits an item in two', T.enter(parse('- mi|lk')), '- mi\n- |lk');
is('Enter keeps the nesting depth', T.enter(parse('- a\n    - b|')), '- a\n    - b\n    - |');
is('Enter keeps a * or + marker', T.enter(parse('* a|')), '* a\n* |');
is('Enter keeps the spacing after the marker', T.enter(parse('-   a|')), '-   a\n-   |');
is('Enter numbers the next ordered item', T.enter(parse('1. a|')), '1. a\n2. |');
is('Enter renumbers what follows an insert', T.enter(parse('1. a|\n2. b\n3. c')), '1. a\n2. |\n3. b\n4. c');
is('Enter resets a ticked box', T.enter(parse('- [x] done|')), '- [x] done\n- [ ] |');
is('Enter continues an unticked box', T.enter(parse('- [ ] todo|')), '- [ ] todo\n- [ ] |');
is('Enter continues a quote', T.enter(parse('> quoted|')), '> quoted\n> |');
is('Enter on an empty nested item comes up a level', T.enter(parse('- a\n    - |')), '- a\n- |');
is('Enter on an empty top-level item leaves the list', T.enter(parse('- a\n- |')), '- a\n|');
is('Enter on an empty quote leaves the quote', T.enter(parse('> a\n> |')), '> a\n|');
is('Enter keeps plain indentation', T.enter(parse('    hello|')), '    hello\n    |');
is('Enter is dumb inside a code fence', T.enter(parse('```\n- not a list|\n```')), '```\n- not a list\n|\n```');
is('Enter replaces the selection first', T.enter(parse('- a«bc»d')), '- a\n- |d');
is('Enter before the marker just breaks the line', T.enter(parse('|- a')), '\n|- a');

// ---------------------------------------------------------------- Tab / Shift-Tab
is('Tab nests the item under the one above', T.indent(parse('- a\n- b|'), 1), '- a\n    - b|');
is('Tab works from anywhere in the item', T.indent(parse('- a\n- b|c'), 1), '- a\n    - b|c');
is('Shift-Tab unnests it again', T.indent(parse('- a\n    - b|'), -1), '- a\n- b|');
is('Shift-Tab stops at the left margin', T.indent(parse('- a|'), -1), '- a|');
is('Tab renumbers the list it just left', T.indent(parse('1. a\n2. b|\n3. c'), 1), '1. a\n    1. b|\n2. c');
is('Shift-Tab renumbers on the way back', T.indent(parse('1. a\n    1. b|\n2. c'), -1), '1. a\n2. b|\n3. c');
is('Tab outside a list is a plain indent', T.indent(parse('hello |world'), 1), 'hello     |world');
is('Tab indents every selected line', T.indent(parse('- a«\n- b\n- »c'), 1), '    - a«\n    - b\n    - »c');

// ---------------------------------------------------------------- list toggles
is('a plain line becomes a bullet', T.toggleList(parse('buy milk|'), 'bullet'), '«- buy milk»');
is('a bullet toggles back to plain text', T.toggleList(parse('- buy milk|'), 'bullet'), '«buy milk»');
is('a bullet becomes a to-do', T.toggleList(parse('- buy milk|'), 'task'), '«- [ ] buy milk»');
is('a to-do becomes a numbered item', T.toggleList(parse('- [ ] a|'), 'ordered'), '«1. a»');
is('numbering runs down the selection', T.toggleList(parse('«a\nb\nc»'), 'ordered'), '«1. a\n2. b\n3. c»');
is('toggling keeps the indent', T.toggleList(parse('    deep|'), 'bullet'), '«    - deep»');

// ---------------------------------------------------------------- Backspace
is('Backspace at the text head drops the marker', T.backspace(parse('- |a')), '|a');
is('Backspace unnests before it drops', T.backspace(parse('    - |a')), '- |a');
is('Backspace drops a checkbox marker whole', T.backspace(parse('- [ ] |a')), '|a');
ran++; assert.strictEqual(T.backspace(parse('- a|')), null, 'Backspace mid-text is left to the browser');
ran++; assert.strictEqual(T.backspace(parse('plain |text')), null, 'Backspace outside a list is left to the browser');

// ---------------------------------------------------------------- inline marks
is('bold wraps the selection', T.wrapInline(parse('say «hello» there'), '**'), 'say **«hello»** there');
is('bold wraps the word under the caret', T.wrapInline(parse('say hel|lo'), '**'), 'say **«hello»**');
is('bold on bold takes it off', T.wrapInline(parse('say **«hello»** there'), '**'), 'say «hello» there');
is('italic is a single star', T.wrapInline(parse('«x»'), '*'), '*«x»*');
is('code is a backtick', T.wrapInline(parse('«x»'), '`'), '`«x»`');
is('a link leaves the url selected', T.link(parse('«folio»')), '[folio](«url»)');
is('a selected url becomes the target', T.link(parse('«https://ex.com»')), '[|](https://ex.com)');

// ---------------------------------------------------------------- paste
is('a url pasted over text makes a link', T.pasteInto(parse('see «folio» now'), 'https://ex.com'), 'see [folio](https://ex.com)| now');
// the first pasted line continues the item you are on, as it does in Notion
is('pasted lines join the list', T.pasteInto(parse('- a|'), 'b\nc'), '- ab\n- c|');
is('pasted lines join a numbered list', T.pasteInto(parse('1. a|'), 'b\nc'), '1. ab\n2. c|');
ran++; assert.strictEqual(T.pasteInto(parse('- a|'), '- b\n- c'), null, 'markdown that is already a list pastes as-is');
ran++; assert.strictEqual(T.pasteInto(parse('plain|'), 'text'), null, 'an ordinary paste is left to the browser');

// ---------------------------------------------------------------- renumber
is('renumber fixes a broken run', T.renumber('1. a\n1. b\n1. c', 0), '|1. a\n2. b\n3. c');
is('renumber keeps a list that starts at 5', T.renumber('5. a\n9. b', 0), '|5. a\n6. b');
is('renumber restarts each nested list', T.renumber('1. a\n    1. x\n    5. y\n2. b', 0), '|1. a\n    1. x\n    2. y\n2. b');
is('a paragraph ends the list', T.renumber('1. a\n\nnot a list\n\n7. b', 0), '|1. a\n\nnot a list\n\n7. b');

// ---------------------------------------------------------------- preview
const html = E.mdHtml;
function has(name, src, want) { ran++; const got = html(src); assert.ok(got.includes(want), `${name}\n  got  ${got}\n  want to contain ${want}`); }
has('bullets render as a list', '- a\n- b', '<ul><li>a</li><li>b</li></ul>');
has('nesting renders as a nested list', '- a\n    - b', '<ul><li>a<ul><li>b</li></ul></li></ul>');
has('numbers render as an ordered list', '1. a\n2. b', '<ol><li>a</li><li>b</li></ol>');
has('a to-do renders a real checkbox', '- [ ] a', '<input type="checkbox" data-line="0">');
has('a ticked to-do renders checked', '- [x] a', 'data-line="0" checked');
has('headings render', '## Title', '<h2>Title</h2>');
has('quotes render', '> hi', '<blockquote><p>hi</p></blockquote>');
has('fences render as code', '```\nx = 1\n```', '<pre><code>x = 1</code></pre>');
has('inline code renders', 'use `x`', '<code>x</code>');
has('bold and italic render', '**b** and *i*', '<strong>b</strong> and <em>i</em>');
has('links render', '[folio](https://ex.com)', '<a href="https://ex.com" target="_blank" rel="noopener">folio</a>');
has('bare urls link themselves', 'see https://ex.com now', '<a href="https://ex.com"');
has('a rule renders', '---', '<hr>');
ran++; assert.ok(!html('<script>alert(1)</script>').includes('<script>'), 'html in a note is escaped, not run');
ran++; assert.ok(html('[x](javascript:alert(1))').includes('href="#"'), 'javascript: urls are defanged');
ran++; assert.ok(!html('- [ ] a').includes('[ ]'), 'the checkbox syntax itself is not shown');

console.log(`ok — ${ran} note-editor assertions`);
