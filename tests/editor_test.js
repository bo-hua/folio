/* Unit tests for the note editor (folio/static/editor.js).

   The editor shows formatted text and stores Markdown, so the two conversions
   are what must not drift: mdToHtml() builds what you edit, htmlToMd() builds
   what lands in the file, and a note that goes through both has to come back
   unchanged. htmlToMd runs here against tests/tiny-dom.js rather than a browser.

   The typing itself (Enter continues a list, Tab nests) is the browser's own
   list handling, driven through execCommand — that is exercised in a real
   headless Chrome, not here; only the Markdown tab's helpers are pure.

   Run with `node tests/editor_test.js`, or through pytest, which shells out. */
'use strict';

const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', 'folio', 'static', 'editor.js'));
const { parseHtml } = require(path.join(__dirname, 'tiny-dom.js'));
const T = E._t;

let ran = 0;
const roundTrip = md => E.htmlToMd(parseHtml(E.mdToHtml(md)));
function is(name, got, want) {
  ran++;
  assert.strictEqual(got, want, `${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}
function has(name, got, want) {
  ran++;
  assert.ok(got.includes(want), `${name}\n  got  ${got}\n  want to contain ${want}`);
}
const trip = (name, md, want) => is(name, roundTrip(md), want === undefined ? md : want);

// ---------------------------------------------------------------- Markdown -> what you edit
has('a bullet becomes a real list item', E.mdToHtml('- milk'), '<ul><li>milk</li></ul>');
has('indented bullets nest inside their parent item', E.mdToHtml('- a\n    - b'), '<ul><li>a<ul><li>b</li></ul></li></ul>');
has('numbers become an ordered list', E.mdToHtml('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
has('a to-do becomes a checkbox item', E.mdToHtml('- [ ] call'), '<li class="task"><input type="checkbox" contenteditable="false">call');
has('a ticked to-do is checked', E.mdToHtml('- [x] done'), 'checked>done');
has('headings keep their level', E.mdToHtml('## Plan'), '<h2>Plan</h2>');
has('quotes become blockquotes', E.mdToHtml('> hi'), '<blockquote><p>hi</p></blockquote>');
has('fences become code blocks', E.mdToHtml('```\nx = 1\n```'), '<pre><code>x = 1</code></pre>');
has('bold and italic render', E.mdToHtml('**b** and *i*'), '<strong>b</strong> and <em>i</em>');
has('inline code renders', E.mdToHtml('use `x`'), '<code>x</code>');
has('links render', E.mdToHtml('[folio](https://ex.com)'), '<a href="https://ex.com">folio</a>');
has('bare urls become links', E.mdToHtml('see https://ex.com'), '<a href="https://ex.com">https://ex.com</a>');
has('an empty note still has somewhere to type', E.mdToHtml(''), '<p><br></p>');
ran++; assert.ok(!E.mdToHtml('<script>alert(1)</script>').includes('<script>'), 'html in a note is escaped, not run');
ran++; assert.ok(E.mdToHtml('[x](javascript:alert(1))').includes('href="#"'), 'javascript: urls are defanged');
ran++; assert.ok(!E.mdToHtml('- [ ] a').includes('[ ]'), 'the checkbox syntax itself is never shown');

// ---------------------------------------------------------------- what you edit -> Markdown
is('items serialise back to dashes', E.htmlToMd(parseHtml('<ul><li>milk</li><li>eggs</li></ul>')), '- milk\n- eggs');
is('nesting serialises to four spaces', E.htmlToMd(parseHtml('<ul><li>a<ul><li>b</li></ul></li></ul>')), '- a\n    - b');
is('ordered items are numbered in order', E.htmlToMd(parseHtml('<ol><li>a</li><li>b</li></ol>')), '1. a\n2. b');
is('a checked box writes [x]', E.htmlToMd(parseHtml('<ul><li class="task"><input type="checkbox" checked>done</li></ul>')), '- [x] done');
is('an empty box writes [ ]', E.htmlToMd(parseHtml('<ul><li class="task"><input type="checkbox">todo</li></ul>')), '- [ ] todo');
is('the browser\'s <b> and <i> are markdown too', E.htmlToMd(parseHtml('<p>a <b>bold</b> and <i>it</i></p>')), 'a **bold** and *it*');
is('marks do not swallow the space beside them', E.htmlToMd(parseHtml('<p>a <b>bold </b>x</p>')), 'a **bold** x');
is('an empty paragraph is not a stray line', E.htmlToMd(parseHtml('<p><br></p>')), '');
is('a bare div is a paragraph', E.htmlToMd(parseHtml('<div>text</div>')), 'text');
is('a typed dash is escaped, not read back as a list', E.htmlToMd(parseHtml('<p>- not a list</p>')), '\\- not a list');
is('the caret parking character never reaches the file', E.htmlToMd(parseHtml('<p>a<strong>b</strong>​c</p>')), 'a**b**c');

// ---------------------------------------------------------------- the shapes a browser leaves behind
// Chrome grows a new list inside the paragraph it came from, and hangs a nested
// list off the parent <ul> instead of the <li>. Both have to read back correctly
// or a list collapses onto one line, or a nested item disappears.
is('a list wrapped in a paragraph is still a list',
  E.htmlToMd(parseHtml('<p><ul><li>milk</li><li>eggs</li></ul></p>')), '- milk\n- eggs');
is('a nested list beside its items is still nested',
  E.htmlToMd(parseHtml('<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>')), '- a\n    - b\n- c');
is('a to-do keeps its box through both shapes',
  E.htmlToMd(parseHtml('<p><ul><li class="task"><input type="checkbox" checked>done</li></ul></p>')), '- [x] done');
is('a paragraph next to a list in the same wrapper survives',
  E.htmlToMd(parseHtml('<div><p>intro</p><ul><li>a</li></ul></div>')), 'intro\n\n- a');

// ---------------------------------------------------------------- there and back again
trip('bullets survive the round trip', '- milk\n- eggs');
trip('nested bullets survive', '- a\n    - b\n    - c\n- d');
trip('numbered lists survive', '1. one\n2. two');
trip('a numbered list inside a bullet survives', '- a\n    1. one\n    2. two');
trip('to-dos survive, ticked and not', '- [ ] a\n- [x] b');
trip('headings survive', '## Plan');
trip('quotes survive', '> think about it');
trip('code fences survive', '```\nfolio serve\n```');
trip('inline marks survive', 'a **b**, *c*, `d`, ~~e~~ and [f](https://g.com)');
trip('a paragraph then a list survives', 'Some thoughts:\n\n- one\n- two');
trip('lines inside one paragraph keep their breaks', 'first line\nsecond line');
trip('a list then a paragraph survives', '- one\n- two\n\nAnd a closing line.');
trip('a heading, a list and a quote together survive', '# Title\n\n- a\n    - b\n\n> a quote');
trip('a rule survives', 'above\n\n---\n\nbelow');
trip('an escaped dash stays escaped', '\\- not a list');
trip('running it twice changes nothing more', roundTrip('- a\n    - b\n\ntext'), '- a\n    - b\n\ntext');

// ---------------------------------------------------------------- the Markdown tab's helpers
const parse = s => { const i = s.indexOf('|'); return T.doc(s.slice(0, i) + s.slice(i + 1), i, i); };
const show = d => d.text.slice(0, d.start) + '|' + d.text.slice(d.start);
const key = (name, got, want) => is(name, show(got), want);
key('Enter continues a bullet', T.enter(parse('- milk|')), '- milk\n- |');
key('Enter numbers the next item', T.enter(parse('1. a|')), '1. a\n2. |');
key('Enter resets a ticked box', T.enter(parse('- [x] done|')), '- [x] done\n- [ ] |');
key('Enter on an empty nested item comes up a level', T.enter(parse('- a\n    - |')), '- a\n- |');
key('Enter on an empty item leaves the list', T.enter(parse('- a\n- |')), '- a\n|');
key('Tab nests the item', T.indent(parse('- a\n- b|'), 1), '- a\n    - b|');
key('Shift-Tab unnests it', T.indent(parse('- a\n    - b|'), -1), '- a\n- b|');
key('renumber fixes a broken run', T.renumber('1. a\n1. b\n1. c', 0), '|1. a\n2. b\n3. c');
key('renumber restarts each nested list', T.renumber('1. a\n    5. x\n    9. y', 0), '|1. a\n    1. x\n    2. y');

console.log(`ok — ${ran} note-editor assertions`);
