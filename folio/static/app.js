/* folio UI: sessions rail · canvas of Areas with nested cards · inspector.
   Vanilla JS, no build step. The app owns every position; the user only changes relations. */
'use strict';

const STATE_LABEL = { needs_you: 'Needs you', working: 'Working', ready: 'Ready', ended: 'Ended', inactive: 'Inactive', unknown: 'No runtime info' };
const RAIL_GROUPS = [['needs_you', 'Needs you'], ['working', 'Working'], ['ready', 'Ready'], ['ended', 'Ended / inactive']];
const POLL_MS = 4000;

let OV = null, AREAS = [], CARDS = [], SESSIONS = [];
const state = { cam: { x: 16, y: 8, s: 0.9 }, selected: null, detail: null, railFilter: 'all', allRepos: false, attnCursor: -1, resumeOpen: null };
const collapsed = new Set();

// ------------------------------------------------------------------ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'value') e.value = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const chevron = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 10 10'); s.innerHTML = '<path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'; return s; };
const cardById = id => CARDS.find(c => c.id === id);
const areaById = id => AREAS.find(a => a.id === id);
const kidsOf = id => CARDS.filter(c => c.parent === id);
const topOf = a => CARDS.filter(c => !c.parent && c.area === a.id);
const sessOf = id => SESSIONS.filter(s => s.item === id);
const sessById = id => SESSIONS.find(s => s.id === id);
const parents = () => CARDS.filter(c => kidsOf(c.id).length);
const lifecycle = c => c.lifecycle || 'idea';
// What a session is called: your own name for it, else the title Claude Code gave
// it (read live from its transcript), else the id.
const sessTitle = s => s.title || s.autoTitle || `Untitled · ${s.short}`;
const sessTip = s => [sessTitle(s), s.prompt && `last prompt: ${s.prompt}`, s.id].filter(Boolean).join('\n');
function ancestors(id) { const out = []; let c = cardById(id); while (c && c.parent) { out.unshift(c.parent); c = cardById(c.parent); } return out; }
function areaOf(id) { let c = cardById(id); while (c && c.parent) c = cardById(c.parent); return c ? areaById(c.area) : null; }
function isDescendant(id, ofId) { let c = cardById(id); while (c && c.parent) { if (c.parent === ofId) return true; c = cardById(c.parent); } return false; }
function descendantCount(id) { return kidsOf(id).reduce((n, k) => n + 1 + descendantCount(k.id), 0); }
function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'now'; if (s < 3600) return `${Math.round(s / 60)}m`; if (s < 86400) return `${Math.round(s / 3600)}h`; return `${Math.round(s / 86400)}d`;
}
function shortPath(p) { if (!p) return ''; const m = p.match(/^\/(?:Users|home)\/[^/]+/); return m ? '~' + p.slice(m[0].length) : p; }
function railState(s) { return ['needs_you', 'working', 'ready'].includes(s.state) ? s.state : 'ended'; }
function isEditing() { const a = document.activeElement; return !!(a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')); }
function persist() {
  try { localStorage.setItem('folio.collapsed', JSON.stringify([...collapsed])); localStorage.setItem('folio.cam', JSON.stringify(state.cam)); } catch (e) { /* private mode etc. */ }
}
function restore() {
  try {
    (JSON.parse(localStorage.getItem('folio.collapsed') || '[]')).forEach(id => collapsed.add(id));
    const cam = JSON.parse(localStorage.getItem('folio.cam') || 'null'); if (cam && typeof cam.s === 'number') state.cam = cam;
  } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------ api
class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
let inFlight = 0;
async function api(method, path, body) {
  inFlight++;
  try {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    if (res.status === 404 && data.error === 'no such endpoint') {
      throw new ApiError(`The folio server does not know ${method} ${path} — it is running older code than this page. Restart it (stop the process, run folio serve again).`, res.status);
    }
    throw new ApiError(data.error || res.statusText, res.status);
  } finally { inFlight--; }
}
async function load() {
  OV = await api('GET', `/api/overview${state.allRepos ? '?all=1' : ''}`);
  AREAS = OV.areas.map(a => ({ id: a.name, name: a.name, count: a.count }));
  CARDS = OV.items.map(i => ({ id: i.id, name: i.name, area: i.area, parent: i.parent || null, order: i.order, lifecycle: i.lifecycle, human: i.human_status, parkNote: i.park_note || '', hasAi: i.has_ai_state, updated: i.updated }));
  SESSIONS = OV.sessions.map(s => ({ id: s.id, short: s.short_id, title: s.title || '', autoTitle: s.auto_title || '', prompt: s.last_prompt || '', state: s.state, attention: s.attention, updated: s.updated_at, cwd: s.cwd, branch: s.branch, inRepo: s.in_repo, item: s.item || null, resume: s.resume }));
  if (state.selected && !cardById(state.selected)) { state.selected = null; state.detail = null; }
}
async function loadDetail(id) {
  try { const d = await api('GET', `/api/items/${encodeURIComponent(id)}`); if (state.selected === id) { state.detail = d; renderInspector(); } }
  catch (e) { /* card may have vanished; the next refresh clears the selection */ }
}
async function refresh() { try { await load(); render(); if (state.selected) loadDetail(state.selected); } catch (e) { toastError(e); } }
function canRefresh() { return !ptr && !sdrag && !isEditing() && inFlight === 0 && !document.hidden && !$('#toast').classList.contains('show'); }

// mutation helper: run the request, reload, toast (with an inverse request as Undo)
async function mutate(run, { msg, undo, error = 'Something went wrong' } = {}) {
  try {
    await run();
    await load(); render();
    if (state.selected) loadDetail(state.selected);
    if (msg) toast(msg, undo ? async () => { try { await undo(); await load(); render(); if (state.selected) loadDetail(state.selected); } catch (e) { toastError(e); } } : null);
  } catch (e) { toastError(e); refresh(); }
}

// ------------------------------------------------------------------ toast / hint
let hintTimer = null, toastTimer = null;
function hint(msg) { const el = $('#hint'); el.textContent = msg; el.classList.add('show'); clearTimeout(hintTimer); hintTimer = setTimeout(() => el.classList.remove('show'), 1800); }
function toast(msg, undo, opts = {}) {
  const el = $('#toast'); el.className = 'toast' + (opts.error ? ' error' : ''); el.innerHTML = ''; el.append(msg);
  if (undo) el.appendChild(h('button', { onclick: () => { el.classList.remove('show'); undo(); } }, 'Undo'));
  if (opts.error) el.appendChild(h('button', { onclick: () => el.classList.remove('show') }, 'Dismiss'));
  el.classList.add('show'); clearTimeout(toastTimer);
  if (!opts.error) toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 5000 : 2200);
}
function toastError(e) { toast((e && e.message) || String(e), null, { error: true }); }
async function copyText(text) { try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch (e) { window.prompt('Copy this command:', text); } }

// ------------------------------------------------------------------ derived
function attn(id) {
  let needs = 0, working = 0, ownNeeds = 0, ownWorking = 0;
  const walk = (cid, own) => { for (const s of sessOf(cid)) { if (s.state === 'needs_you') { needs++; if (own) ownNeeds++; } else if (s.state === 'working') { working++; if (own) ownWorking++; } } for (const k of kidsOf(cid)) walk(k.id, false); };
  walk(id, true);
  return { needs, working, ownNeeds, ownWorking, descNeeds: needs - ownNeeds, descWorking: working - ownWorking };
}
function areaAttn(a) { let needs = 0, working = 0; for (const c of topOf(a)) { const x = attn(c.id); needs += x.needs; working += x.working; } return { needs, working }; }
function needsYouCards() { return CARDS.filter(c => sessOf(c.id).some(s => s.state === 'needs_you')); }
function lifecycleWhy(c) {
  const n = sessOf(c.id).length, kids = kidsOf(c.id);
  if (c.human === 'done') return 'marked done by you';
  if (c.human === 'parked') return c.parkNote || 'parked by you';
  if (n) return `${n} session${n === 1 ? '' : 's'} attached`;
  if (kids.length && lifecycle(c) === 'active') return 'children have started';
  return 'nothing attached yet';
}
const colsFor = n => n <= 1 ? 1 : n <= 4 ? 2 : 3;
const columnOf = (i, cols) => i % cols; // stable: a card keeps its column when neighbours grow

// ------------------------------------------------------------------ geometry (read from the DOM)
const stage = $('#stage'), world = $('#world');
function worldRectOf(el) { const r = el.getBoundingClientRect(), sr = stage.getBoundingClientRect(), { x, y, s } = state.cam; return { x: (r.left - sr.left - x) / s, y: (r.top - sr.top - y) / s, w: r.width / s, h: r.height / s }; }
function cardRect(id) { const el = $(`.card[data-id="${id}"]`); return el ? worldRectOf(el) : null; }
function workspaceRect() { return { x: 0, y: 0, w: world.offsetWidth, h: world.offsetHeight }; }

// ------------------------------------------------------------------ rendering
function compStrip(kids) {
  const counts = { active: 0, idea: 0, parked: 0, done: 0 }; kids.forEach(k => counts[lifecycle(k)]++);
  const strip = h('div', { class: 'comp', title: Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ') });
  for (const k of ['active', 'idea', 'parked', 'done']) if (counts[k]) strip.appendChild(h('i', { class: `c-${k}`, style: `flex:${counts[k]}` }));
  return strip;
}
function sessChip(s) { return h('span', { class: `sess ${s.state}`, 'data-sid': s.id, title: `${sessTitle(s)} — ${STATE_LABEL[s.state] || s.state}${s.attention ? ' · ' + s.attention : ''}${s.prompt ? `\n\nlast prompt: ${s.prompt}` : ''}` }, h('i', { class: `dot ${s.state}` }), sessTitle(s)); }
function cardEl(c, depth = 0) {
  const kids = kidsOf(c.id), sess = sessOf(c.id), lc = lifecycle(c), ag = attn(c.id);
  const isCollapsed = kids.length > 0 && collapsed.has(c.id);
  const loud = ag.ownNeeds > 0 || (isCollapsed && ag.descNeeds > 0); // attention shows where it is, or rolled up when hidden
  const el = h('div', { class: `card ${lc} ${kids.length ? 'has-kids' : ''} ${isCollapsed ? 'collapsed' : ''} ${loud ? 'attn' : ''} ${state.selected === c.id ? 'selected' : ''}`, 'data-id': c.id, 'data-depth': String(depth), tabindex: '0' });
  if (isCollapsed) el.appendChild(h('i', { class: 'stack2' }));
  const head = h('div', { class: 'card-head' }, h('i', { class: `glyph ${lc}`, title: lc }), h('span', { class: 'title' }, c.name));
  if (isCollapsed && ag.descNeeds) head.appendChild(h('span', { class: 'badge attn' }, h('i', { class: 'dot needs_you' }), ag.descNeeds === 1 ? 'needs you' : `${ag.descNeeds} need you`));
  else if (isCollapsed && ag.descWorking) head.appendChild(h('span', { class: 'badge work' }, h('i', { class: 'dot working' }), 'working'));
  if (kids.length) head.appendChild(h('button', { class: 'tog', 'data-act': 'toggle', title: isCollapsed ? `Show ${descendantCount(c.id)} inside` : 'Collapse this card' }, String(kids.length), chevron()));
  el.appendChild(head);
  if (sess.length) {
    const row = h('div', { class: 'card-row' });
    sess.slice(0, 2).forEach(s => row.appendChild(sessChip(s)));
    if (sess.length > 2) row.appendChild(h('span', { class: 'sess', title: sess.slice(2).map(sessTitle).join('\n') }, `+${sess.length - 2}`));
    el.appendChild(row);
  }
  if (isCollapsed) el.appendChild(compStrip(kids));
  if (kids.length && !isCollapsed) el.appendChild(h('div', { class: 'kids' }, h('div', {}, h('div', { class: 'kids-list' }, ...kids.map(k => cardEl(k, depth + 1))))));
  return el;
}
function areaEl(a) {
  const cards = topOf(a), aa = areaAttn(a), cols = colsFor(cards.length);
  const meta = h('span', { class: 'area-meta' }, `${a.count} card${a.count === 1 ? '' : 's'}`);
  if (aa.needs) meta.appendChild(h('span', { class: 'a' }, h('i', { class: 'dot needs_you' }), `${aa.needs} need${aa.needs === 1 ? 's' : ''} you`));
  if (aa.working) meta.appendChild(h('span', { class: 'w' }, h('i', { class: 'dot working' }), `${aa.working} working`));
  const colEls = Array.from({ length: cols }, () => h('div', { class: 'col' }));
  cards.forEach((c, i) => colEls[columnOf(i, cols)].appendChild(cardEl(c, 0)));
  if (!cards.length) colEls[0].appendChild(h('div', { class: 'empty' }, a.count ? 'Every card here is nested under a parent in another Area.' : 'No cards yet — press + or drop a session here'));
  return h('section', { class: 'area', 'data-area': a.id },
    h('header', { class: 'area-head' }, h('h2', { class: 'area-title' }, a.name), meta,
      h('button', { class: 'area-del', 'data-act': 'delete-area', title: 'Delete this Area and every card in it' }, 'Delete area'),
      h('button', { class: 'area-add', 'data-act': 'add-to-area', title: `New idea in ${a.name}` }, '+')),
    h('div', { class: 'cols' }, ...colEls));
}
function render() {
  world.innerHTML = '';
  AREAS.forEach(a => world.appendChild(areaEl(a)));
  world.appendChild(h('i', { class: 'insline', id: 'insline' }));
  if (!AREAS.length) stage.appendChild(h('div', { class: 'empty-state', id: 'emptyState' }, h('div', {}, h('div', { style: 'font-family:var(--serif);font-style:italic;font-size:22px;color:var(--ink);margin-bottom:6px' }, 'Nothing here yet'), 'Create an Area with + Area, then + Idea.')));
  else { const es = $('#emptyState'); if (es) es.remove(); }
  renderTopbar(); renderRail(); renderInspector(); renderAttnPill();
}
function renderTopbar() {
  $('#summary').textContent = `${AREAS.length} area${AREAS.length === 1 ? '' : 's'} · ${CARDS.length} card${CARDS.length === 1 ? '' : 's'} · ${SESSIONS.length} session${SESSIONS.length === 1 ? '' : 's'}`;
  const ps = parents(); $('#collapseAll').textContent = ps.length && ps.every(p => collapsed.has(p.id)) ? 'Expand all' : 'Collapse all';
  const repo = OV && OV.repo, el = $('#repo');
  if (repo) { el.textContent = repo.error ? `⚠ ${repo.error}` : `${shortPath(repo.path)} · ${repo.worktrees.length} worktree${repo.worktrees.length === 1 ? '' : 's'}`; el.classList.toggle('err', !!repo.error); el.title = repo.error || (repo.worktrees || []).map(w => `${w.branch || '(detached)'}  ${w.path}`).join('\n'); }
  $('#stale').hidden = !(OV && OV.server && OV.server.stale);
}
function renderAttnPill() {
  const list = needsYouCards(), working = SESSIONS.filter(s => s.state === 'working').length, pill = $('#attnPill');
  pill.innerHTML = '';
  if (list.length) { pill.append(h('i', { class: 'dot needs_you', style: 'margin-right:7px' }), `${list.length} need${list.length === 1 ? 's' : ''} you`); if (working) pill.append(h('span', { class: 'muted', style: 'margin-left:6px;font-weight:400' }, `· ${working} working`)); pill.style.borderColor = 'var(--attn)'; pill.style.color = 'var(--attn-ink)'; }
  else { pill.append(working ? h('i', { class: 'dot working', style: 'margin-right:7px' }) : '', working ? `${working} working` : 'All quiet'); pill.style.borderColor = ''; pill.style.color = ''; }
}
function renderRail() {
  const rail = $('#rail'); rail.innerHTML = '';
  let list = SESSIONS.slice();
  if (state.railFilter === 'unattached') list = list.filter(s => !s.item);
  if (state.railFilter === 'attention') list = list.filter(s => s.state === 'needs_you');
  $('#railCount').textContent = `${list.length}/${SESSIONS.length}`;
  let any = false;
  for (const [st, label] of RAIL_GROUPS) {
    const rows = list.filter(s => railState(s) === st); if (!rows.length) continue; any = true;
    const g = h('div', { class: 'rail-group' }, h('h2', {}, h('i', { class: `dot ${st}` }), label, h('span', { class: 'n' }, String(rows.length))));
    for (const s of rows) {
      const card = s.item ? cardById(s.item) : null;
      const where = card ? h('span', { class: 'where' }, h('i', { class: `glyph ${lifecycle(card)}` }), card.name) : h('span', { class: 'where none' }, 'unattached · drag onto a card');
      g.appendChild(h('div', { class: 'srow', 'data-sid': s.id, tabindex: '0', title: sessTip(s) }, h('i', { class: `dot ${s.state}` }),
        h('div', { style: 'min-width:0' }, h('div', { class: 't' }, sessTitle(s)),
          s.prompt ? h('div', { class: 'p' }, s.prompt) : '',
          h('div', { class: 'm' }, s.branch ? h('span', { class: 'br' }, s.branch) : (s.cwd ? h('span', { class: 'cwd', title: s.cwd }, shortPath(s.cwd)) : ''), s.attention ? h('span', {}, `· ${s.attention}`) : '', h('span', { class: 'sid' }, s.short), h('span', { class: 'ago', title: s.updated || '' }, timeAgo(s.updated))),
          where)));
    }
    rail.appendChild(g);
  }
  if (!any) rail.appendChild(h('div', { class: 'rail-empty' }, state.railFilter === 'unattached' ? 'Every session is attached to a card.' : state.railFilter === 'attention' ? 'Nothing needs you right now.' : 'No Claude sessions observed yet. Install the hook (folio hooks install) and start one.'));
}
function renderInspector() {
  const ins = $('#inspector'); const c = state.selected && cardById(state.selected);
  if (!c) { ins.classList.remove('open'); return; }
  const d = state.detail && state.detail.id === c.id ? state.detail : null;
  ins.classList.add('open'); ins.innerHTML = '';
  const lc = lifecycle(c), kids = kidsOf(c.id), sess = sessOf(c.id), ag = attn(c.id), area = areaOf(c.id);
  const path = h('div', { class: 'ins-path' }, h('b', {}, area ? area.name : c.area));
  ancestors(c.id).forEach(pid => { path.append(h('span', { class: 'crumb-sep' }, '›'), h('button', { class: 'crumb', style: 'padding:0 2px', 'data-act': 'reveal', 'data-id': pid }, cardById(pid).name)); });
  if (c.parent) path.appendChild(h('button', { class: 'mini', 'data-act': 'move-out', title: 'Make it a sibling of its parent' }, '↑ Move out'));
  ins.appendChild(h('div', { class: 'ins-head' }, path, h('div', { class: 'ins-title' }, h('i', { class: `glyph ${lc}` }), h('input', { value: c.name, 'data-act': 'rename', 'aria-label': 'Card name' })),
    h('button', { class: 'ins-close', 'data-act': 'close', title: 'Close (Esc)' }, '×')));
  const body = h('div', { class: 'ins-body' });
  // state
  const st = h('div', { class: 'sec' }, h('h3', {}, 'State'),
    h('div', { class: 'state-line' }, h('i', { class: `glyph ${lc}` }), h('b', {}, lc[0].toUpperCase() + lc.slice(1)), h('span', { class: 'why' }, `— ${lifecycleWhy(c)}`)));
  st.appendChild(h('div', { class: 'seg' },
    h('button', { class: c.human === 'done' ? 'on' : '', 'data-act': 'toggle-done' }, h('i', { class: 'glyph done' }), c.human === 'done' ? 'Done ✓' : 'Mark done'),
    h('button', { class: c.human === 'parked' ? 'on' : '', 'data-act': 'toggle-park' }, h('i', { class: 'glyph parked' }), c.human === 'parked' ? 'Parked' : 'Park')));
  if (c.human === 'parked') st.appendChild(h('input', { class: 'park-note', 'data-act': 'park-note', value: c.parkNote, placeholder: 'why / until when (optional)', 'aria-label': 'Park note' }));
  if (!c.human && kids.length && kids.every(k => lifecycle(k) === 'done')) st.appendChild(h('div', { class: 'state-line', style: 'margin-top:8px;color:var(--muted);font-size:12px' }, 'Every child is done — mark this done?'));
  if (ag.needs) st.appendChild(h('div', { class: 'attn-call' }, h('i', { class: 'dot needs_you' }), h('span', {}, h('b', {}, ag.needs === 1 ? '1 session' : `${ag.needs} sessions`), ag.descNeeds ? ` need${ag.needs === 1 ? 's' : ''} you (inside)` : ` need${ag.needs === 1 ? 's' : ''} you`), h('button', { 'data-act': 'resume-first' }, 'Open')));
  body.appendChild(st);
  // sessions
  const ss = h('div', { class: 'sec' }, h('h3', {}, 'Sessions', h('span', { class: 'n' }, String(sess.length)), h('button', { class: 'act', 'data-act': 'attach-hint' }, 'Attach…')));
  if (!sess.length) ss.appendChild(h('div', { class: 'muted', style: 'font-size:12px' }, 'None yet. Drag one from the rail, or start Claude in this card’s worktree and attach it here.'));
  for (const s of sess) {
    const row = h('div', { class: 'ins-sess' }, h('i', { class: `dot ${s.state}` }),
      h('div', { style: 'min-width:0' }, h('div', { class: 't' }, h('button', { class: 'link', 'data-act': 'rename-session', 'data-sid': s.id, title: s.title ? 'Click to rename' : 'Named by Claude Code — click to rename' }, sessTitle(s))),
        s.prompt ? h('div', { class: 'p', title: s.prompt }, s.prompt) : '',
        h('div', { class: 'm' }, h('span', {}, (STATE_LABEL[s.state] || s.state) + (s.attention ? ' · ' + s.attention : '')), s.branch ? h('span', { class: 'mono' }, s.branch) : '', h('span', { class: 'mono', title: s.id }, s.short), h('span', { title: s.updated || '' }, timeAgo(s.updated) + ' ago'))),
      h('div', { class: 'acts' }, h('button', { class: `mini ${s.state === 'needs_you' ? 'primary' : ''}`, 'data-act': 'resume', 'data-sid': s.id }, s.resume && s.resume.kind === 'attach' ? 'Attach' : (['ended', 'inactive', 'unknown'].includes(s.state) ? 'Resume' : 'Open')), h('button', { class: 'mini', 'data-act': 'detach', 'data-sid': s.id, title: 'Detach from this card (the Claude session itself is untouched)' }, '×')));
    if (state.resumeOpen === s.id && s.resume) {
      row.appendChild(h('div', { class: 'resume-box' },
        h('div', { class: 'cmd' }, h('code', {}, s.resume.command), h('button', { class: 'mini', onclick: () => copyText(s.resume.command) }, 'Copy')),
        h('div', { class: 'note' }, s.resume.note || 'Run this in a terminal on the machine where folio and Claude Code run.'),
        ...(s.resume.alternatives || []).map(alt => h('div', { class: 'alt' }, h('span', {}, alt.label + ':'), h('code', {}, alt.command), h('button', { class: 'mini', onclick: () => copyText(alt.command) }, 'Copy')))));
    }
    ss.appendChild(row);
  }
  body.appendChild(ss);
  // children
  const ks = h('div', { class: 'sec' }, h('h3', {}, 'Children', h('span', { class: 'n' }, String(kids.length)), kids.length ? h('button', { class: 'act', 'data-act': 'toggle-kids' }, collapsed.has(c.id) ? 'Expand' : 'Collapse') : ''));
  for (const k of kids) { const ka = attn(k.id); ks.appendChild(h('button', { class: 'ins-kid', style: 'width:100%;text-align:left', 'data-act': 'reveal', 'data-id': k.id }, h('i', { class: `glyph ${lifecycle(k)}` }), h('span', {}, k.name), h('span', { class: 'st' }, ka.needs ? h('i', { class: 'dot needs_you' }) : ka.working ? h('i', { class: 'dot working' }) : lifecycle(k)), h('span', { class: 'arrow' }, '›'))); }
  ks.appendChild(h('form', { class: 'ins-add', 'data-act': 'add-kid-form' }, h('input', { placeholder: 'New child idea…', 'aria-label': 'New child idea' }), h('button', { class: 'mini', type: 'submit' }, 'Add')));
  body.appendChild(ks);
  // AI state
  if (d && d.ai_state) body.appendChild(h('div', { class: 'sec ai' }, h('h3', {}, 'AI state', h('span', { class: 'muted', style: 'font-weight:400;letter-spacing:0;text-transform:none' }, 'from the `## AI state` section')), h('div', { class: 'notes-view', html: d.ai_state_html })));
  // notes
  body.appendChild(h('div', { class: 'sec' }, h('h3', {}, 'Notes'), d
    ? h('textarea', { class: 'notes', 'data-act': 'notes', placeholder: 'Free-form Markdown. Only this section is edited; the rest of the file is left alone.' }, d.notes || '')
    : h('div', { class: 'muted', style: 'font-size:12px' }, 'Loading…')));
  // context
  if (d) {
    const isUrl = ref => /^https?:\/\//i.test(ref);
    const cx = h('div', { class: 'sec' }, h('h3', {}, 'Context', h('span', { class: 'n' }, String(d.context.length))));
    d.context.forEach((x, idx) => cx.appendChild(h('div', { class: 'ctx-row' },
      isUrl(x.ref) ? h('a', { class: 'lbl', href: x.ref, target: '_blank', rel: 'noopener' }, x.title || x.ref) : h('button', { class: 'lbl link', onclick: () => copyText(x.ref), title: 'Copy path' }, x.title || x.ref),
      h('span', { class: 'ref' }, x.ref), h('button', { class: 'mini', 'data-act': 'remove-ctx', 'data-idx': String(idx), title: 'Remove' }, '×'))));
    cx.appendChild(h('form', { class: 'ctx-add', 'data-act': 'add-ctx-form' }, h('input', { placeholder: 'Title', 'aria-label': 'Context title', style: 'flex:0 0 32%' }), h('input', { placeholder: 'URL, path, notion link…', 'aria-label': 'Context ref' }), h('button', { class: 'mini', type: 'submit' }, 'Add')));
    body.appendChild(cx);
  }
  const n = descendantCount(c.id);
  body.appendChild(h('div', { class: 'sec' }, h('button', { class: 'danger', 'data-act': 'delete' }, n ? `Delete card and ${n} inside…` : 'Delete card…'), d ? h('div', { class: 'ins-foot' }, d.path) : ''));
  ins.appendChild(body);
}

// ------------------------------------------------------------------ camera
function applyCam(animate) {
  const { x, y, s } = state.cam;
  world.classList.toggle('anim', !!animate);
  world.style.transform = `translate(${x}px,${y}px) scale(${s})`;
  stage.style.backgroundPosition = `${x}px ${y}px`; stage.style.backgroundSize = `${24 * s}px ${24 * s}px`;
  $('#zoomPct').textContent = Math.round(s * 100) + '%';
  persist();
}
function setCam(x, y, s, animate) { state.cam = { x, y, s: Math.min(2.5, Math.max(.2, s)) }; applyCam(animate); }
function viewW() { return stage.clientWidth - (state.selected ? 344 : 0); }
function fitRect(r, pad = 60, maxS = 1.15, animate = true) { const W = viewW(), H = stage.clientHeight; const s = Math.min(maxS, (W - pad * 2) / r.w, (H - pad * 2) / r.h); setCam((W - r.w * s) / 2 - r.x * s, (H - r.h * s) / 2 - r.y * s, s, animate); }
function zoomAt(sx, sy, factor) { const { x, y, s } = state.cam; const ns = Math.min(2.5, Math.max(.2, s * factor)); setCam(sx - (sx - x) * ns / s, sy - (sy - y) * ns / s, ns, false); }
function ensureVisible(r, pad = 48) {
  if (!r) return; const { x, y, s } = state.cam, W = viewW(), H = stage.clientHeight;
  const l = r.x * s + x, t = r.y * s + y, rt = (r.x + r.w) * s + x, b = (r.y + r.h) * s + y; let nx = x, ny = y;
  if (rt - l > W - pad * 2 || b - t > H - pad * 2) { if (l < pad) nx += pad - l; else if (l > W - pad - 200) nx -= l - (W - pad - 200); if (t < pad) ny += pad - t; else if (t > H - pad - 120) ny -= t - (H - pad - 120); }
  else { if (l < pad) nx += pad - l; else if (rt > W - pad) nx -= rt - (W - pad); if (t < pad) ny += pad - t; else if (b > H - pad) ny -= b - (H - pad); }
  if (nx !== x || ny !== y) setCam(nx, ny, s, true);
}
function flashCard(id) { const el = $(`.card[data-id="${id}"]`); if (el) { el.classList.add('flash'); el.addEventListener('animationend', () => el.classList.remove('flash'), { once: true }); } }

// ------------------------------------------------------------------ select / reveal / collapse
function select(id) { if (state.selected !== id) { state.detail = null; state.resumeOpen = null; } state.selected = id; render(); if (id) loadDetail(id); location.hash = id ? `card=${id}` : ''; }
function reveal(id, flash = true) {
  let opened = false; ancestors(id).forEach(pid => { if (collapsed.has(pid)) { collapsed.delete(pid); opened = true; } });
  select(id);
  if (opened) { persist(); ancestors(id).forEach(pid => { const k = $(`.card[data-id="${pid}"] > .kids`); if (k) k.classList.add('opening'); }); }
  ensureVisible(cardRect(id), 56); if (flash) flashCard(id);
}
function toggleCollapse(id) {
  if (!kidsOf(id).length) return;
  if (collapsed.has(id)) { collapsed.delete(id); persist(); render(); const k = $(`.card[data-id="${id}"] > .kids`); if (k) k.classList.add('opening'); return; }
  const k = $(`.card[data-id="${id}"] > .kids`);
  if (!k) { collapsed.add(id); persist(); render(); return; }
  let done = false; const fin = () => { if (done) return; done = true; collapsed.add(id); persist(); render(); };
  k.addEventListener('transitionend', fin, { once: true }); k.classList.add('closing'); setTimeout(fin, 340);
}
function jumpNext() { const list = needsYouCards(); if (!list.length) { hint('Nothing needs you right now'); return; } state.attnCursor = (state.attnCursor + 1) % list.length; const c = list[state.attnCursor]; reveal(c.id); hint(`${state.attnCursor + 1} of ${list.length} · ${c.name}`); }

// ------------------------------------------------------------------ structural edits (API)
function siblingAfter(c) { const sibs = c.parent ? kidsOf(c.parent) : topOf(areaById(c.area) || { id: c.area }); const i = sibs.findIndex(x => x.id === c.id); return i >= 0 && i + 1 < sibs.length ? sibs[i + 1].id : null; }
function moveSpec(c) { return { parent: c.parent, area: c.parent ? null : c.area, before: siblingAfter(c) }; } // how to put it back
const moveApi = (id, spec) => api('POST', `/api/items/${encodeURIComponent(id)}/move`, spec);
function moveCard(c, spec, msg) { const back = moveSpec(c); return mutate(() => moveApi(c.id, spec), { msg, undo: () => moveApi(c.id, back) }).then(() => flashCard(c.id)); }
const attachApi = (item, s) => api('POST', `/api/items/${encodeURIComponent(item)}/sessions`, { session_id: s.id, title: s.title || '' });
const detachApi = (item, sid) => api('DELETE', `/api/items/${encodeURIComponent(item)}/sessions/${encodeURIComponent(sid)}`);
function attachSession(s, target) {
  const prev = s.item, tgt = cardById(target);
  return mutate(() => attachApi(target, s), {
    msg: prev ? `Moved “${sessTitle(s)}” to “${tgt.name}”` : `Attached “${sessTitle(s)}” to “${tgt.name}” — it’s now active`,
    undo: () => prev ? attachApi(prev, s) : detachApi(target, s.id),
  }).then(() => flashCard(target));
}
function detachSession(s) {
  const prev = s.item, name = cardById(prev) ? cardById(prev).name : 'its card';
  return mutate(() => detachApi(prev, s.id), { msg: `Detached “${sessTitle(s)}” from “${name}” — it’s back in the rail`, undo: () => attachApi(prev, s) });
}
function setStatus(c, status, note) {
  const prev = { status: c.human || 'open', park_note: c.parkNote || '' };
  const body = { status }; if (note !== undefined) body.park_note = note; // omitted: the server keeps any note already on the file
  const msg = status === 'done' ? `Marked “${c.name}” done` : status === 'parked' ? `Parked “${c.name}”` : `Reopened “${c.name}”`;
  return mutate(() => api('PATCH', `/api/items/${encodeURIComponent(c.id)}`, body), { msg, undo: () => api('PATCH', `/api/items/${encodeURIComponent(c.id)}`, prev) });
}
async function newCard(spec) {
  try {
    const it = await api('POST', '/api/items', { name: 'Untitled idea', ...spec });
    if (spec.parent) collapsed.delete(spec.parent);
    await load(); render(); select(it.id); ensureVisible(cardRect(it.id)); flashCard(it.id);
    requestAnimationFrame(() => { const i = $('.ins-title input'); if (i) { i.focus({ preventScroll: true }); i.select(); } });
  } catch (e) { toastError(e); }
}

// ------------------------------------------------------------------ pointer: pan + relation drags
let ptr = null;
function hitAt(x, y, exclude) {
  const els = document.elementsFromPoint(x, y);
  const card = els.find(e => e.classList && e.classList.contains('card') && (!exclude || (e.dataset.id !== exclude && !isDescendant(e.dataset.id, exclude))));
  const area = els.find(e => e.classList && e.classList.contains('area'));
  return { card, area };
}
function clearDropTargets() { $$('.droptarget, .dwell').forEach(e => { e.classList.remove('droptarget', 'dwell'); e.removeAttribute('data-drophint'); }); const l = $('#insline'); if (l) l.style.display = 'none'; }
function mark(el, text) { el.classList.add('droptarget'); if (text) el.dataset.drophint = text; }
function showInsline(cardEl, side) { const l = $('#insline'); if (!l) return; const r = worldRectOf(cardEl); l.style.display = 'block'; l.style.left = r.x + 'px'; l.style.width = r.w + 'px'; l.style.top = (side === 'before' ? r.y - 6 : r.y + r.h + 4) + 'px'; }
function armNest(el, id, p) { // nesting arms after a short settle so a fast sweep across a card reads as passing over
  const label = `Make child of “${cardById(id).name}”`;
  if (p.nestId === id) { if (p.nestArmed) { mark(el, label); p.target = { kind: 'parent', id }; p.ghost && p.ghost.classList.add('going-in'); } else el.classList.add('dwell'); return; }
  disarmNest(p); p.nestId = id; p.nestArmed = false; el.classList.add('dwell');
  p.nestTimer = setTimeout(() => { if (ptr !== p || p.nestId !== id) return; p.nestArmed = true; const cur = $(`.card[data-id="${id}"]`); if (cur) { cur.classList.remove('dwell'); mark(cur, label); } p.target = { kind: 'parent', id }; p.ghost && p.ghost.classList.add('going-in'); }, 140);
}
function disarmNest(p) { clearTimeout(p.nestTimer); p.nestId = null; p.nestArmed = false; p.ghost && p.ghost.classList.remove('going-in'); }
function makeGhost(c) { const n = descendantCount(c.id); const g = h('div', { class: 'ghost' }, h('i', { class: `glyph ${lifecycle(c)}` }), c.name, n ? h('span', { class: 'n' }, `· ${n} inside`) : ''); document.body.appendChild(g); return g; }
function endCardDrag(p) { disarmNest(p); p.el.classList.remove('dragging-src'); if (p.ghost) p.ghost.remove(); clearDropTargets(); stage.classList.remove('card-drag'); }

stage.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  if (e.target.closest('.inspector, .zoomctl, .legend, button, input, textarea, a')) return;
  const chip = e.target.closest('.sess[data-sid]');
  if (chip) { beginSessDrag(e, chip.dataset.sid, chip); stage.setPointerCapture(e.pointerId); return; }
  const card = e.target.closest('.card');
  ptr = card ? { mode: 'card', id: card.dataset.id, el: card, sx: e.clientX, sy: e.clientY, moved: false, ghost: null, target: null, nestId: null, nestArmed: false, nestTimer: null }
    : { mode: 'pan', sx: e.clientX, sy: e.clientY, cx: state.cam.x, cy: state.cam.y, moved: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', e => {
  if (sdrag) { moveSessDrag(e); return; }
  if (!ptr) return;
  const dx = e.clientX - ptr.sx, dy = e.clientY - ptr.sy;
  if (!ptr.moved && Math.hypot(dx, dy) < 4) return;
  if (ptr.mode === 'pan') { if (!ptr.moved) { ptr.moved = true; stage.classList.add('panning'); } setCam(ptr.cx + dx, ptr.cy + dy, state.cam.s, false); return; }
  if (!ptr.moved) { ptr.moved = true; ptr.el.classList.add('dragging-src'); stage.classList.add('card-drag'); ptr.ghost = makeGhost(cardById(ptr.id)); }
  ptr.ghost.style.left = e.clientX + 'px'; ptr.ghost.style.top = e.clientY + 'px';
  clearDropTargets(); ptr.target = null;
  const me = cardById(ptr.id), hit = hitAt(e.clientX, e.clientY, ptr.id);
  if (hit.card) {
    const r = hit.card.getBoundingClientRect(), band = Math.min(12, r.height * .2), tid = hit.card.dataset.id;
    if (e.clientY < r.top + band) { disarmNest(ptr); ptr.target = { kind: 'before', id: tid }; showInsline(hit.card, 'before'); }
    else if (e.clientY > r.bottom - band) { disarmNest(ptr); ptr.target = { kind: 'after', id: tid }; showInsline(hit.card, 'after'); }
    else if (tid === me.parent) disarmNest(ptr); // already inside this one
    else armNest(hit.card, tid, ptr);
  } else if (hit.area) {
    disarmNest(ptr); const a = areaById(hit.area.dataset.area);
    if (me.parent || me.area !== a.id) { ptr.target = { kind: 'area', id: a.id }; mark(hit.area); hint(me.parent ? `Move out to ${a.name} — top level` : `Move to ${a.name}`); }
  } else disarmNest(ptr);
});
stage.addEventListener('pointerup', e => {
  if (sdrag) { endSessDrag(e); return; }
  if (!ptr) return; const p = ptr; ptr = null; stage.classList.remove('panning');
  if (p.mode === 'pan') { if (!p.moved && state.selected && !e.target.closest('.area-head')) select(null); return; }
  endCardDrag(p);
  const c = cardById(p.id);
  if (!p.moved) { select(c.id); return; }
  const t = p.target; if (!t) return;
  if (t.kind === 'parent') { if (t.id === c.id || isDescendant(t.id, c.id)) return; collapsed.delete(t.id); persist(); moveCard(c, { parent: t.id }, `“${c.name}” is now inside “${cardById(t.id).name}”`); }
  else if (t.kind === 'before' || t.kind === 'after') { const tgt = cardById(t.id); moveCard(c, { parent: tgt.parent || null, area: tgt.parent ? null : tgt.area, [t.kind]: tgt.id }, `Moved “${c.name}” ${t.kind} “${tgt.name}”`); }
  else if (t.kind === 'area') { const a = areaById(t.id), wasNested = !!c.parent; moveCard(c, { parent: null, area: a.id }, wasNested ? `Moved “${c.name}” out to ${a.name} — it’s top-level now` : `Moved “${c.name}” to ${a.name}`); }
});
stage.addEventListener('pointercancel', e => { if (sdrag) endSessDrag(e); if (ptr && ptr.mode === 'card') endCardDrag(ptr); ptr = null; stage.classList.remove('panning'); });
stage.addEventListener('dblclick', e => { const card = e.target.closest('.card'); if (card && kidsOf(card.dataset.id).length) toggleCollapse(card.dataset.id); });
stage.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { const r = stage.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0035)); }
  else setCam(state.cam.x - e.deltaX, state.cam.y - e.deltaY, state.cam.s, false);
}, { passive: false });

// sessions: drag a rail row or a chip on a card. Card -> attach/move. Empty canvas or the rail -> detach.
const rail = $('#rail'); let sdrag = null;
function beginSessDrag(e, sid, srcEl) { sdrag = { sid, srcEl, sx: e.clientX, sy: e.clientY, moved: false, ghost: null, target: null }; }
function moveSessDrag(e) {
  const d = sdrag, dx = e.clientX - d.sx, dy = e.clientY - d.sy, s = sessById(d.sid); if (!s) return;
  if (!d.moved) { if (Math.hypot(dx, dy) < 5) return; d.moved = true; d.srcEl.classList.add('dragging'); stage.classList.add('sess-drag');
    d.ghost = h('div', { class: 'sess sghost ' + s.state }, h('i', { class: 'dot ' + s.state }), sessTitle(s)); document.body.appendChild(d.ghost); }
  d.ghost.style.left = e.clientX + 'px'; d.ghost.style.top = e.clientY + 'px';
  clearDropTargets(); $('.rail').classList.remove('droptarget'); d.ghost.classList.remove('detaching'); d.target = null;
  const els = document.elementsFromPoint(e.clientX, e.clientY), hit = hitAt(e.clientX, e.clientY);
  const overRail = els.some(x => x.classList && x.classList.contains('rail')), overStage = els.some(x => x.id === 'stage'), overChrome = els.some(x => x.classList && (x.classList.contains('inspector') || x.classList.contains('zoomctl') || x.classList.contains('legend')));
  if (hit.card && hit.card.dataset.id !== s.item) { d.target = { kind: 'card', id: hit.card.dataset.id }; mark(hit.card, s.item ? `Move to “${cardById(hit.card.dataset.id).name}”` : `Attach to “${cardById(hit.card.dataset.id).name}”`); }
  else if (hit.card) { /* its own card */ }
  else if (s.item && (overRail || (overStage && !overChrome))) { d.target = { kind: 'detach' }; d.ghost.classList.add('detaching'); if (overRail) $('.rail').classList.add('droptarget'); hint(`Release to detach from “${(cardById(s.item) || {}).name || 'its card'}”`); }
}
function endSessDrag(e) {
  if (!sdrag) return; const d = sdrag; sdrag = null;
  d.srcEl.classList.remove('dragging'); stage.classList.remove('sess-drag'); if (d.ghost) d.ghost.remove(); clearDropTargets(); $('.rail').classList.remove('droptarget');
  const s = sessById(d.sid); if (!s) return;
  if (!d.moved) {
    if (d.srcEl.classList.contains('srow')) { if (s.item) reveal(s.item); else { d.srcEl.classList.add('flash'); hint('Unattached — drag it onto a card to attach'); } }
    else if (s.item) select(s.item);
    return;
  }
  const t = d.target; if (!t) return;
  if (t.kind === 'card') attachSession(s, t.id);
  if (t.kind === 'detach') detachSession(s);
}
rail.addEventListener('pointerdown', e => { const row = e.target.closest('.srow'); if (!row || e.button !== 0) return; beginSessDrag(e, row.dataset.sid, row); row.setPointerCapture(e.pointerId); });
rail.addEventListener('pointermove', e => { if (sdrag) moveSessDrag(e); });
rail.addEventListener('pointerup', endSessDrag); rail.addEventListener('pointercancel', endSessDrag);
$$('.rail-filters .chip-btn[data-f]').forEach(b => b.addEventListener('click', () => { state.railFilter = b.dataset.f; $$('.rail-filters .chip-btn[data-f]').forEach(x => x.classList.toggle('on', x === b)); renderRail(); }));
$('#allRepos').addEventListener('change', e => { state.allRepos = e.target.checked; refresh(); });

// ------------------------------------------------------------------ clicks: canvas buttons, inspector
stage.addEventListener('click', e => {
  const act = e.target.closest('[data-act]'); if (!act || e.target.closest('.inspector')) return;
  const a = act.dataset.act;
  if (a === 'toggle') toggleCollapse(act.closest('.card').dataset.id);
  if (a === 'add-to-area') newCard({ area: act.closest('.area').dataset.area });
  if (a === 'delete-area') {
    const area = areaById(act.closest('.area').dataset.area);
    const what = area.count ? ` and the ${area.count} card${area.count === 1 ? '' : 's'} in it` : '';
    if (!window.confirm(`Delete area "${area.name}"${what}? The directory and every Markdown file inside it will be removed.`)) return;
    mutate(() => api('DELETE', `/api/areas/${encodeURIComponent(area.name)}`), { msg: `Deleted area ${area.name}` });
  }
});
$('#inspector').addEventListener('click', e => {
  const act = e.target.closest('[data-act]'); if (!act) return; const a = act.dataset.act, c = cardById(state.selected); if (!c) return;
  if (a === 'close') select(null);
  if (a === 'toggle-done') setStatus(c, c.human === 'done' ? 'open' : 'done');
  if (a === 'toggle-park') setStatus(c, c.human === 'parked' ? 'open' : 'parked');
  if (a === 'detach') { const s = sessById(act.dataset.sid); if (s) detachSession(s); }
  if (a === 'resume' || a === 'resume-first') {
    const s = a === 'resume' ? sessById(act.dataset.sid) : (sessOf(c.id).find(x => x.state === 'needs_you') || sessOf(c.id)[0]); if (!s) return;
    state.resumeOpen = state.resumeOpen === s.id ? null : s.id; renderInspector();
    if (state.resumeOpen && s.resume) copyText(s.resume.command);
  }
  if (a === 'rename-session') {
    const s = sessById(act.dataset.sid); if (!s) return; const t = window.prompt('Session title', s.title || s.autoTitle); if (t === null) return;
    mutate(() => api('PATCH', `/api/items/${encodeURIComponent(c.id)}/sessions/${encodeURIComponent(s.id)}`, { title: t.trim() }), { msg: 'Renamed session' });
  }
  if (a === 'move-out') { const par = cardById(c.parent); if (par) moveCard(c, par.parent ? { parent: par.parent } : { parent: null, area: par.area }, par.parent ? `Moved “${c.name}” up under “${cardById(par.parent).name}”` : `Moved “${c.name}” out to ${par.area} — it’s top-level now`); }
  if (a === 'reveal') reveal(act.dataset.id);
  if (a === 'toggle-kids') toggleCollapse(c.id);
  if (a === 'attach-hint') { hint('Drag a session from the rail onto this card'); $('#rail').scrollTo({ top: 0, behavior: 'smooth' }); }
  if (a === 'remove-ctx' && state.detail) { const ctx = state.detail.context.filter((_, i) => i !== +act.dataset.idx); mutate(() => api('PATCH', `/api/items/${encodeURIComponent(c.id)}`, { context: ctx }), { msg: 'Removed context ref' }); }
  if (a === 'delete') {
    const n = descendantCount(c.id);
    if (!window.confirm(`Delete “${c.name}”${n ? ` and the ${n} card${n === 1 ? '' : 's'} inside it` : ''}? The Markdown file${n ? 's' : ''} will be removed; attached Claude sessions are untouched.`)) return;
    state.selected = null; state.detail = null;
    mutate(() => api('DELETE', `/api/items/${encodeURIComponent(c.id)}`), { msg: `Deleted ${n + 1} card${n ? 's' : ''}` });
  }
});
$('#inspector').addEventListener('change', e => {
  const c = cardById(state.selected); if (!c) return; const a = e.target.dataset.act;
  if (a === 'rename') { const name = e.target.value.trim(); if (name && name !== c.name) mutate(() => api('PATCH', `/api/items/${encodeURIComponent(c.id)}`, { name }), {}); else e.target.value = c.name; }
  if (a === 'notes') mutate(() => api('PATCH', `/api/items/${encodeURIComponent(c.id)}`, { notes: e.target.value }), { msg: 'Notes saved' });
  if (a === 'park-note' && e.target.value.trim() !== c.parkNote) {
    const note = e.target.value.trim();
    mutate(() => api('PATCH', `/api/items/${encodeURIComponent(c.id)}`, { status: 'parked', park_note: note }), { msg: note ? 'Park note saved' : 'Park note cleared' });
  }
});
$('#inspector').addEventListener('keydown', e => { if (e.target.dataset.act === 'rename' && e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') e.target.blur(); });
$('#inspector').addEventListener('submit', e => {
  e.preventDefault(); const c = cardById(state.selected); if (!c) return;
  if (e.target.dataset.act === 'add-kid-form') { const name = e.target.querySelector('input').value.trim(); if (!name) return; mutate(() => api('POST', '/api/items', { name, parent: c.id }), { msg: `Added “${name}” inside “${c.name}”` }).then(() => collapsed.delete(c.id)); }
  if (e.target.dataset.act === 'add-ctx-form' && state.detail) {
    const [t, r] = e.target.querySelectorAll('input'); if (!r.value.trim()) { toast('A URL or path is required', null, { error: true }); return; }
    mutate(() => api('PATCH', `/api/items/${encodeURIComponent(c.id)}`, { context: [...state.detail.context, { title: t.value.trim() || r.value.trim(), ref: r.value.trim() }] }), { msg: 'Added context ref' });
  }
});

// ------------------------------------------------------------------ top bar / zoom / keys / boot
$('#attnPill').addEventListener('click', jumpNext);
$('#collapseAll').addEventListener('click', () => { const ps = parents(); const all = ps.every(p => collapsed.has(p.id)); ps.forEach(p => all ? collapsed.delete(p.id) : collapsed.add(p.id)); persist(); render(); if (all) $$('.kids').forEach(k => k.classList.add('opening')); });
$('#newIdeaBtn').addEventListener('click', () => { const inbox = AREAS.find(a => a.name.toLowerCase() === 'inbox') || AREAS[0]; if (!inbox) { toast('Create an Area first (+ Area)', null, { error: true }); return; } newCard({ area: inbox.id }); });
$('#newAreaBtn').addEventListener('click', () => { const name = window.prompt('New Area name (becomes a directory)', ''); if (!name || !name.trim()) return; mutate(() => api('POST', '/api/areas', { name: name.trim() }), { msg: `Created area ${name.trim()}` }); });
$('#zoomIn').addEventListener('click', () => zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.25));
$('#zoomOut').addEventListener('click', () => zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, .8));
$('#zoomFit').addEventListener('click', () => fitRect(workspaceRect(), 40));
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'Escape') { if (state.selected) select(null); }
  if (e.key === 'j' || e.key === 'J') jumpNext();
  if (e.key === 'f' || e.key === 'F') $('#zoomFit').click();
  if (e.key === 'n' || e.key === 'N') $('#newIdeaBtn').click();
  if (e.key === '=' || e.key === '+') $('#zoomIn').click();
  if (e.key === '-') $('#zoomOut').click();
});
window.addEventListener('resize', () => applyCam(false));
window.addEventListener('hashchange', () => { const id = hashCard(); if (id && cardById(id) && id !== state.selected) reveal(id); });
function hashCard() { const hsh = location.hash.slice(1); const m = hsh.match(/^card=(.+)$/) || hsh.match(/^\/item\/(.+)$/); return m ? decodeURIComponent(m[1]) : null; }

(async function boot() {
  restore();
  try { await load(); } catch (e) { $('#summary').textContent = 'Could not reach the folio server'; toastError(e); return; }
  render(); applyCam(false);
  const id = hashCard(); if (id && cardById(id)) reveal(id, false);
  setInterval(() => { if (canRefresh()) refresh(); }, POLL_MS);
})();
