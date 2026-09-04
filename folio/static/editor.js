/* folio note editor: you see bullets, the file keeps Markdown.

   Typing "- " gives you an actual bullet — the dash disappears, the item is
   indented, Tab nests it under the one above. Same for "1. ", "[] ", "# ", "> ".
   No Markdown syntax is on screen while you write; the syntax is what gets
   saved, so a note stays a plain .md file that reads correctly in git and in
   Obsidian.

   How it works, and why it is built this way:
   * The editing surface is a contenteditable holding ordinary HTML — <ul>, <li>,
     <h2>, <blockquote>. That way the browser's own list handling does the hard
     parts: Enter continues a list, Enter on an empty item leaves it, Tab nests
     via execCommand('indent'), and every one of those sits on the native undo
     stack. A hand-rolled block model would throw all of that away.
   * Markdown is the wire format, not the model: mdToHtml() on the way in,
     htmlToMd() on the way out. Both are pure functions, round-trip tested in
     tests/editor_test.js.
   * The Markdown toggle swaps in a plain textarea over the same note, for when
     you want to see or paste raw syntax. Its Enter/Tab helpers are the pure
     transforms further down.
   * A link is text you can edit, so a plain click puts the caret in it, as in any
     editor; ⌘-click (Ctrl-click elsewhere) opens it in a new tab. */
'use strict';

var NoteEditor = (function () {

  const IND = '    ';                                     // 4 spaces: what python-markdown needs to nest a list
  const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?/;
  const QUOTE = /^([ \t]*)((?:>[ \t]?)+)/;
  const URLISH = /^(https?:\/\/|mailto:)\S+$/i;
  const NUL = '\u0000';                                  // sentinel while code spans are held aside
  const ZW = '\u200b';                                    // parking spot for the caret after an inline conversion
  const MAC = typeof navigator === 'undefined' || /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent);
  const CMD = MAC ? '⌘' : 'Ctrl+';
  const MODCLICK = MAC ? '⌘‑click' : 'Ctrl‑click';   // non-breaking hyphen: the hint bar must not split it

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const esc = s => s.replace(/[&<>"]/g, c => ESC[c]);
  const safeHref = u => (/^(https?:|mailto:|#|\/|\.{0,2}\/)/i.test(u) ? u : '#');
  const width = s => s.replace(/\t/g, IND).length;

  // ================================================================ Markdown -> HTML
  function inlineHtml(s) {
    const code = [];
    let t = esc(s).replace(/`([^`]+)`/g, (m, c) => { code.push(c); return NUL + (code.length - 1) + NUL; });
    t = t.replace(/\\([-*+#>`\[\]()~=_\\])/g, '$1');            // a backslash-escaped marker is just the character
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, a, u) => `<img src="${safeHref(u)}" alt="${a}">`);
    t = t.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (m, a, u) => `<a href="${safeHref(u)}">${a || u}</a>`);
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, p, u) => `${p}<a href="${safeHref(u)}">${u}</a>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>').replace(/==([^=]+)==/g, '<mark>$1</mark>');
    return t.replace(new RegExp(NUL + '(\\d+)' + NUL, 'g'), (m, i) => `<code>${code[i]}</code>`);
  }

  /* Markdown in, editable HTML out. Nesting follows the source indent, and a
     nested list lands inside its parent <li> — the shape the browser itself
     produces when you press Tab, so what you load and what you type agree. */
  function mdToHtml(src) {
    const lines = (src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [], stack = [];                            // open lists: {indent, tag}
    let para = [], fence = null, quote = [];
    const closeLists = to => { while (stack.length && stack[stack.length - 1].indent > to) out.push(`</li></${stack.pop().tag}>`); };
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inlineHtml).join('<br>')}</p>`); para = []; } };  // keep the lines as written
    const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${mdToHtml(quote.join('\n'))}</blockquote>`); quote = []; } };
    const flush = () => { flushPara(); flushQuote(); closeLists(-1); };
    for (const l of lines) {
      const f = l.match(/^[ \t]*(```|~~~)/);
      if (fence !== null) {
        if (f) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null; } else fence.push(l);
        continue;
      }
      if (f) { flush(); fence = []; continue; }
      if (!l.trim()) { flush(); continue; }
      const q = l.match(/^[ \t]*>[ \t]?(.*)$/);
      if (q) { flushPara(); closeLists(-1); quote.push(q[1]); continue; }
      flushQuote();
      const li = l.match(LIST);
      const hd = l.match(/^[ \t]*(#{1,6})[ \t]+(.*)$/);
      if (!li && /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(l)) { flush(); out.push('<hr>'); continue; }
      if (hd) { flush(); out.push(`<h${hd[1].length}>${inlineHtml(hd[2])}</h${hd[1].length}>`); continue; }
      if (li) {
        flushPara();
        const ind = width(li[1]), tag = /^\d/.test(li[2]) ? 'ol' : 'ul';
        const item = li[4]
          ? `<li class="task"><input type="checkbox" contenteditable="false"${/x/i.test(li[4]) ? ' checked' : ''}>`
          : '<li>';
        closeLists(ind);
        const top = stack[stack.length - 1];
        if (!top || top.indent < ind) { stack.push({ indent: ind, tag }); out.push(`<${tag}>${item}`); }
        else if (top.tag !== tag) { out.push(`</li></${stack.pop().tag}>`); stack.push({ indent: ind, tag }); out.push(`<${tag}>${item}`); }
        else out.push(`</li>${item}`);
        out.push(inlineHtml(l.slice(li[0].length)));
        continue;
      }
      if (stack.length) { out.push(' ' + inlineHtml(l.trim())); continue; }   // lazy continuation of an item
      para.push(l.trim());
    }
    if (fence !== null) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
    flush();
    return out.join('') || '<p><br></p>';
  }

  // ================================================================ HTML -> Markdown
  const trimWrap = (t, mark) => {
    const m = t.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m[2] ? m[1] + mark + m[2] + mark + m[3] : t;
  };
  function inlineMd(node, skip) {
    let s = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { s += c.textContent; continue; }
      if (c.nodeType !== 1) continue;
      if (skip && skip(c)) continue;
      const tag = c.tagName.toLowerCase();
      const inner = () => inlineMd(c, skip);
      if (tag === 'br') s += '\n';
      else if (tag === 'strong' || tag === 'b') s += trimWrap(inner(), '**');
      else if (tag === 'em' || tag === 'i') s += trimWrap(inner(), '*');
      else if (tag === 'del' || tag === 's' || tag === 'strike') s += trimWrap(inner(), '~~');
      else if (tag === 'mark') s += trimWrap(inner(), '==');
      else if (tag === 'code') s += '`' + c.textContent + '`';
      else if (tag === 'img') s += `![${c.getAttribute('alt') || ''}](${c.getAttribute('src') || ''})`;
      else if (tag === 'a') { const t = inner(), href = c.getAttribute('href') || ''; s += !t || t === href ? href : `[${t}](${href})`; }
      else if (tag === 'input') s += '';
      else s += inner();
    }
    return s.split(ZW).join('').replace(/\u00a0/g, ' ');   // the browser's &nbsp; is just a space in a text file
  }
  // A paragraph that happens to start with "- " must not come back as a list.
  const guard = t => (/^\s*([-*+]\s|\d{1,9}[.)]\s|#{1,6}\s|>\s)/.test(t) ? '\\' + t.trimStart() : t);
  const isList = n => n.tagName === 'UL' || n.tagName === 'OL';
  const BLOCKISH = new Set(['UL', 'OL', 'BLOCKQUOTE', 'PRE', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P']);
  const kids = n => [...n.childNodes].filter(c => c.nodeType === 1);

  // Blocks the browser can leave inside an <li> — a paste that landed in a bullet (see leaveList).
  const ITEM_BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'HR']);
  const isBlock = n => n.nodeType === 1 && ITEM_BLOCKS.has(n.tagName);
  const hasContent = nodes => nodes.some(n => (n.nodeType === 1 ? n.tagName !== 'BR' && n.tagName !== 'INPUT' : n.textContent.trim()));

  function listMd(list, lines, level, qp) {
    const ordered = list.tagName === 'OL';
    let n = parseInt(list.getAttribute('start') || '1', 10);
    for (const li of kids(list)) {
      if (isList(li)) { listMd(li, lines, level + 1, qp); continue; }   // the shape Tab leaves behind
      if (li.tagName !== 'LI') {          // a stray node belongs to the item it was typed into
        const t = inlineMd({ childNodes: [li] }).trim();
        if (t && lines.length) lines[lines.length - 1] += (/\s$/.test(lines[lines.length - 1]) ? '' : ' ') + t;
        continue;
      }
      const box = kids(li).find(c => c.tagName === 'INPUT' && c.getAttribute('type') === 'checkbox');
      /* An item is its text, then whatever list is nested in it. Chrome can also
         leave whole paragraphs inside one <li>, and run together they read as a
         single word ("Semantic IDPretrainingSFTRL"). So content that follows a
         nested list, or a block that follows other content, is written as an
         item of its own, and each nested list attaches to the item written last. */
      let run = [], written = 0;
      const item = () => {
        const text = inlineMd({ childNodes: run }, c => c.tagName === 'INPUT').replace(/\s+/g, ' ').trim();
        run = [];
        if (written && !text) return;
        const marker = ordered ? `${n++}. ` : box && !written ? `- [${box.checked ? 'x' : ' '}] ` : '- ';
        lines.push(qp + IND.repeat(level) + marker + text);
        written++;
      };
      for (const c of li.childNodes) {
        if (isList(c)) { item(); listMd(c, lines, level + 1, qp); }
        else if (isBlock(c) && hasContent(run)) { item(); run.push(c); }
        else run.push(c);
      }
      if (run.length || !written) item();
    }
  }
  function blocksMd(parent, lines, qp) {
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) { const t = node.textContent.trim(); if (t) lines.push(qp + guard(t), ''); continue; }
      if (node.nodeType !== 1) continue;
      const tag = node.tagName.toLowerCase();
      if (isList(node)) { listMd(node, lines, 0, qp); lines.push(''); }
      else if (/^h[1-6]$/.test(tag)) lines.push(qp + '#'.repeat(+tag[1]) + ' ' + inlineMd(node).trim(), '');
      else if (tag === 'blockquote') { blocksMd(node, lines, qp + '> '); lines.push(''); }
      else if (tag === 'pre') {
        lines.push(qp + '```');
        node.textContent.replace(/\n$/, '').split('\n').forEach(l => lines.push(qp + l));
        lines.push(qp + '```', '');
      }
      else if (tag === 'hr') lines.push(qp + '---', '');
      else if (tag === 'br') { /* a bare <br> between blocks is only spacing */ }
      else if (kids(node).some(c => BLOCKISH.has(c.tagName))) blocksMd(node, lines, qp);  // a <p> the browser filled with blocks
      else {                                               // p, div, and whatever else the browser leaves behind
        const t = inlineMd(node);
        if (t.trim()) t.split('\n').forEach((l, i) => lines.push(qp + (i ? l : guard(l))));
        lines.push('');
      }
    }
  }
  function htmlToMd(root) {
    const lines = [];
    blocksMd(root, lines, '');
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ================================================================ source-mode transforms
  // (the Markdown tab is a plain textarea; these keep Enter and Tab useful there)
  const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1;
  const lineEnd = (t, i) => { const j = t.indexOf('\n', i); return j < 0 ? t.length : j; };
  const leading = l => (l.match(/^[ \t]*/) || [''])[0];
  const unindent = l => l.replace(l.startsWith('\t') ? /^\t/ : new RegExp('^ {1,' + IND.length + '}'), '');
  function inFence(text, pos) {
    let open = false;
    for (const l of text.slice(0, pos).split('\n')) if (/^[ \t]*(```|~~~)/.test(l)) open = !open;
    return open;
  }
  const doc_ = (text, start, end = start) => ({ text, start, end });
  const cut = d => (d.start === d.end
    ? { text: d.text, pos: d.start }
    : { text: d.text.slice(0, d.start) + d.text.slice(d.end), pos: d.start });
  const splice = (text, from, to, s, caret) => doc_(text.slice(0, from) + s + text.slice(to), caret == null ? from + s.length : caret);

  function renumber(text, pos) {
    const lines = text.split('\n');
    const counters = new Map();
    let at = 0, delta = 0, blanks = 0;
    for (let i = 0; i < lines.length; i++) {
      const old = lines[i];
      let next = old;
      if (!old.trim()) {
        if (++blanks >= 2) counters.clear();                 // two blank lines end a list
      } else {
        blanks = 0;
        const m = old.match(LIST);
        if (!m) {
          if (!/^[ \t]/.test(old)) counters.clear();         // a paragraph at column 0 ends it too
        } else {
          const ind = width(m[1]);
          for (const k of [...counters.keys()]) if (k > ind) counters.delete(k);
          if (/^\d/.test(m[2])) {
            // A list nested inside another starts over at 1; a list of its own keeps
            // whatever number it was written with, so "5. 6. 7." survives an edit.
            const nested = [...counters.keys()].some(k => k < ind);
            const n = counters.has(ind) ? counters.get(ind) : nested ? 1 : parseInt(m[2], 10);
            next = m[1] + n + m[2].slice(-1) + old.slice(m[1].length + m[2].length);
            counters.set(ind, n + 1);
          } else counters.set(ind, 1);
        }
      }
      if (next !== old) { lines[i] = next; if (at < pos) delta += next.length - old.length; }
      at += old.length + 1;
    }
    return doc_(lines.join('\n'), pos + delta);
  }
  function enter(d) {
    const { text, pos } = cut(d);
    const ls = lineStart(text, pos), le = lineEnd(text, pos), line = text.slice(ls, le);
    if (inFence(text, ls)) return splice(text, pos, pos, '\n' + leading(line));
    const m = line.match(LIST);
    if (m && pos >= ls + m[0].length) {
      if (!line.slice(m[0].length).trim()) {
        if (width(m[1]) >= IND.length) {                     // nested and empty: come up a level
          const out = unindent(m[1]) + line.slice(m[1].length);
          return renumber(text.slice(0, ls) + out + text.slice(le), ls + out.length);
        }
        return renumber(text.slice(0, ls) + text.slice(le), ls);   // top level and empty: leave the list
      }
      let marker = /^\d/.test(m[2]) ? m[1] + (parseInt(m[2], 10) + 1) + m[2].slice(-1) + m[3] : m[1] + m[2] + m[3];
      if (m[4]) marker += '[ ] ';
      const ins = splice(text, pos, pos, '\n' + marker);
      return renumber(ins.text, ins.start);
    }
    const q = line.match(QUOTE);
    if (q && pos >= ls + q[0].length) {
      if (!line.slice(q[0].length).trim()) return splice(text, ls, le, '', ls);
      return splice(text, pos, pos, '\n' + q[1] + q[2]);
    }
    return splice(text, pos, pos, '\n' + (line.trim() ? leading(line) : ''));
  }
  function indentSrc(d, dir) {
    const { text } = d;
    const first = lineStart(text, d.start), last = lineEnd(text, d.end);
    const multi = text.slice(d.start, d.end).includes('\n');
    const line = text.slice(first, lineEnd(text, d.start));
    if (dir > 0 && !multi && !LIST.test(line) && !QUOTE.test(line)) {
      const { text: t, pos } = cut(d);
      return splice(t, pos, pos, IND);
    }
    let head = 0, total = 0;
    const out = text.slice(first, last).split('\n').map((l, i) => {
      if (!l.trim() && dir > 0) return l;
      const n = dir > 0 ? IND + l : unindent(l);
      const dl = n.length - l.length;
      if (i === 0) head = dl;
      total += dl;
      return n;
    }).join('\n');
    const r = renumber(text.slice(0, first) + out + text.slice(last), 0);
    return doc_(r.text, Math.max(first, d.start + head), Math.max(first, d.end + (multi ? total : head)));
  }

  // ================================================================ the widget
  const mod = e => e.metaKey || e.ctrlKey;
  const modClick = e => (MAC ? e.metaKey : e.ctrlKey);   // on a Mac, Ctrl-click is the context menu and stays the browser's
  const sel = () => window.getSelection();
  const BLOCKS = 'P,DIV,LI,H1,H2,H3,H4,H5,H6,BLOCKQUOTE,PRE';
  function blockOf(node, root) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    while (n && n !== root) { if (n.matches && n.matches(BLOCKS)) return n; n = n.parentNode; }
    return null;
  }
  /* The link a click landed in, and where it goes: the href, or null when the
     click is not on a link or the link has nowhere real to go (safeHref leaves
     "#" behind for a URL it refused). Walks up by hand so tiny-dom can run it. */
  function linkOf(node, root) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    while (n && n !== root) { if (n.tagName === 'A') return n; n = n.parentNode; }
    return null;
  }
  function linkTarget(node, root) {
    const a = linkOf(node, root);
    const href = a && a.getAttribute('href');
    return href && !href.startsWith('#') ? href : null;
  }
  // text from the start of the block up to the caret — what the input rules match on
  function textBefore(block, r) {
    const pre = document.createRange();
    pre.selectNodeContents(block);
    try { pre.setEnd(r.startContainer, r.startOffset); } catch (e) { return ''; }
    return pre.toString();
  }
  function selectBack(block, r) {                          // select [block start, caret] so it can be deleted
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(r.startContainer, r.startOffset);
    const s = sel();
    s.removeAllRanges();
    s.addRange(range);
  }
  function mkBox(checked) {
    const b = document.createElement('input');
    b.type = 'checkbox';
    b.contentEditable = 'false';
    b.checked = !!checked;
    return b;
  }
  const mkEl = (tag, text, href) => {
    const el = document.createElement(tag);
    el.textContent = text;
    if (href) el.setAttribute('href', href);
    return el;
  };
  /* Drop an element in place of a range and leave the caret just outside it, so
     what you type next is not swallowed by the new mark. execCommand cannot be
     used here: at the end of a list item it plants the element after the </li>. */
  function put(range, el) {
    range.deleteContents();
    range.insertNode(el);
    const tail = document.createTextNode(ZW);
    el.parentNode.insertBefore(tail, el.nextSibling);
    const after = document.createRange();
    after.setStart(tail, 1);
    after.collapse(true);
    const s = sel();
    s.removeAllRanges();
    s.addRange(after);
  }
  function placeCaretAtEnd(node) {
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(false);
    const s = sel();
    s.removeAllRanges();
    s.addRange(r);
  }

  function create({ value = '', save, placeholder = '', onError = () => { } } = {}) {
    let saved = value, timer = null, mode = 'rich';

    const doc = document.createElement('div');
    doc.className = 'md-doc';
    doc.contentEditable = 'true';
    doc.spellcheck = true;
    doc.setAttribute('role', 'textbox');
    doc.setAttribute('aria-multiline', 'true');
    doc.setAttribute('aria-label', 'Notes');
    doc.dataset.placeholder = placeholder;
    doc.innerHTML = mdToHtml(value);

    const src = document.createElement('textarea');        // the Markdown tab
    src.className = 'md-src';
    src.hidden = true;
    src.spellcheck = true;
    src.setAttribute('aria-label', 'Notes as Markdown');

    const hint = document.createElement('div');
    hint.className = 'md-hint';
    hint.textContent = `“- ” bullet · “1. ” numbered · “[] ” to-do · Tab nests · ${CMD}B bold · ${MODCLICK} opens a link`;

    const el = document.createElement('div');
    el.className = 'md-editor';
    el.append(doc, src, hint);

    const status = document.createElement('span');
    status.className = 'md-status';
    const modeBtn = document.createElement('button');
    modeBtn.className = 'act';
    modeBtn.type = 'button';
    modeBtn.textContent = 'Markdown';
    modeBtn.title = `See the raw Markdown (${CMD}⇧M)`;

    const text = () => (mode === 'source' ? src.value.trim() : htmlToMd(doc));
    const dirty = () => text() !== saved;
    const setStatus = s => { status.textContent = s; };
    // Started counts as started: a bullet with nothing in it yet is not an empty note.
    const blank = () => !doc.textContent.trim() && !doc.querySelector('ul,ol,pre,blockquote,h1,h2,h3,h4,h5,h6,input,img,hr');
    const showPlaceholder = () => doc.classList.toggle('is-empty', blank());
    const grow = () => {
      src.style.height = 'auto';
      src.style.height = Math.min(Math.max(src.scrollHeight + 2, 132), Math.round(window.innerHeight * 0.5)) + 'px';
    };

    async function flush() {
      if (!save || !dirty()) return;
      clearTimeout(timer); timer = null;
      const t = text();
      setStatus('Saving…');
      try { await save(t); saved = t; setStatus(dirty() ? 'Unsaved' : 'Saved'); }
      catch (e) { setStatus('Not saved'); onError(e); }
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, 800); };
    const touched = () => { showPlaceholder(); setStatus(dirty() ? 'Unsaved' : 'Saved'); schedule(); };

    // ---------------------------------------------------------- input rules
    function currentLi() {
      const s = sel();
      if (!s.rangeCount) return null;
      const b = blockOf(s.getRangeAt(0).startContainer, doc);
      return b && b.tagName === 'LI' ? b : null;
    }
    function makeTask() {
      if (!currentLi()) document.execCommand('insertUnorderedList');
      const li = currentLi();
      if (!li) return;
      li.classList.add('task');
      if (!li.querySelector(':scope > input[type=checkbox]')) li.insertBefore(mkBox(false), li.firstChild);
    }
    /* "- " and friends, applied the moment the space lands: delete what you typed,
       then ask the browser for the real thing, so the change rides on the native
       undo stack instead of a private one. */
    const BLOCK_RULES = [
      [/^[-*+]\s$/, 'list', () => document.execCommand('insertUnorderedList')],
      [/^\d{1,9}[.)]\s$/, 'list', () => document.execCommand('insertOrderedList')],
      [/^\[[ xX]?\]\s$/, 'task', () => makeTask()],
      [/^(#{1,6})\s$/, 'block', m => document.execCommand('formatBlock', false, 'h' + Math.min(6, m[1].length))],
      [/^>\s$/, 'block', () => document.execCommand('formatBlock', false, 'blockquote')],
      [/^(```|~~~)$/, 'block', () => document.execCommand('formatBlock', false, 'pre')],
      [/^(-{3,}|\*{3,}|_{3,})$/, 'block', () => document.execCommand('insertHTML', false, '<hr><p><br></p>')],
    ];
    function blockRules() {
      const s = sel();
      if (!s.rangeCount || !s.isCollapsed) return false;
      const r = s.getRangeAt(0);
      const block = blockOf(r.startContainer, doc);
      if (!block || block.tagName === 'PRE') return false;
      const before = textBefore(block, r);
      for (const [re, kind, run] of BLOCK_RULES) {
        const m = before.match(re);
        if (!m) continue;
        // Already this kind of item: "- " would toggle the list off, so eat the
        // marker instead and leave the bullet you asked for. ("1. " on a bullet is
        // still a real request, and falls through to the command below.)
        if (kind === 'list' && block.tagName === 'LI' && block.parentNode.tagName === (re.source.startsWith('^\\d') ? 'OL' : 'UL')) {
          selectBack(block, r);
          document.execCommand('delete');
          return true;
        }
        selectBack(block, r);
        document.execCommand('delete');
        run(m);
        return true;
      }
      return false;
    }
    /* The same idea inline: finish "**bold**" or `code` and it becomes the thing
       it describes. The zero-width space is only a place to park the caret
       outside the new element; htmlToMd drops it. */
    const INLINE_RULES = [
      [/\*\*([^*\n]+)\*\*$/, m => mkEl('strong', m[1])],
      [/(?<!\*)\*([^*\n]+)\*$/, m => mkEl('em', m[1])],          // not the half-typed "**bold*"
      [/`([^`\n]+)`$/, m => mkEl('code', m[1])],
      [/~~([^~\n]+)~~$/, m => mkEl('del', m[1])],
      [/\[([^\]\n]+)\]\(([^)\s]+)\)$/, m => mkEl('a', m[1], safeHref(m[2]))],
    ];
    function inlineRules() {
      const s = sel();
      if (!s.rangeCount || !s.isCollapsed) return false;
      const r = s.getRangeAt(0);
      if (r.startContainer.nodeType !== 3) return false;
      const block = blockOf(r.startContainer, doc);
      if (!block || block.tagName === 'PRE') return false;
      const before = r.startContainer.textContent.slice(0, r.startOffset);
      for (const [re, build] of INLINE_RULES) {
        const m = before.match(re);
        if (!m) continue;
        const range = document.createRange();
        range.setStart(r.startContainer, r.startOffset - m[0].length);
        range.setEnd(r.startContainer, r.startOffset);
        put(range, build(m));
        return true;
      }
      return false;
    }
    /* Chrome grows a new list inside the paragraph it came from. Left alone, the
       document drifts from the shape it has when loaded from Markdown, so lift
       the list out whenever the paragraph was only holding it. */
    function tidy() {
      for (const list of doc.querySelectorAll('ul, ol')) {
        const box = list.parentNode;
        if (box === doc || !/^(P|DIV)$/.test(box.tagName)) continue;   // never the root: that is the editor itself
        const other = [...box.childNodes].some(n => n !== list && !isList(n)
          && (n.nodeType === 3 ? n.textContent.trim() : n.tagName !== 'BR'));
        if (other) continue;
        box.parentNode.insertBefore(list, box);
        if (!box.textContent.trim() && !box.querySelector('ul,ol,input,img,hr')) box.remove();
      }
    }
    /* Chrome keeps the class when it clones a to-do item but not the checkbox
       inside it: put one back, and never carry a tick onto a fresh item. */
    function normalizeTasks() {
      for (const li of doc.querySelectorAll('li.task')) {
        const boxes = li.querySelectorAll(':scope > input[type=checkbox]');
        if (!boxes.length) li.insertBefore(mkBox(false), li.firstChild);
        else boxes.forEach(b => { b.contentEditable = 'false'; });
      }
      doc.querySelectorAll('li:not(.task) > input[type=checkbox]').forEach(b => b.remove());
    }

    // ---------------------------------------------------------- events
    let applying = false;                                  // a rule's own edit must not re-trigger the rules
    doc.addEventListener('input', e => {
      if (!applying && (!e.inputType || /^insert(Text|Composition|Replacement)/.test(e.inputType))) {
        applying = true;
        try { if (!blockRules()) inlineRules(); } finally { applying = false; }
      }
      tidy();
      normalizeTasks();
      touched();
    });
    doc.addEventListener('blur', flush);
    /* Links stay editable text: a plain click puts the caret in one, the way it
       does in any editor. ⌘-click (Ctrl-click elsewhere) opens it in a new tab,
       and the caret stays put — that click was about the page, not the note. */
    const linkHit = e => (modClick(e) ? linkTarget(e.target, doc) : null);
    doc.addEventListener('mousedown', e => { if (linkHit(e)) e.preventDefault(); });
    doc.addEventListener('mouseover', e => { const a = linkOf(e.target, doc); if (a && !a.title) a.title = `${MODCLICK} to open`; });
    doc.addEventListener('click', e => {
      // ticking a box is a change to the note: save the state the browser lands on
      if (e.target.tagName === 'INPUT' && e.target.type === 'checkbox') { touched(); flush(); return; }
      const href = linkHit(e);
      if (href) { e.preventDefault(); window.open(href, '_blank', 'noopener'); }
    });
    doc.addEventListener('keydown', e => {
      const k = e.key;
      if (k === 'Tab') {                                   // nest / unnest the item you are in
        if (!currentLi()) return;                          // outside a list, leave Tab to the browser
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'outdent' : 'indent');
        tidy();
        normalizeTasks();
        touched();
        return;
      }
      if (k === 'Enter' && !e.shiftKey && !mod(e)) {
        const li = currentLi();
        if (!li || !li.classList.contains('task')) return;  // the browser's own list handling is right
        if (!inlineMd(li, c => c.tagName === 'INPUT').trim()) {
          li.querySelectorAll(':scope > input[type=checkbox]').forEach(b => b.remove());
          li.classList.remove('task');                     // empty: let the browser leave the list
          return;
        }
        requestAnimationFrame(() => {                      // the item you just started is a fresh, unticked to-do
          const now = currentLi();
          if (now && now !== li) {
            now.classList.add('task');
            now.querySelectorAll(':scope > input[type=checkbox], :scope > br').forEach(b => b.remove());
            now.insertBefore(mkBox(false), now.firstChild);
            placeCaretAtEnd(now);
          }
          touched();
        });
        return;
      }
      if (k === 'Backspace') {                             // at the head of an item, step back out of it
        const li = currentLi();
        const s = sel();
        if (!li || !s.isCollapsed || !s.rangeCount || textBefore(li, s.getRangeAt(0))) return;
        e.preventDefault();
        if (li.classList.contains('task')) {                // the box goes first, the item stays
          li.querySelectorAll(':scope > input[type=checkbox]').forEach(b => b.remove());
          li.classList.remove('task');
        } else {
          document.execCommand('outdent');                  // nested: up a level; top level: back to a paragraph
          tidy();
        }
        touched();
        return;
      }
      if (!mod(e)) return;
      const low = k.toLowerCase();
      if (low === 's') { e.preventDefault(); flush(); return; }
      if (e.shiftKey) {
        if (low === 'm') { e.preventDefault(); setMode(mode === 'source' ? 'rich' : 'source'); }
        else if (k === '8' || k === '*') { e.preventDefault(); document.execCommand('insertUnorderedList'); touched(); }
        else if (k === '7' || k === '&') { e.preventDefault(); document.execCommand('insertOrderedList'); touched(); }
        else if (k === '9' || k === '(') { e.preventDefault(); makeTask(); touched(); }
        return;
      }
      if (low === 'e') {                                   // inline code has no native command
        e.preventDefault();
        const s = sel();
        if (s.rangeCount && s.toString()) put(s.getRangeAt(0), mkEl('code', s.toString()));
        touched();
      } else if (low === 'k') {
        e.preventDefault();
        const s = sel();
        const text = s.toString();
        const url = window.prompt('Link to', 'https://');
        if (!url) return;
        if (text) document.execCommand('createLink', false, url);
        else if (s.rangeCount) put(s.getRangeAt(0), mkEl('a', url, safeHref(url)));
        touched();
      }
      // ⌘B and ⌘I are the browser's own and already do the right thing
    });
    /* Chrome cannot paste blocks into a list item. A bare list is fine — its
       items are spliced into the list you are in — and so is one paragraph, which
       becomes the item's text. Anything more lands inside the <li>, or loose
       inside the <ul>, and the note comes back as one long item with every
       heading run together ("Semantic IDPretrainingSFTRL"). So such a paste first
       steps out of the list: split an empty item off at the caret and outdent it
       until it is a block of its own, then paste there. Every step is an
       execCommand, so ⌘Z still walks back through the whole paste. */
    const emptyLi = li => !!li && li.tagName === 'LI' && !inlineMd(li, c => c.tagName === 'INPUT').trim() && !li.querySelector('ul,ol,img');
    function pastesInPlace(html) {
      const t = document.createElement('template');
      t.innerHTML = html;
      const top = [...t.content.childNodes].filter(n => n.nodeType === 1 || n.textContent.trim());
      return top.length === 1 && (isList(top[0]) || top[0].tagName === 'P');
    }
    function leaveList() {
      let li = currentLi();
      if (!li) return;
      if (!emptyLi(li)) {
        const inner = li.querySelectorAll('li');
        if (inner.length) placeCaretAtEnd(inner[inner.length - 1]);   // past its nested list, or Chrome carries the list along
        document.execCommand('insertParagraph');
        li = currentLi();
        if (li && !emptyLi(li)) {                          // the caret stayed with the text: the empty item is the one before it
          if (!emptyLi(li.previousElementSibling)) document.execCommand('insertParagraph');
          li = currentLi();
          if (li && emptyLi(li.previousElementSibling)) placeCaretAtEnd(li.previousElementSibling);
        }
      }
      for (let i = 0; i < 12 && (li = currentLi()); i++) {
        li.querySelectorAll(':scope > input[type=checkbox]').forEach(b => b.remove());   // outdent would leave a to-do's box on the floor
        li.classList.remove('task');
        document.execCommand('outdent');
      }
    }
    /* Paste: Markdown becomes real blocks, a URL over a selection becomes a link,
       anything else falls through to the browser. */
    doc.addEventListener('paste', e => {
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (!t) return;
      if (!t.includes('\n') && URLISH.test(t.trim())) {
        if (sel().toString()) { e.preventDefault(); document.execCommand('createLink', false, t.trim()); touched(); }
        return;
      }
      if (t.includes('\n') || LIST.test(t) || /^#{1,6}\s/.test(t)) {
        e.preventDefault();
        const html = mdToHtml(t);
        if (!pastesInPlace(html)) leaveList();
        document.execCommand('insertHTML', false, html);
        tidy();
        normalizeTasks();
        touched();
      }
    });

    // ---------------------------------------------------------- the Markdown tab
    src.addEventListener('input', () => { grow(); touched(); });
    src.addEventListener('blur', flush);
    src.addEventListener('keydown', e => {
      const read = () => doc_(src.value, src.selectionStart, src.selectionEnd);
      const apply = next => {
        src.focus();
        src.setSelectionRange(0, src.value.length);
        if (!document.execCommand('insertText', false, next.text)) src.value = next.text;
        src.setSelectionRange(next.start, next.end);
        grow();
        touched();
      };
      if (e.key === 'Enter' && !e.shiftKey && !mod(e)) { e.preventDefault(); apply(enter(read())); }
      else if (e.key === 'Tab' && !mod(e)) { e.preventDefault(); apply(indentSrc(read(), e.shiftKey ? -1 : 1)); }
      else if (mod(e) && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); }
      else if (mod(e) && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); setMode('rich'); }
    });

    function setMode(next) {
      if (next === mode) return;
      const md = text();
      mode = next;
      if (mode === 'source') { src.value = md; src.hidden = false; doc.hidden = true; grow(); src.focus(); }
      else { doc.innerHTML = mdToHtml(md); doc.hidden = false; src.hidden = true; doc.focus(); }
      modeBtn.textContent = mode === 'source' ? 'Formatted' : 'Markdown';
      modeBtn.title = mode === 'source' ? `Back to formatted notes (${CMD}⇧M)` : `See the raw Markdown (${CMD}⇧M)`;
      hint.hidden = mode === 'source';
      el.dataset.mode = mode;
      showPlaceholder();
    }
    modeBtn.addEventListener('click', () => setMode(mode === 'source' ? 'rich' : 'source'));

    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* older engines */ }
    el.dataset.mode = mode;
    setStatus('');
    showPlaceholder();

    return {
      el, status, modeBtn,
      focus: () => (mode === 'source' ? src : doc).focus(),
      isDirty: dirty,
      flush,
      value: text,
      /* The poll rebuilds the inspector every few seconds; it must never overwrite
         what you are in the middle of writing. */
      setRemote(next) {
        if (next === saved || dirty()) return;
        const active = document.activeElement;
        if (active === doc || active === src || doc.contains(active)) return;
        saved = next;
        if (mode === 'source') { src.value = next; grow(); } else doc.innerHTML = mdToHtml(next);
        showPlaceholder();
        setStatus('');
      },
      destroy() { clearTimeout(timer); return flush(); },
    };
  }

  /* While the modifier is down, links show a pointer: the one moment a click
     follows them. Tracked once for the page, not per editor, so nothing leaks
     when the inspector swaps cards. */
  if (typeof window !== 'undefined') {
    const track = e => document.documentElement.classList.toggle('mod-held', modClick(e));
    window.addEventListener('keydown', track);
    window.addEventListener('keyup', track);
    window.addEventListener('blur', () => document.documentElement.classList.remove('mod-held'));
  }

  return { create, mdToHtml, htmlToMd, _t: { enter, indent: indentSrc, renumber, doc: doc_, linkTarget } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NoteEditor;   // for the node-run unit tests
