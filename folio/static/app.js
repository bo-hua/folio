/* folio UI: dashboard, item detail, sessions. Vanilla JS, hash routing, no build step. */
'use strict';

const STATE_LABEL = {
  needs_you: 'Needs you', working: 'Working', ready: 'Ready', ended: 'Ended',
  inactive: 'Inactive', unknown: 'No runtime info',
};
const STATUS_ORDER = ['active', 'waiting', 'idea', 'parked', 'done'];
const STATUS_TITLE = { active: 'Active', waiting: 'Waiting', idea: 'Ideas', parked: 'Parked', done: 'Recently done' };

// ------------------------------------------------------------------ helpers
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'value') node.value = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  catch (e) { window.prompt('Copy this command:', text); }
}

function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const PLURALS = { child: 'children' };
function plural(n, word) { return `${n} ${n === 1 ? word : (PLURALS[word] || word + 's')}`; }
function statusBadge(status) { return el('span', { class: `badge status-${status}` }, status); }
function stateBadge(state, reason) {
  const label = STATE_LABEL[state] || state;
  return el('span', { class: `badge st-${state}`, title: reason ? `needs ${reason}` : '' },
    el('span', { class: `dot ${state}` }), label, reason ? ` · ${reason}` : '');
}
function attentionBadge(agg) {
  if (!agg || !agg.level) return null;
  if (agg.level === 'needs_you') return el('span', { class: 'badge st-needs_you' }, el('span', { class: 'dot needs_you' }), `${plural(agg.needs_you, 'session')} need${agg.needs_you === 1 ? 's' : ''} you`);
  return el('span', { class: 'badge st-working' }, el('span', { class: 'dot working' }), `${plural(agg.working, 'session')} working`);
}
function isEditing() {
  const a = document.activeElement;
  return a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT') || document.querySelector('.editing');
}
function shortPath(p) {
  if (!p) return '';
  const home = p.match(/^\/(?:Users|home)\/[^/]+/);
  return home ? '~' + p.slice(home[0].length) : p;
}

// ------------------------------------------------------------------ layout
function topbar(ov) {
  const repo = ov && ov.repo;
  return el('header', { class: 'topbar' },
    el('a', { class: 'brand', href: '#/' }, 'folio'),
    el('nav', {}, el('a', { href: '#/' }, 'Dashboard'), el('a', { href: '#/sessions' }, 'Sessions'), el('a', { href: '#/new' }, '+ New item')),
    el('span', { class: 'grow' }),
    repo ? el('span', { class: 'repo', title: repo.error || (repo.worktrees || []).map(w => `${w.branch || '(detached)'}  ${w.path}`).join('\n') },
      repo.error ? `⚠ ${repo.error}` : `${shortPath(repo.path)} · ${plural(repo.worktrees.length, 'worktree')}`) : null,
  );
}

function page(ov, ...content) {
  const app = document.getElementById('app');
  app.replaceChildren(topbar(ov), el('main', {}, ...content));
}

function showError(err) {
  const app = document.getElementById('app');
  app.replaceChildren(topbar(null), el('main', {}, el('div', { class: 'error' }, String(err.message || err))));
}

// ------------------------------------------------------------------ dashboard
async function renderDashboard() {
  const [ov, observed] = await Promise.all([api('GET', '/api/overview'), api('GET', '/api/sessions').catch(() => ({ sessions: [] }))]);
  const byId = Object.fromEntries(ov.items.map(i => [i.id, i]));
  const top = ov.items.filter(i => !i.parent || !byId[i.parent]);
  const needs = ov.items.filter(i => i.attention.level === 'needs_you');
  const working = ov.items.filter(i => i.attention.level === 'working');

  const attentionPanel = (cls, title, list) => el('div', { class: `panel ${cls}` },
    el('h3', {}, title, ' ', el('span', { class: 'muted' }, `(${list.length})`)),
    list.length ? list.map(i => el('div', {}, el('a', { href: `#/item/${i.id}` }, i.name), ' ', el('span', { class: 'muted small' }, `${i.area} · ${plural(i.attention[cls === 'needs' ? 'needs_you' : 'working'], 'session')}`)))
      : el('div', { class: 'muted small' }, cls === 'needs' ? 'Nothing is waiting on you.' : 'No agent threads running.'));

  const areas = ov.areas.map(a => areaSection(a, top.filter(i => i.area === a.name), byId));
  const live = observed.sessions.filter(s => s.state !== 'ended' && s.state !== 'inactive');
  const unattached = live.filter(s => !s.attached_to.length);
  const observedPanel = el('div', { class: 'panel observed' },
    el('h3', {}, 'Observed Claude sessions in this repo ', el('span', { class: 'muted' }, `(${live.length} live · ${unattached.length} unattached)`),
      el('span', { class: 'grow' }), el('a', { href: '#/sessions', class: 'small' }, 'all sessions →')),
    live.length ? el('div', { class: 'obs-rows' }, live.slice(0, 6).map(s => el('div', { class: 'obs-row' },
      el('span', { class: 'mono' }, s.short_id), stateBadge(s.state, s.attention),
      el('span', { class: 'mono muted small' }, s.branch ? `[${s.branch}]` : '', ' ', shortPath(s.cwd)),
      el('span', { class: 'grow' }),
      s.attached_to.length ? el('span', { class: 'small' }, 'on ', s.attached_to.map((a, i) => [i ? ', ' : '', el('a', { href: `#/item/${a.id}` }, a.name)]))
        : el('a', { href: '#/sessions', class: 'small' }, 'attach to an item'))))
      : el('div', { class: 'muted small' }, 'No live sessions observed yet. New Claude Code sessions started inside the configured repo will appear here once the hook is installed (folio hooks install); sessions started before the install must be restarted.'));
  page(ov,
    el('div', { class: 'attention' }, attentionPanel('needs', 'Needs you', needs), attentionPanel('working', 'Working', working)),
    observedPanel,
    ...areas,
    el('div', { class: 'row', style: 'margin-top:8px' },
      el('button', { onclick: async () => {
        const name = window.prompt('New area name');
        if (!name) return;
        try { await api('POST', '/api/areas', { name }); route(); } catch (e) { toast(e.message); }
      } }, '+ New area'),
      el('span', { class: 'muted small' }, `data: ${shortPath(ov.data_dir)}/items/<Area>/*.md`)),
  );
}

function areaSection(area, items, byId) {
  const quick = el('input', { type: 'text', placeholder: `Quick idea in ${area.name}…`, onkeydown: async (e) => {
    if (e.key !== 'Enter' || !quick.value.trim()) return;
    try { await api('POST', '/api/items', { name: quick.value.trim(), area: area.name, status: 'idea' }); quick.value = ''; route(); }
    catch (err) { toast(err.message); }
  } });
  const columns = STATUS_ORDER.map(status => {
    let list = items.filter(i => i.status === status);
    if (status === 'done') list = list.sort((a, b) => (b.updated || '').localeCompare(a.updated || '')).slice(0, 5);
    return el('div', { class: 'column' },
      el('h4', {}, STATUS_TITLE[status], ' ', el('span', { class: 'muted' }, list.length || '')),
      list.length ? list.map(i => card(i, byId)) : el('div', { class: 'empty' }, '—'));
  });
  return el('section', { class: 'area' },
    el('div', { class: 'area-head' },
      el('h2', {}, area.name), el('span', { class: 'muted small' }, plural(area.count, 'item')),
      el('span', { class: 'grow' }),
      el('div', { class: 'quick' }, quick, el('a', { href: `#/new?area=${encodeURIComponent(area.name)}`, class: 'small' }, 'full form'))),
    el('div', { class: 'columns' }, ...columns));
}

function card(item, byId) {
  const roll = item.rollup || item.attention;
  const kids = item.children.map(id => byId[id]).filter(Boolean);
  return el('a', { class: `card ${roll.level ? 'card-' + roll.level : ''}`, href: `#/item/${item.id}` },
    el('div', { class: 'card-title' }, item.name),
    el('div', { class: 'card-meta' },
      attentionBadge(roll),
      item.sessions.length ? el('span', {}, plural(item.sessions.length, 'session')) : null,
      kids.length ? el('span', {}, plural(kids.length, 'child')) : null,
      item.has_ai_state ? el('span', { title: 'has AI state' }, '✦ AI state') : null,
      el('span', { title: item.updated }, `updated ${timeAgo(item.updated)}`)),
    kids.length ? el('ul', { class: 'children' }, kids.map(c => el('li', {},
      el('span', { class: `dot ${c.attention.level || 'none'}` }), el('span', { class: 'grow' }, c.name), el('span', { class: 'muted child-status' }, c.status)))) : null);
}

// ------------------------------------------------------------------ item detail
async function renderItem(id) {
  const it = await api('GET', `/api/items/${encodeURIComponent(id)}`);
  const ov = { repo: null };
  const patch = async (body) => { try { await api('PATCH', `/api/items/${it.id}`, body); route(); } catch (e) { toast(e.message); } };

  // header
  const crumbs = el('div', { class: 'crumbs' }, el('a', { href: '#/' }, 'Dashboard'), ' › ', it.area,
    it.parent_item ? [' › ', el('a', { href: `#/item/${it.parent_item.id}` }, it.parent_item.name)] : null);
  const title = el('div', { class: 'title-row' },
    el('h1', {}, it.name),
    el('button', { class: 'small', onclick: () => { const n = window.prompt('Rename item', it.name); if (n && n !== it.name) patch({ name: n }); } }, 'Rename'),
    attentionBadge(it.attention));
  const props = el('div', { class: 'props' },
    el('label', {}, 'status', selectEl(it.statuses, it.status, v => patch({ status: v }))),
    el('label', {}, 'area', selectEl(it.areas, it.area, v => patch({ area: v }))),
    el('label', {}, 'parent', selectEl([['', '— none —'], ...it.candidates.map(c => [c.id, `${c.name} (${c.area})`])], it.parent || '', v => patch({ parent: v || null }))),
    el('span', { title: it.created }, `created ${timeAgo(it.created)}`), el('span', { title: it.updated }, `updated ${timeAgo(it.updated)}`));

  page(ov, crumbs, title, props,
    sessionsBlock(it),
    childrenBlock(it),
    it.ai_state !== null ? el('section', { class: 'block ai-state' }, el('h3', {}, 'AI state', el('span', { class: 'grow' }), el('span', { class: 'muted small' }, 'from the `## AI state` section')), el('div', { class: 'notes-view', html: it.ai_state_html })) : null,
    notesBlock(it, patch),
    contextBlock(it, patch),
    el('div', { class: 'footer' }, el('span', { class: 'mono' }, it.path),
      el('button', { class: 'danger small', onclick: async () => {
        if (!window.confirm(`Delete "${it.name}"? The Markdown file will be removed.`)) return;
        try { await api('DELETE', `/api/items/${it.id}`); location.hash = '#/'; } catch (e) { toast(e.message); }
      } }, 'Delete item')));
  // fetch repo for the topbar without blocking the page
  api('GET', '/api/repo').then(repo => document.querySelector('.topbar').replaceWith(topbar({ repo }))).catch(() => {});
}

function selectEl(options, value, onchange) {
  const sel = el('select', { onchange: e => onchange(e.target.value) },
    options.map(o => { const [v, label] = Array.isArray(o) ? o : [o, o]; return el('option', { value: v, selected: v === value }, label); }));
  return sel;
}

function sessionsBlock(it) {
  const resumeBox = el('div', {});
  const showResume = (s) => {
    resumeBox.replaceChildren(el('div', { class: 'resume' }, el('code', {}, s.resume_command), el('button', { onclick: () => copyText(s.resume_command) }, 'Copy')),
      el('div', { class: 'muted small', style: 'margin-top:4px' }, 'Run this in a terminal on the machine where folio and Claude Code run.'));
  };
  const rows = it.sessions.map(s => el('tr', {},
    el('td', {}, el('button', { class: 'link', title: 'click to edit title', onclick: async () => {
      const t = window.prompt('Session title', s.title); if (t === null) return;
      try { await api('PATCH', `/api/items/${it.id}/sessions/${s.id}`, { title: t }); route(); } catch (e) { toast(e.message); }
    } }, s.title || el('span', { class: 'muted' }, 'untitled')), el('div', { class: 'mono muted', title: s.id }, s.short_id)),
    el('td', {}, stateBadge(s.state, s.attention), s.last_event ? el('div', { class: 'muted small' }, s.last_event) : null),
    el('td', { title: s.updated_at || '' }, timeAgo(s.updated_at)),
    el('td', {}, s.in_repo ? [el('div', {}, el('span', { class: 'badge' }, s.branch || 'detached'), ' ', el('span', { class: 'muted small' }, s.is_main_worktree ? 'main checkout' : 'worktree')), el('div', { class: 'mono muted small' }, shortPath(s.worktree))]
      : s.cwd ? [el('div', { class: 'muted small' }, 'outside configured repo'), el('div', { class: 'mono muted small' }, shortPath(s.cwd))] : el('span', { class: 'muted' }, '—'),
      s.cwd && s.cwd !== s.worktree ? el('div', { class: 'mono muted small', title: 'session cwd' }, `cwd ${shortPath(s.cwd)}`) : null),
    el('td', {}, el('div', { class: 'row' },
      el('button', { class: 'primary small', onclick: () => showResume(s) }, 'Resume'),
      el('button', { class: 'small', onclick: async () => {
        if (!window.confirm('Detach this session from the item? (The Claude session itself is untouched.)')) return;
        try { await api('DELETE', `/api/items/${it.id}/sessions/${s.id}`); route(); } catch (e) { toast(e.message); }
      } }, 'Detach')))));
  const table = it.sessions.length ? el('table', { class: 'sessions' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Session'), el('th', {}, 'State'), el('th', {}, 'Last update'), el('th', {}, 'Worktree / branch'), el('th', {}, '')))
    , el('tbody', {}, rows)) : el('div', { class: 'muted' }, 'No Claude sessions attached yet.');

  // attach panel
  const attachArea = el('div', {});
  const attachBtn = el('button', { onclick: () => openAttach() }, '+ Attach Claude session');
  async function openAttach() {
    attachBtn.hidden = true;
    let showAll = false;
    const titleInput = el('input', { type: 'text', placeholder: 'Title for this thread, e.g. "Survey existing approaches"', style: 'width:360px' });
    const manual = el('input', { type: 'text', placeholder: 'or paste a session id', class: 'mono', style: 'width:300px' });
    const list = el('div', { class: 'list' }, el('div', { class: 'muted', style: 'padding:8px' }, 'Loading recent sessions…'));
    const attached = new Set(it.sessions.map(s => s.id));
    async function load() {
      const data = await api('GET', `/api/sessions${showAll ? '?all=1' : ''}`);
      const rows = data.sessions.filter(s => !attached.has(s.id)).map(s => el('label', {},
        el('input', { type: 'radio', name: 'sess', value: s.id }),
        el('span', { class: 'mono' }, s.short_id),
        stateBadge(s.state, s.attention),
        el('span', { class: 'mono muted' }, s.in_repo ? `${shortPath(s.worktree)} [${s.branch || 'detached'}]` : shortPath(s.cwd)),
        el('span', { class: 'muted', title: s.updated_at }, timeAgo(s.updated_at), s.attached_to.length ? ` · on ${s.attached_to.map(a => a.name).join(', ')}` : '')));
      list.replaceChildren(rows.length ? rows : el('div', { class: 'muted', style: 'padding:8px' },
        showAll ? 'The hook has not observed any sessions yet. Install it with `folio hooks install`, or paste a session id below.'
          : 'No recent sessions inside the configured repo. Toggle "show all" or paste a session id.'));
    }
    load().catch(e => list.replaceChildren(el('div', { class: 'error' }, e.message)));
    attachArea.replaceChildren(
      el('div', { class: 'row' }, el('strong', {}, 'Attach a recently observed session'), el('span', { class: 'grow' }),
        el('label', { class: 'small' }, el('input', { type: 'checkbox', onchange: e => { showAll = e.target.checked; load(); } }), ' show sessions outside the repo')),
      list,
      el('div', { class: 'row' }, titleInput, manual,
        el('button', { class: 'primary', onclick: async () => {
          const picked = attachArea.querySelector('input[name=sess]:checked');
          const sid = (manual.value.trim() || (picked && picked.value) || '');
          if (!sid) { toast('Pick a session or paste an id'); return; }
          try { await api('POST', `/api/items/${it.id}/sessions`, { session_id: sid, title: titleInput.value }); route(); } catch (e) { toast(e.message); }
        } }, 'Attach'),
        el('button', { onclick: () => { attachArea.replaceChildren(); attachBtn.hidden = false; } }, 'Cancel')));
  }
  return el('section', { class: 'block' },
    el('h3', {}, 'Claude sessions', el('span', { class: 'muted small' }, `${it.sessions.length} attached`), el('span', { class: 'grow' }), attachBtn),
    table, resumeBox, el('div', { class: 'attach' }, attachArea));
}

function childrenBlock(it) {
  const quick = el('input', { type: 'text', placeholder: 'New child item…', style: 'width:280px', onkeydown: async (e) => {
    if (e.key !== 'Enter' || !quick.value.trim()) return;
    try { await api('POST', '/api/items', { name: quick.value.trim(), area: it.area, parent: it.id, status: 'idea' }); route(); } catch (err) { toast(err.message); }
  } });
  return el('section', { class: 'block' },
    el('h3', {}, 'Children', el('span', { class: 'muted small' }, it.children.length || ''), el('span', { class: 'grow' }), quick),
    it.children.length ? el('div', { class: 'columns' }, it.children.map(c => el('a', { class: `card ${c.attention.level ? 'card-' + c.attention.level : ''}`, href: `#/item/${c.id}` },
      el('div', { class: 'card-title' }, c.name),
      el('div', { class: 'card-meta' }, statusBadge(c.status), attentionBadge(c.attention), c.sessions.length ? el('span', {}, plural(c.sessions.length, 'session')) : null))))
      : el('div', { class: 'muted small' }, 'No child items. Children store `parent: ' + it.id + '` in their own Markdown file.'));
}

function notesBlock(it, patch) {
  const view = el('div', { class: 'notes-view', html: it.notes_html || '<p class="muted">No notes yet.</p>' });
  const block = el('section', { class: 'block' });
  const editBtn = el('button', { onclick: () => edit() }, 'Edit notes');
  function edit() {
    block.classList.add('editing');
    const ta = el('textarea', { value: it.notes, spellcheck: 'false' });
    const save = async () => { await patch({ notes: ta.value }); };
    block.replaceChildren(
      el('h3', {}, 'Notes', el('span', { class: 'muted small' }, 'Markdown · `## Notes` section'), el('span', { class: 'grow' }),
        el('button', { class: 'primary', onclick: save }, 'Save'), el('button', { onclick: () => route() }, 'Cancel')),
      ta);
    ta.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); });
    ta.focus();
  }
  block.replaceChildren(el('h3', {}, 'Notes', el('span', { class: 'muted small' }, 'Markdown · `## Notes` section'), el('span', { class: 'grow' }), editBtn), view);
  return block;
}

function contextBlock(it, patch) {
  const isUrl = ref => /^https?:\/\//i.test(ref);
  const items = it.context.map((c, idx) => el('li', {},
    isUrl(c.ref) ? el('a', { href: c.ref, target: '_blank', rel: 'noopener' }, c.title || c.ref) : el('strong', {}, c.title || c.ref),
    el('span', { class: 'ref grow' }, c.ref),
    isUrl(c.ref) ? null : el('button', { class: 'small', onclick: () => copyText(c.ref) }, 'Copy'),
    el('button', { class: 'small danger', onclick: () => patch({ context: it.context.filter((_, i) => i !== idx) }) }, '×')));
  const t = el('input', { type: 'text', placeholder: 'Title', style: 'width:220px' });
  const r = el('input', { type: 'text', placeholder: 'URL, path, file://, notion link…', class: 'mono', style: 'width:380px' });
  return el('section', { class: 'block' },
    el('h3', {}, 'Context', el('span', { class: 'muted small' }, it.context.length || '')),
    items.length ? el('ul', { class: 'ctx' }, items) : el('div', { class: 'muted small' }, 'No context refs. Add design docs, files, links, artifacts…'),
    el('div', { class: 'row', style: 'margin-top:10px' }, t, r, el('button', { onclick: () => {
      if (!r.value.trim()) { toast('ref is required'); return; }
      patch({ context: [...it.context, { title: t.value.trim() || r.value.trim(), ref: r.value.trim() }] });
    } }, 'Add')));
}

// ------------------------------------------------------------------ new item
async function renderNew(params) {
  const ov = await api('GET', '/api/overview');
  const areas = ov.areas.map(a => a.name);
  const name = el('input', { type: 'text', required: true, autofocus: true });
  const area = selectEl(areas.length ? areas : ['Inbox'], params.get('area') || areas[0] || 'Inbox', () => {});
  const status = selectEl(ov.statuses, 'idea', () => {});
  const parent = selectEl([['', '— none —'], ...ov.items.map(i => [i.id, `${i.name} (${i.area})`])], params.get('parent') || '', () => {});
  const notes = el('textarea', { placeholder: 'Free-form Markdown notes (optional)', style: 'min-height:140px;max-width:720px' });
  const form = el('form', { class: 'new', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const it = await api('POST', '/api/items', { name: name.value, area: area.value, status: status.value, parent: parent.value || null, notes: notes.value });
      location.hash = `#/item/${it.id}`;
    } catch (err) { toast(err.message); }
  } },
    el('label', {}, el('span', {}, 'Name'), name),
    el('label', {}, el('span', {}, 'Area'), area),
    el('label', {}, el('span', {}, 'Status'), status),
    el('label', {}, el('span', {}, 'Parent (optional)'), parent),
    el('label', {}, el('span', {}, 'Notes'), notes),
    el('div', { class: 'row' }, el('button', { class: 'primary', type: 'submit' }, 'Create'), el('a', { href: '#/' }, 'Cancel')));
  page(ov, el('h1', {}, 'New item'), el('section', { class: 'block' }, form));
  name.focus();
}

// ------------------------------------------------------------------ sessions
async function renderSessions() {
  const params = new URLSearchParams((location.hash.split('?')[1]) || '');
  const showAll = params.get('all') === '1';
  const [data, ov] = await Promise.all([api('GET', `/api/sessions${showAll ? '?all=1' : ''}`), api('GET', '/api/overview')]);
  const itemOptions = [['', 'Attach to…'], ...ov.items.map(i => [i.id, `${i.name} (${i.area})`])];
  const rows = data.sessions.map(s => el('tr', {},
    el('td', { title: s.updated_at }, timeAgo(s.updated_at)),
    el('td', {}, el('span', { class: 'mono', title: s.id }, s.short_id)),
    el('td', {}, stateBadge(s.state, s.attention), s.last_event ? el('div', { class: 'muted small' }, s.last_event) : null),
    el('td', {}, s.in_repo ? [el('span', { class: 'badge' }, s.branch || 'detached'), ' ', el('span', { class: 'mono muted small' }, shortPath(s.worktree))] : el('span', { class: 'mono muted small' }, shortPath(s.cwd) || '—')),
    el('td', {}, s.attached_to.length ? s.attached_to.map(a => el('div', {}, el('a', { href: `#/item/${a.id}` }, a.name))) : el('span', { class: 'muted' }, 'unattached')),
    el('td', {}, el('div', { class: 'row' },
      selectEl(itemOptions, '', async (v) => { if (!v) return; try { await api('POST', `/api/items/${v}/sessions`, { session_id: s.id, title: '' }); toast('Attached'); route(); } catch (e) { toast(e.message); } }),
      el('button', { class: 'small', onclick: () => copyText(s.resume_command) }, 'Copy resume')))));
  page(ov,
    el('div', { class: 'title-row' }, el('h1', {}, 'Recently observed Claude sessions'), el('span', { class: 'grow' }),
      el('label', { class: 'small' }, el('input', { type: 'checkbox', checked: showAll, onchange: e => { location.hash = e.target.checked ? '#/sessions?all=1' : '#/sessions'; } }), ' show sessions outside the configured repo')),
    el('section', { class: 'block' },
      rows.length ? el('table', { class: 'sessions' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Last update'), el('th', {}, 'Session'), el('th', {}, 'State'), el('th', {}, 'Worktree / branch'), el('th', {}, 'Attached to'), el('th', {}, ''))),
        el('tbody', {}, rows))
        : el('div', { class: 'muted' }, 'Nothing observed yet. Sessions appear here once the `folio hook` is installed in Claude Code (see README) and a session emits events',
          showAll ? '.' : ' from inside the configured repo (or tick "show all").')),
    el('p', { class: 'muted small' }, 'Runtime state is ephemeral and metadata-only (session id, coarse state, cwd, timestamps). It is stored under runtime/sessions/, separate from the Markdown items.'));
}

// ------------------------------------------------------------------ routing
function route() {
  const hash = location.hash || '#/';
  const [path, qs] = hash.slice(1).split('?');
  const params = new URLSearchParams(qs || '');
  let p;
  if (path.startsWith('/item/')) p = renderItem(decodeURIComponent(path.slice(6)));
  else if (path === '/sessions') p = renderSessions();
  else if (path === '/new') p = renderNew(params);
  else p = renderDashboard();
  p.catch(showError);
}
window.addEventListener('hashchange', route);
route();
// Live refresh of runtime state (skipped while typing or editing notes).
setInterval(() => { if (!document.hidden && !isEditing()) route(); }, 5000);
