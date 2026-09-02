/* folio note editor: Markdown you can actually type in.

   A plain <textarea> that behaves the way Notion and Obsidian do — "- " starts a
   list and Enter keeps it going, Tab nests, ⌘B wraps — plus a Preview that
   renders the same Markdown the file holds. Nothing here is a rich-text model:
   the text in the box IS the text on disk, which is what keeps notes readable in
   an editor, in git, and in Obsidian.

   Two rules worth knowing before editing this file:
   * Every edit goes through applyText(), which rewrites only the span that
     actually changed, via execCommand('insertText'). That is the one way to
     change a textarea without throwing away the browser's own undo stack.
   * The transforms below (enter, indent, toggleList, …) are pure functions of
     {text, start, end} and touch no DOM, so they can be tested directly. */
'use strict';

var NoteEditor = (function () {

  const IND = '    ';                                     // 4 spaces: what python-markdown needs to nest a list
  const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?/;
  const QUOTE = /^([ \t]*)((?:>[ \t]?)+)/;
  const URLISH = /^(https?:\/\/|mailto:)\S+$/i;
  const NUL = '\u0000';                                   // placeholder while code spans are held aside
  const MAC = typeof navigator === 'undefined' || /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent);
  const CMD = MAC ? '⌘' : 'Ctrl+';                       // the same shortcuts, named the way this keyboard names them

  // ---------------------------------------------------------------- text helpers
  const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1;
  const lineEnd = (t, i) => { const j = t.indexOf('\n', i); return j < 0 ? t.length : j; };
  const leading = l => (l.match(/^[ \t]*/) || [''])[0];
  const width = s => s.replace(/\t/g, IND).length;
  const unindent = l => l.replace(l.startsWith('\t') ? /^\t/ : new RegExp('^ {1,' + IND.length + '}'), '');
  // A fenced code block swallows every rule below it, so Enter must stay dumb inside one.
  function inFence(text, pos) {
    let open = false;
    for (const l of text.slice(0, pos).split('\n')) if (/^[ \t]*(```|~~~)/.test(l)) open = !open;
    return open;
  }
  const doc = (text, start, end = start) => ({ text, start, end });
  // Collapse a selection: every transform below acts on a single caret.
  const cut = d => (d.start === d.end
    ? { text: d.text, pos: d.start }
    : { text: d.text.slice(0, d.start) + d.text.slice(d.end), pos: d.start });
  const splice = (text, from, to, s, caret) => doc(text.slice(0, from) + s + text.slice(to), caret == null ? from + s.length : caret);

  /* Rewrite ordered-list numbers so a list still reads 1,2,3 after an insert, an
     indent or a paste. `pos` is carried through: a line rewritten before the caret
     moves it, so we hand back the corrected offset rather than make callers guess. */
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
          } else counters.set(ind, 1);                       // a bullet at this depth restarts numbering
        }
      }
      if (next !== old) { lines[i] = next; if (at < pos) delta += next.length - old.length; }
      at += old.length + 1;
    }
    return doc(lines.join('\n'), pos + delta);
  }

  // ---------------------------------------------------------------- transforms
  /* Enter: keep the list, task list or quote you are inside going. On an empty
     item it steps out one level at a time — outdent, then drop the marker. */
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

  /* Tab / ⇧Tab. Anywhere inside a list item it nests or unnests the whole item,
     the way Notion does; elsewhere it is an ordinary four-space indent. */
  function indent(d, dir) {
    const { text } = d;
    const first = lineStart(text, d.start), last = lineEnd(text, d.end);
    const multi = text.slice(d.start, d.end).includes('\n');
    const line = text.slice(first, lineEnd(text, d.start));
    if (dir > 0 && !multi && !LIST.test(line) && !QUOTE.test(line)) {
      const { text: t, pos } = cut(d);
      return splice(t, pos, pos, IND);
    }
    const lines = text.slice(first, last).split('\n');
    let head = 0, total = 0;
    const out = lines.map((l, i) => {
      if (!l.trim() && dir > 0) return l;
      const n = dir > 0 ? IND + l : unindent(l);
      const dl = n.length - l.length;
      if (i === 0) head = dl;
      total += dl;
      return n;
    }).join('\n');
    const r = renumber(text.slice(0, first) + out + text.slice(last), 0);
    return doc(r.text, Math.max(first, d.start + head), Math.max(first, d.end + (multi ? total : head)));
  }

  /* ⌘⇧8 / ⌘⇧7 / ⌘⇧9 — turn the selected lines into a bullet, numbered or to-do
     list, or take the markers away again if they are already that kind. */
  function toggleList(d, kind) {
    const { text } = d;
    const first = lineStart(text, d.start), last = lineEnd(text, d.end);
    const lines = text.slice(first, last).split('\n');
    const isKind = l => {
      const m = l.match(LIST);
      if (!m) return false;
      return kind === 'task' ? !!m[4] : kind === 'ordered' ? /^\d/.test(m[2]) && !m[4] : /^[-*+]$/.test(m[2]) && !m[4];
    };
    const body = lines.filter(l => l.trim());
    const off = body.length > 0 && body.every(isKind);
    const out = lines.map(l => {
      if (!l.trim()) return l;
      const m = l.match(LIST), ind = m ? m[1] : leading(l), rest = m ? l.slice(m[0].length) : l.slice(ind.length);
      return off ? ind + rest : ind + (kind === 'ordered' ? '1. ' : kind === 'task' ? '- [ ] ' : '- ') + rest;
    }).join('\n');
    const r = renumber(text.slice(0, first) + out + text.slice(last), 0);
    return doc(r.text, first, first + out.length);
  }

  // Backspace at the head of an item's text peels off one level, then the marker.
  function backspace(d) {
    if (d.start !== d.end) return null;
    const { text } = d, pos = d.start;
    const ls = lineStart(text, pos), le = lineEnd(text, pos), line = text.slice(ls, le);
    const m = line.match(LIST);
    if (!m || pos !== ls + m[0].length) return null;
    if (width(m[1]) >= IND.length) {
      const out = unindent(m[1]) + line.slice(m[1].length);
      return renumber(text.slice(0, ls) + out + text.slice(le), ls + out.length - (line.length - m[0].length));
    }
    return renumber(text.slice(0, ls) + line.slice(m[0].length) + text.slice(le), ls);
  }

  // ⌘B / ⌘I / ⌘E — wrap the selection, or the word under the caret, and unwrap it again.
  function wrapInline(d, before, after = before) {
    let { text, start, end } = d;
    if (start === end) {                                     // no selection: take the word under the caret
      const ls = lineStart(text, start), le = lineEnd(text, start);
      let s = start, e = end;
      while (s > ls && /[\w'’-]/.test(text[s - 1])) s--;
      while (e < le && /[\w'’-]/.test(text[e])) e++;
      if (e > s) { start = s; end = e; }
    }
    const sel = text.slice(start, end);
    if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length)
      return doc(text.slice(0, start) + sel.slice(before.length, sel.length - after.length) + text.slice(end), start, end - before.length - after.length);
    if (text.slice(start - before.length, start) === before && text.slice(end, end + after.length) === after)
      return doc(text.slice(0, start - before.length) + sel + text.slice(end + after.length), start - before.length, end - before.length);
    return doc(text.slice(0, start) + before + sel + after + text.slice(end), start + before.length, end + before.length);
  }

  // ⌘K — a link, with whichever half you still have to type left selected.
  function link(d) {
    let { text, start, end } = d;
    if (start === end) {
      const ls = lineStart(text, start), le = lineEnd(text, start);
      let s = start, e = end;
      while (s > ls && /\S/.test(text[s - 1])) s--;
      while (e < le && /\S/.test(text[e])) e++;
      if (e > s) { start = s; end = e; }
    }
    const sel = text.slice(start, end);
    if (URLISH.test(sel)) return doc(text.slice(0, start) + '[](' + sel + ')' + text.slice(end), start + 1);
    const out = '[' + sel + '](url)';
    return doc(text.slice(0, start) + out + text.slice(end), start + out.length - 4, start + out.length - 1);
  }

  /* Paste, with the two conveniences everyone expects: a URL dropped on selected
     text becomes a link, and pasted lines dropped into a list join the list. */
  function pasteInto(d, pasted) {
    const clean = pasted.replace(/\r\n?/g, '\n');
    if (d.start !== d.end && !clean.includes('\n') && URLISH.test(clean.trim())) {
      const sel = d.text.slice(d.start, d.end);
      const out = '[' + sel + '](' + clean.trim() + ')';
      return doc(d.text.slice(0, d.start) + out + d.text.slice(d.end), d.start + out.length);
    }
    if (clean.includes('\n')) {
      const { text, pos } = cut(d);
      const ls = lineStart(text, pos), line = text.slice(ls, lineEnd(text, pos));
      const m = line.match(LIST);
      const rows = clean.split('\n');
      if (m && pos >= ls + m[0].length && !rows.some(r => LIST.test(r))) {
        const marker = /^\d/.test(m[2]) ? m[1] + '1' + m[2].slice(-1) + m[3] : m[1] + m[2] + m[3] + (m[4] ? '[ ] ' : '');
        const joined = rows.map((r, i) => (i ? marker + r.trim() : r)).join('\n');
        const out = splice(text, pos, pos, joined);
        return renumber(out.text, out.start);
      }
    }
    return null;                                             // nothing clever to do — let the browser paste
  }

  // ---------------------------------------------------------------- preview
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const esc = s => s.replace(/[&<>"]/g, c => ESC[c]);
  const safeHref = u => (/^(https?:|mailto:|#|\/|\.{0,2}\/)/i.test(u) ? u : '#');
  function inline(s) {
    const code = [];
    let t = esc(s).replace(/`([^`]+)`/g, (m, c) => { code.push(c); return NUL + (code.length - 1) + NUL; });
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, a, u) => `<img src="${safeHref(u)}" alt="${a}">`);
    t = t.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (m, a, u) => `<a href="${safeHref(u)}" target="_blank" rel="noopener">${a || u}</a>`);
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, p, u) => `${p}<a href="${safeHref(u)}" target="_blank" rel="noopener">${u}</a>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>').replace(/==([^=]+)==/g, '<mark>$1</mark>');
    return t.replace(new RegExp(NUL + '(\\d+)' + NUL, 'g'), (m, i) => `<code>${code[i]}</code>`);
  }
  /* Renders the subset the notes actually use. Task boxes carry their source line
     number, so a click in the preview can flip that one character in the file. */
  function mdHtml(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [], stack = [];                              // open lists: {indent, tag}
    let para = [], fence = null, quote = [];
    const closeLists = to => { while (stack.length && stack[stack.length - 1].indent > to) out.push(`</li></${stack.pop().tag}>`); };
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${mdHtml(quote.join('\n'))}</blockquote>`); quote = []; } };
    const flush = () => { flushPara(); flushQuote(); closeLists(-1); };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
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
      if (hd) { flush(); const n = hd[1].length; out.push(`<h${n}>${inline(hd[2])}</h${n}>`); continue; }
      if (li) {
        flushPara();
        const ind = width(li[1]), tag = /^\d/.test(li[2]) ? 'ol' : 'ul';
        closeLists(ind);
        const top = stack[stack.length - 1];
        if (!top || top.indent < ind) { stack.push({ indent: ind, tag }); out.push(`<${tag}><li>`); }
        else if (top.tag !== tag) { out.push(`</li></${stack.pop().tag}>`); stack.push({ indent: ind, tag }); out.push(`<${tag}><li>`); }
        else out.push('</li><li>');
        const rest = l.slice(li[0].length);
        if (li[4]) {
          const on = /x/i.test(li[4]);
          out.push(`<label class="md-task"><input type="checkbox" data-line="${i}"${on ? ' checked' : ''}><span${on ? ' class="md-done"' : ''}>${inline(rest)}</span></label>`);
        } else out.push(inline(rest));
        continue;
      }
      if (stack.length) { out.push(' ' + inline(l.trim())); continue; }   // lazy continuation of an item
      para.push(l.trim());
    }
    if (fence !== null) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
    flush();
    return out.join('');
  }

  // ---------------------------------------------------------------- the widget
  /* Writes only the span that changed, so ⌘Z walks back through your own edits
     instead of undoing the whole note in one gulp. */
  function applyText(ta, next) {
    const cur = ta.value;
    if (cur !== next.text) {
      const max = Math.min(cur.length, next.text.length);
      let a = 0;
      while (a < max && cur[a] === next.text[a]) a++;
      let b = 0;
      while (b < max - a && cur[cur.length - 1 - b] === next.text[next.text.length - 1 - b]) b++;
      const from = a, to = cur.length - b, insert = next.text.slice(a, next.text.length - b);
      ta.focus();
      ta.setSelectionRange(from, to);
      const ok = insert ? document.execCommand('insertText', false, insert) : document.execCommand('delete');
      if (!ok || ta.value !== next.text) ta.value = next.text;            // browsers without execCommand: correctness first
    }
    ta.setSelectionRange(next.start, next.end);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const read = ta => doc(ta.value, ta.selectionStart, ta.selectionEnd);
  const mod = e => e.metaKey || e.ctrlKey;

  function create({ value = '', save, placeholder = '', onError = () => { } } = {}) {
    let saved = value, timer = null, mode = 'write';

    const ta = document.createElement('textarea');
    ta.className = 'md-src';
    ta.value = value;
    ta.placeholder = placeholder;
    ta.spellcheck = true;
    ta.setAttribute('aria-label', 'Notes, in Markdown');

    const view = document.createElement('div');
    view.className = 'notes-view md-preview';
    view.hidden = true;

    const hint = document.createElement('div');
    hint.className = 'md-hint';
    hint.textContent = `“- ” bullet · Tab nest · ${CMD}B bold · ${CMD}K link · ${CMD}⇧9 to-do`;

    const el = document.createElement('div');
    el.className = 'md-editor';
    el.dataset.mode = mode;
    el.append(ta, view, hint);

    const status = document.createElement('span');
    status.className = 'md-status';
    const modeBtn = document.createElement('button');
    modeBtn.className = 'act';
    modeBtn.type = 'button';
    modeBtn.title = `Show the notes rendered (${CMD}⇧P)`;
    modeBtn.textContent = 'Preview';

    const dirty = () => ta.value !== saved;
    const setStatus = s => { status.textContent = s; };
    const grow = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(Math.max(ta.scrollHeight + 2, 132), Math.round(window.innerHeight * 0.5)) + 'px';
    };

    async function flush() {
      if (!dirty() || !save) return;
      clearTimeout(timer); timer = null;
      const text = ta.value;
      setStatus('Saving…');
      try { await save(text); saved = text; setStatus(dirty() ? 'Unsaved' : 'Saved'); }
      catch (e) { setStatus('Not saved'); onError(e); }
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, 800); };

    const renderPreview = () => {
      view.innerHTML = ta.value.trim() ? mdHtml(ta.value) : '<p class="md-empty">Nothing yet — switch to Write and start typing.</p>';
    };
    function setMode(next) {
      mode = next;
      const preview = mode === 'preview';
      ta.hidden = preview; view.hidden = !preview; hint.hidden = preview;
      modeBtn.textContent = preview ? 'Write' : 'Preview';
      modeBtn.title = preview ? `Back to editing (${CMD}⇧P)` : `Show the notes rendered (${CMD}⇧P)`;
      el.dataset.mode = mode;
      if (preview) { flush(); renderPreview(); } else { grow(); ta.focus(); }
    }
    modeBtn.addEventListener('click', () => setMode(mode === 'preview' ? 'write' : 'preview'));

    // a box ticked in the preview flips that character in the source
    view.addEventListener('change', e => {
      const box = e.target.closest('input[type=checkbox][data-line]');
      if (!box) return;
      const lines = ta.value.split('\n'), i = +box.dataset.line;
      if (lines[i] === undefined) return;
      lines[i] = lines[i].replace(/\[[ xX]\]/, box.checked ? '[x]' : '[ ]');
      ta.value = lines.join('\n');
      renderPreview();
      flush();
    });

    ta.addEventListener('input', () => { grow(); setStatus(dirty() ? 'Unsaved' : 'Saved'); schedule(); });
    ta.addEventListener('blur', flush);
    ta.addEventListener('paste', e => {
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (!t) return;
      const next = pasteInto(read(ta), t);
      if (next) { e.preventDefault(); applyText(ta, next); }
    });
    ta.addEventListener('keydown', e => {
      const k = e.key;
      if (k === 'Enter' && mod(e)) { e.preventDefault(); flush(); return; }
      if (k === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); applyText(ta, enter(read(ta))); return; }
      if (k === 'Tab' && !e.altKey && !mod(e)) { e.preventDefault(); applyText(ta, indent(read(ta), e.shiftKey ? -1 : 1)); return; }
      if (k === 'Backspace' && !mod(e)) { const n = backspace(read(ta)); if (n) { e.preventDefault(); applyText(ta, n); } return; }
      if (!mod(e)) return;
      const low = k.toLowerCase();
      if (low === 's') { e.preventDefault(); flush(); return; }
      if (e.shiftKey) {
        if (low === 'p') { e.preventDefault(); setMode(mode === 'preview' ? 'write' : 'preview'); }
        else if (k === '8' || k === '*') { e.preventDefault(); applyText(ta, toggleList(read(ta), 'bullet')); }
        else if (k === '7' || k === '&') { e.preventDefault(); applyText(ta, toggleList(read(ta), 'ordered')); }
        else if (k === '9' || k === '(') { e.preventDefault(); applyText(ta, toggleList(read(ta), 'task')); }
        return;
      }
      if (low === 'b') { e.preventDefault(); applyText(ta, wrapInline(read(ta), '**')); }
      else if (low === 'i') { e.preventDefault(); applyText(ta, wrapInline(read(ta), '*')); }
      else if (low === 'e') { e.preventDefault(); applyText(ta, wrapInline(read(ta), '`')); }
      else if (low === 'k') { e.preventDefault(); applyText(ta, link(read(ta))); }
    });

    setStatus('');
    requestAnimationFrame(grow);

    return {
      el, status, modeBtn,
      focus: () => ta.focus(),
      isDirty: dirty,
      flush,
      value: () => ta.value,
      /* The poll rebuilds the inspector every few seconds; it must never overwrite
         what you are in the middle of writing. */
      setRemote(next) {
        if (next === saved || dirty() || document.activeElement === ta) return;
        saved = next;
        ta.value = next;
        grow();
        if (mode === 'preview') renderPreview();
        setStatus('');
      },
      destroy() { clearTimeout(timer); return flush(); },
    };
  }

  return { create, mdHtml, _t: { enter, indent, toggleList, backspace, wrapInline, link, pasteInto, renumber, doc } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NoteEditor;   // for the node-run unit tests
