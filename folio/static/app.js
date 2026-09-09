/* folio UI: sessions rail · canvas of Areas with nested cards · inspector.
   Vanilla JS, no build step. The app owns every position; the user only changes relations. */
'use strict';

const STATE_LABEL = { needs_you: 'Needs you', working: 'Working', ready: 'Ready', ended: 'Ended', inactive: 'Inactive', unknown: 'No runtime info' };
const RAIL_GROUPS = [['needs_you', 'Needs you'], ['working', 'Working'], ['ready', 'Ready'], ['ended', 'Ended / inactive']];
const POLL_MS = 4000;
// The three canvas modes. `keep` is what earns a card its place on its own merit;
// a card also stays when something inside it stays, and while it is the one you have open.
const LIVE_STATES = new Set(['needs_you', 'working', 'ready']); // same boundary as runtime.is_live()
// Focus is what you are working on with Claude: an open card with a session attached -- ended or
// inactive still counts, the card is yours -- plus anything a session is live on right now, even
// a done card. A card nobody opened a session on, or finished work whose sessions have all gone
// quiet, drops out.
const closedOut = c => lifecycle(c) === 'done' || lifecycle(c) === 'parked';
const FOCUS_MODES = {
  all: { label: 'Showing everything' },
  done: { label: 'Hiding done cards', keep: c => lifecycle(c) !== 'done' },
  live: { label: 'Only cards with a session', keep: c => { const ss = sessOf(c.id); return ss.some(s => LIVE_STATES.has(s.state)) || (ss.length > 0 && !closedOut(c)); } },
};
const FOCUS_ORDER = ['all', 'done', 'live'];

let OV = null, AREAS = [], CARDS = [], SESSIONS = [], SPARES = { standing_by: 0 };
const state = { cam: { x: 16, y: 8, s: 0.9 }, selected: null, detail: null, railFilter: 'all', showHidden: false, allRepos: false, attnCursor: -1, resumeOpen: null, focus: 'all' };
const collapsed = new Set();
const unfolded = new Set(); // parents whose done-fold you have opened (see foldKids)
let VISIBLE = null; // ids the filter keeps, or null when nothing is filtered

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
const copyIcon = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 14 14'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = '<rect x="4.75" y="4.75" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9.25 4.75V3.2A1.45 1.45 0 0 0 7.8 1.75H3.2A1.45 1.45 0 0 0 1.75 3.2v4.6A1.45 1.45 0 0 0 3.2 9.25h1.55" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'; return s; };
// A snooze is a crescent, wherever it appears: the button that silences a ringing card, and the
// quiet badge that says a card is silenced and for how much longer.
const moonIcon = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 14 14'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = '<path d="M11.1 8.9A4.7 4.7 0 0 1 5.1 2.9 4.7 4.7 0 1 0 11.1 8.9Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'; return s; };
const COPY_TIP = 'Copy for Claude — the card’s name, notes, sessions, children and parents as one block to paste into a prompt. The session you paste it into attaches itself to this card.';
const cardById = id => CARDS.find(c => c.id === id);
const areaById = id => AREAS.find(a => a.id === id);
const kidsOf = id => CARDS.filter(c => c.parent === id);
const topOf = a => CARDS.filter(c => !c.parent && c.area === a.id);
// A session can sit on several cards -- one piece of work spans a survey card and the
// prototype it led to -- so `s.items` is a list, and a card's sessions are the rows that name it.
const sessOf = id => SESSIONS.filter(s => s.items.includes(id));
const sessById = id => SESSIONS.find(s => s.id === id);
const cardsOf = s => s.items.map(cardById).filter(Boolean); // the cards it is on that the page knows about
const otherCardsOf = (s, except) => cardsOf(s).filter(c => c.id !== except);
// --- snooze. A finished turn needs you, and says so on every card it sits on. Once you have
// read it and know you are not getting to it before lunch, that is no longer information: it is
// noise on top of the cards that do need you. Snoozing silences one attention -- the session
// stays `needs_you`, the rail still lists it and says until when, and only the roll-ups below
// stop counting it, so its cards go quiet. The server drops the snooze the moment the session's
// state changes, so the next thing that needs you can never be silenced by a snooze you set on
// the last one; this page only ever asks for one and reads back what the server decided.
const SNOOZE_OPTS = [['1 hour', 60], ['3 hours', 180], ['1 day', 1440]];
const SNOOZE_TIP = 'Snooze — you have read it and cannot get to it now. The session still needs you and stays in the list; the card just stops ringing until the time is up, or until the session does something new.';
const snoozed = s => !!s.snoozed;                            // the server's word, not this browser's clock
const needy = s => s.state === 'needs_you' && !s.snoozed;    // needs you *and* has not been silenced
const snoozeLeft = s => Math.max(0, new Date(s.snoozeUntil || 0).getTime() - Date.now());
// How long until the quiet ends: for a group, when the first of them starts ringing again.
const snoozeText = ss => ageText(Math.min(...[].concat(ss).map(snoozeLeft)) / 1000);
const quoteNames = cs => cs.map(c => `“${c.name}”`).join(', ');
const parents = () => CARDS.filter(c => isVisible(c) && visKidsOf(c.id).length);
const lifecycle = c => c.lifecycle || 'idea';
// What a session is called: your own name for it, else the title Claude Code gave
// it (read live from its transcript), else the id.
const sessTitle = s => s.title || s.autoTitle || `Untitled · ${s.short}`;
const sessTip = s => [sessTitle(s), s.prompt && `last prompt: ${s.prompt}`, s.id].filter(Boolean).join('\n');
// The age on a session is Claude Code's clock -- its last hook event -- not when folio last looked.
const agoText = iso => !iso ? 'no activity seen' : timeAgo(iso) === 'now' ? 'active just now' : `active ${timeAgo(iso)} ago`;
const agoTip = s => !s.updated ? 'Claude Code has not reported any activity for this session — is the folio hook installed?'
  : `Claude Code last reported activity ${timeAgo(s.updated) === 'now' ? 'under a minute' : timeAgo(s.updated)} ago${s.lastEvent ? ` (${s.lastEvent})` : ''}, at ${new Date(s.updated).toLocaleString()}.\nThat is Claude's clock, not folio's: folio re-reads these records every ${POLL_MS / 1000}s — see “checked … ago” at the top of the Sessions list.`;
function ancestors(id) { const out = []; let c = cardById(id); while (c && c.parent) { out.unshift(c.parent); c = cardById(c.parent); } return out; }
function areaOf(id) { let c = cardById(id); while (c && c.parent) c = cardById(c.parent); return c ? areaById(c.area) : null; }
function isDescendant(id, ofId) { let c = cardById(id); while (c && c.parent) { if (c.parent === ofId) return true; c = cardById(c.parent); } return false; }
function descendantCount(id, vis = false) { return (vis ? visKidsOf(id) : kidsOf(id)).reduce((n, k) => n + 1 + descendantCount(k.id, vis), 0); }
// --- the focus filter. Structure (kidsOf/topOf) stays whole -- moves, deletes and
// undo must see the real tree; only what the canvas draws is filtered.
const isVisible = c => !VISIBLE || VISIBLE.has(c.id);
const visKidsOf = id => kidsOf(id).filter(isVisible);
const visTopOf = a => topOf(a).filter(isVisible);
function computeVisible() {
  const keepOwn = (FOCUS_MODES[state.focus] || FOCUS_MODES.all).keep;
  if (!keepOwn) { VISIBLE = null; return; }
  VISIBLE = new Set();
  // A card the mode would drop still shows when something inside it survives -- the parent
  // is the way in -- or when one of its own sessions needs you: the filter must never
  // swallow a card that is asking for you.
  const keep = c => {
    const kidsKept = kidsOf(c.id).map(keep).includes(true); // map, not some: every child is visited
    const v = kidsKept || keepOwn(c) || sessOf(c.id).some(needy);
    if (v) VISIBLE.add(c.id);
    return v;
  };
  CARDS.filter(c => !c.parent).forEach(keep);
  // whatever you have open stays on the canvas, filter or not, with its ancestors
  if (state.selected && cardById(state.selected)) { VISIBLE.add(state.selected); ancestors(state.selected).forEach(id => VISIBLE.add(id)); }
}
// A session goes where its cards go: when the filter drops every card it is on, the rail
// drops the row too. An unattached row has no card to follow, so it always stays --
// and a session that needs you keeps its cards visible, so it can never be hidden here.
const railVisible = s => { const cs = cardsOf(s); return !cs.length || cs.some(isVisible); };
// The rail's own filter, applied before the canvas one above. *Unattached* is a list of
// sessions on no card, and most sessions never get one -- a question answered, a one-off
// in another repo -- so it silts up with a week of them and stops being useful. Hiding a
// row takes it out of this list and nothing else. `tucked` counts what that hid, so the
// rail can always say so and list them again (see renderRail's line at the bottom).
function railRows(list, filter, withHidden) {
  // Needs you leaves out what you snoozed -- silencing it and still being listed under the
  // one heading you check would make the gesture pointless -- and counts it as `tucked`, so
  // the line under the list can bring them back the way the hidden ones come back.
  if (filter === 'attention') {
    const all = list.filter(s => s.state === 'needs_you');
    return { rows: withHidden ? all : all.filter(s => !snoozed(s)), tucked: all.filter(snoozed).length };
  }
  if (filter !== 'unattached') return { rows: list, tucked: 0 };
  const free = list.filter(s => !s.items.length);
  return { rows: withHidden ? free : free.filter(s => !s.hidden), tucked: free.filter(s => s.hidden).length };
}
const hiddenCount = () => VISIBLE ? CARDS.length - VISIBLE.size : 0;
// --- the done fold. Finished work piles up under a long-lived parent, and a card with a dozen
// done children was a column taller than the rest of the canvas put together. So a long list
// folds its done children into one line -- "13 done" -- and stays the height of its open work.
// The line opens on a click. Nothing is filtered: the fold is drawing, not visibility, and a
// short list never folds (the line would be as tall as what it replaced).
// A done card stays out of the fold for the same reasons Hide done keeps it on the canvas:
// something inside it is still open, a session is live on it, or it is the card you have open.
const FOLD_AT = 6; // a list longer than this folds
function foldable(c) { return lifecycle(c) === 'done' && c.id !== state.selected && !sessOf(c.id).some(s => LIVE_STATES.has(s.state)) && kidsOf(c.id).every(foldable); }
function foldKids(id, kids) { // -> { shown, folded }: the children to draw, and the done ones the line stands for
  if (kids.length <= FOLD_AT) return { shown: kids, folded: [] };
  const folded = kids.filter(foldable);
  return { shown: unfolded.has(id) ? kids : kids.filter(k => !folded.includes(k)), folded }; // open, the line still counts them
}
// --- end of the done fold
function ageText(s) { if (s < 45) return 'now'; if (s < 3600) return `${Math.round(s / 60)}m`; if (s < 86400) return `${Math.round(s / 3600)}h`; return `${Math.round(s / 86400)}d`; }  // s = seconds
function timeAgo(iso) { return iso ? ageText(Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)) : '—'; }
function shortPath(p) { if (!p) return ''; const m = p.match(/^\/(?:Users|home)\/[^/]+/); return m ? '~' + p.slice(m[0].length) : p; }
function railState(s) { return ['needs_you', 'working', 'ready'].includes(s.state) ? s.state : 'ended'; }
function isEditing() { const a = document.activeElement; return !!(a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable)); }
function persist() {
  try { localStorage.setItem('folio.collapsed', JSON.stringify([...collapsed])); localStorage.setItem('folio.unfolded', JSON.stringify([...unfolded])); localStorage.setItem('folio.cam', JSON.stringify(state.cam)); localStorage.setItem('folio.focus', state.focus); } catch (e) { /* private mode etc. */ }
}
function restore() {
  try {
    (JSON.parse(localStorage.getItem('folio.collapsed') || '[]')).forEach(id => collapsed.add(id));
    (JSON.parse(localStorage.getItem('folio.unfolded') || '[]')).forEach(id => unfolded.add(id));
    const cam = JSON.parse(localStorage.getItem('folio.cam') || 'null'); if (cam && typeof cam.s === 'number') state.cam = cam;
    const f = localStorage.getItem('folio.focus'); if (f && FOCUS_MODES[f]) state.focus = f;
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
  SESSIONS = OV.sessions.map(s => ({ id: s.id, short: s.short_id, title: s.title || '', autoTitle: s.auto_title || '', prompt: s.last_prompt || '', hidden: !!s.hidden, state: s.state, attention: s.attention, snoozed: !!s.snoozed, snoozeUntil: s.snooze_until, updated: s.updated_at, lastEvent: s.last_event, cwd: s.cwd, branch: s.branch, inRepo: s.in_repo, items: s.items || (s.item ? [s.item] : []), resume: s.resume }));
  // Claude Code's pre-started next background session(s): not sessions yet, so the server
  // counts them instead of listing them -- the rail shows one quiet line, never a row.
  SPARES = OV.spares || { standing_by: 0 };
  if (state.selected && !cardById(state.selected)) { state.selected = null; state.detail = null; }
}
async function loadDetail(id) {
  try { const d = await api('GET', `/api/items/${encodeURIComponent(id)}`); if (state.selected === id) { state.detail = d; renderInspector(); } }
  catch (e) { /* card may have vanished; the next refresh clears the selection */ }
}
async function reload() {  // one full read of the server, and the page redrawn from it
  const first = !OV;
  await load();
  FRESH.at = Date.now(); FRESH.error = null;
  render();
  if (state.selected) loadDetail(state.selected);
  if (first) { applyCam(false); const id = hashCard(); if (id && cardById(id)) reveal(id, false); }
}
async function refresh() { try { await reload(); } catch (e) { toastError(e); } }  // for something you asked for: a failure is a toast
async function poll() {  // for the ticker: a failure is a state of the indicator, and the next tick tries again
  FRESH.tried = Date.now();
  try { await reload(); } catch (e) { FRESH.error = (e && e.message) || String(e); renderFresh(); }
}
function canRefresh() { return !ptr && !sdrag && !isEditing() && !popEl && !$('.scrim') && inFlight === 0 && !document.hidden && !$('#toast').classList.contains('show'); }  // an open menu or confirm dialog owns the canvas until it closes

// ------------------------------------------------------------------ freshness
// Two clocks show on this page and they are easy to confuse. The "3m" on a session row is Claude
// Code's: when its hook last fired for that session. This one is folio's: when this page last read
// those records. It ticks every second, so a pause -- polling stops while you type, drag or have a
// menu open, so nothing moves under you -- is something you can see rather than a page gone quiet.
const FRESH = { at: 0, tried: 0, error: null };  // ms clock of the last successful read, of the last attempt, and why it failed
function pauseReason() {
  if (document.hidden) return 'this tab is in the background';
  if (isEditing()) return 'you are typing';
  if (ptr || sdrag) return 'you are dragging';
  if (popEl || $('.scrim')) return 'a menu or dialog is open';
  if ($('#toast').classList.contains('show')) return 'a message is showing';
  return null;
}
function freshLabel(f, now, paused) {
  const secs = f.at ? Math.max(0, Math.round((now - f.at) / 1000)) : null;
  const ago = secs === null ? null : secs < 2 ? 'just now' : secs < 60 ? `${secs}s ago` : `${ageText(secs)} ago`;
  const every = `Claude Code's session records every ${POLL_MS / 1000}s.`;
  const clocks = 'The time on a session row is a different clock: it says when Claude Code last reported activity for that session.';
  if (f.error) return { cls: 'err', text: ago ? `unreachable · ${ago}` : 'server unreachable', title: `The last read failed: ${f.error}\nWhat you see is from the last successful read${ago ? `, ${ago}` : ''}. folio keeps trying to re-read ${every} Click to retry now.` };
  if (paused) return { cls: 'paused', text: ago ? `paused · checked ${ago}` : 'paused', title: `Not refreshing while ${paused}, so nothing moves under you. It resumes on its own. Click to refresh now.\n\n${clocks}` };
  return { cls: '', text: ago ? `checked ${ago}` : 'checking…', title: `folio re-reads ${every} Click to check now.\n\n${clocks}` };
}
function renderFresh() {
  const el = $('#fresh'); if (!el) return;
  const l = freshLabel(FRESH, Date.now(), pauseReason());
  // updated in place, and only what changed: this runs every second, and a rewritten title would flicker the tooltip you are reading
  const cls = 'fresh' + (l.cls ? ` ${l.cls}` : ''), ft = $('.ft', el);
  if (el.className !== cls) el.className = cls;
  if (el.title !== l.title) el.title = l.title;
  if (ft.textContent !== l.text) ft.textContent = l.text;
  if (!OV) $('#summary').textContent = FRESH.error ? 'Could not reach the folio server' : 'Loading…';
}
function tick() { if (canRefresh() && Date.now() - FRESH.tried >= POLL_MS) poll(); else renderFresh(); }
function pollNow() { FRESH.tried = 0; tick(); }  // back to the tab, or the window: do not wait out the interval

// mutation helper: run the request, reload, toast (with an inverse request as Undo)
async function mutate(run, { msg, undo, error = 'Something went wrong' } = {}) {
  try {
    await run();
    await reload();
    if (msg) toast(msg, undo ? async () => { try { await undo(); await reload(); } catch (e) { toastError(e); } } : null);
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

// ------------------------------------------------------------------ copy for Claude
// One card as a block of text for a prompt: "work on this (<paste>)". The server writes
// the block (it has the notes of every ancestor, which the canvas does not); the page only
// puts it on the clipboard. When the browser refuses -- no permission, or the gesture has
// expired by the time the fetch returns -- the text is shown selected, one ⌘C away.
async function copyBrief(c) {
  if (!c) return;
  let text;
  try { text = (await api('GET', `/api/items/${encodeURIComponent(c.id)}/brief`)).text; } catch (e) { toastError(e); return; }
  try { await navigator.clipboard.writeText(text); toast(`Copied “${c.name}” for Claude — paste it into your prompt`); flashCard(c.id); }
  catch (e) { showBriefToCopy(c, text); }
}
function showBriefToCopy(c, text) {
  const prev = document.activeElement;
  const src = h('textarea', { class: 'brief-src', readonly: true, spellcheck: 'false', 'aria-label': `Brief for ${c.name}` }); src.value = text;
  const done = h('button', { class: 'cancel', type: 'button' }, 'Done');
  const dlg = h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true' },
    h('h3', {}, `Copy “${c.name}” for Claude`),
    h('p', { class: 'dlg-note' }, 'The browser would not write to the clipboard. The text below is selected — press ⌘C (Ctrl+C), then paste it into your prompt.'),
    src, h('div', { class: 'dlg-acts' }, done));
  const scrim = h('div', { class: 'scrim' }, dlg);
  const close = () => { document.removeEventListener('keydown', onKey, true); scrim.remove(); if (prev && prev.focus) prev.focus(); };
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  done.addEventListener('click', close);
  scrim.addEventListener('pointerdown', e => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(scrim);
  requestAnimationFrame(() => { scrim.classList.add('show'); src.focus(); src.select(); });
}

// ------------------------------------------------------------------ derived
function attn(id) {
  let needs = 0, working = 0, snooz = 0, ownNeeds = 0, ownWorking = 0, ownSnoozed = 0;
  const seen = new Set(); // a session on both a card and its child is one session, counted once
  const walk = (cid, own) => { for (const s of sessOf(cid)) { if (seen.has(s.id)) continue; seen.add(s.id); if (needy(s)) { needs++; if (own) ownNeeds++; } else if (snoozed(s)) { snooz++; if (own) ownSnoozed++; } else if (s.state === 'working') { working++; if (own) ownWorking++; } } for (const k of kidsOf(cid)) walk(k.id, false); };
  walk(id, true);
  return { needs, working, snoozed: snooz, ownNeeds, ownWorking, ownSnoozed, descNeeds: needs - ownNeeds, descWorking: working - ownWorking, descSnoozed: snooz - ownSnoozed };
}
// A collapsed parent stands in for what is inside it -- its ring is the ring of a session two
// levels down -- so the snooze under that ring has to reach those sessions too. Expanded, every
// card draws its own ring and owns only its own sessions.
const standsIn = id => collapsed.has(id) && visKidsOf(id).length > 0;
function attnSessions(id, pick, deep = null) {
  const seen = new Set(), out = [], down = deep === null ? standsIn(id) : deep;
  const walk = cid => {
    for (const s of sessOf(cid)) { if (seen.has(s.id)) continue; seen.add(s.id); if (pick(s)) out.push(s); }
    if (down) for (const k of kidsOf(cid)) walk(k.id);
  };
  walk(id);
  return out;
}
// Sessions, not cards: a session on two cards in the area is one thing needing you.
function areaAttn(a) { const inArea = new Set(CARDS.filter(c => c.area === a.id).map(c => c.id)); const ss = SESSIONS.filter(s => s.items.some(id => inArea.has(id))); return { needs: ss.filter(needy).length, working: ss.filter(s => s.state === 'working').length, snoozed: ss.filter(snoozed).length }; }
const needsYouCount = () => SESSIONS.filter(s => needy(s) && cardsOf(s).length).length; // attached sessions asking for you
const snoozedCount = () => SESSIONS.filter(s => snoozed(s) && cardsOf(s).length).length; // ...and the ones you silenced
function needsYouCards() { return CARDS.filter(c => sessOf(c.id).some(needy)); }
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
function sessChip(s, card) {
  const also = otherCardsOf(s, card), zz = snoozed(s);
  return h('span', { class: `sess ${s.state}${zz ? ' snoozed' : ''}`, 'data-sid': s.id, title: `${sessTitle(s)} — ${STATE_LABEL[s.state] || s.state}${s.attention ? ' · ' + s.attention : ''}${zz ? `, snoozed — quiet for another ${snoozeText(s)}` : ''}${s.prompt ? `\n\nlast prompt: ${s.prompt}` : ''}${also.length ? `\n\nalso on ${quoteNames(also)}` : ''}\n\nDrag to another card to move it there; off the card to detach it from this one.` }, h('i', { class: `dot ${s.state}${zz ? ' snoozed' : ''}` }), sessTitle(s));
}
function cardEl(c, depth = 0) {
  const kids = visKidsOf(c.id), hiddenKids = kidsOf(c.id).length - kids.length, sess = sessOf(c.id), lc = lifecycle(c), ag = attn(c.id);
  const isCollapsed = kids.length > 0 && collapsed.has(c.id);
  const loud = ag.ownNeeds > 0 || (isCollapsed && ag.descNeeds > 0); // attention shows where it is, or rolled up when hidden
  const el = h('div', { class: `card ${lc} ${kids.length ? 'has-kids' : ''} ${isCollapsed ? 'collapsed' : ''} ${loud ? 'attn' : ''} ${state.selected === c.id ? 'selected' : ''}`, 'data-id': c.id, 'data-depth': String(depth), tabindex: '0' });
  if (isCollapsed) el.appendChild(h('i', { class: 'stack2' }));
  // The ring is a drawn element rather than a pseudo-element: the card already spends ::after on
  // the collapsed deck edge and ::before on the drop hint, and a card can be all three at once.
  if (loud) el.appendChild(h('i', { class: 'ring', 'aria-hidden': 'true' }));
  const head = h('div', { class: 'card-head' }, h('i', { class: `glyph ${lc}`, title: lc }), h('span', { class: 'title' }, c.name));
  if (isCollapsed && ag.descNeeds) head.appendChild(h('span', { class: 'badge attn' }, h('i', { class: 'dot needs_you' }), ag.descNeeds === 1 ? 'needs you' : `${ag.descNeeds} need you`));
  else if (isCollapsed && ag.descWorking) head.appendChild(h('span', { class: 'badge work' }, h('i', { class: 'dot working' }), 'working'));
  // The off-switch for the ring, and -- once it is off -- the badge that says so and how long is
  // left. Both sit in the head, next to what they are about: a ringing card you cannot get to is
  // silenced where you noticed it, without opening anything.
  const zzz = attnSessions(c.id, snoozed);
  if (loud) head.appendChild(h('button', { class: 'zz', 'data-act': 'snooze', title: SNOOZE_TIP, 'aria-label': `Snooze the session that needs you on “${c.name}”` }, moonIcon()));
  else if (zzz.length) head.appendChild(h('button', { class: 'badge zzed', 'data-act': 'wake', title: `${zzz.length === 1 ? 'A session here still needs you' : `${zzz.length} sessions here still need you`} — snoozed, back in ${snoozeText(zzz)}. Click to bring ${zzz.length === 1 ? 'it' : 'them'} back now.` }, moonIcon(), snoozeText(zzz)));
  const hiddenNote = hiddenKids ? ` · ${hiddenKids} hidden by the filter` : '';
  if (kids.length) head.appendChild(h('button', { class: 'tog', 'data-act': 'toggle', title: (isCollapsed ? `Show ${descendantCount(c.id, true)} inside` : 'Collapse this card') + hiddenNote }, String(kids.length), chevron()));
  else if (hiddenKids) head.appendChild(h('span', { class: 'tog hid', title: `${hiddenKids} card${hiddenKids === 1 ? '' : 's'} inside — hidden by the filter` }, `${hiddenKids} hidden`));
  head.appendChild(h('button', { class: 'card-copy', 'data-act': 'copy-brief', title: COPY_TIP, 'aria-label': `Copy “${c.name}” for Claude` }, copyIcon()));
  head.appendChild(h('button', { class: 'card-add', 'data-act': 'add-child', title: `New idea inside “${c.name}”`, 'aria-label': `New idea inside “${c.name}”` }, '+'));
  el.appendChild(head);
  if (sess.length) {
    const row = h('div', { class: 'card-row' });
    sess.slice(0, 2).forEach(s => row.appendChild(sessChip(s, c.id)));
    if (sess.length > 2) row.appendChild(h('span', { class: 'sess', title: sess.slice(2).map(sessTitle).join('\n') }, `+${sess.length - 2}`));
    el.appendChild(row);
  }
  if (isCollapsed) el.appendChild(compStrip(kids));
  if (kids.length && !isCollapsed) {
    const { shown, folded } = foldKids(c.id, kids);
    const list = h('div', { class: 'kids-list' }, ...shown.map(k => cardEl(k, depth + 1)));
    if (folded.length) list.appendChild(foldLine(c, folded.length));
    el.appendChild(h('div', { class: 'kids' }, h('div', {}, list)));
  }
  return el;
}
// the line a long list folds its done children into. It sits last, where finished work would
// have trailed off anyway, and is the way to see those cards in place again.
function foldLine(c, n) {
  const open = unfolded.has(c.id), cards = `${n} done card${n === 1 ? '' : 's'}`;
  return h('button', { class: `fold${open ? ' open' : ''}`, 'data-act': 'fold', 'aria-expanded': open ? 'true' : 'false',
    title: open ? `Fold the ${cards} back into this line` : `${cards}, folded so a long list stays short — click to show them here` },
    h('i', { class: 'glyph done' }), `${n} done`, chevron());
}
function areaEl(a) {
  const cards = visTopOf(a), aa = areaAttn(a), cols = colsFor(cards.length);
  const shown = VISIBLE ? CARDS.filter(c => c.area === a.id && isVisible(c)).length : a.count;
  const meta = h('span', { class: 'area-meta' }, shown === a.count ? `${a.count} card${a.count === 1 ? '' : 's'}` : `${shown} of ${a.count} cards`);
  if (aa.needs) meta.appendChild(h('span', { class: 'a' }, h('i', { class: 'dot needs_you' }), `${aa.needs} need${aa.needs === 1 ? 's' : ''} you`));
  if (aa.working) meta.appendChild(h('span', { class: 'w' }, h('i', { class: 'dot working' }), `${aa.working} working`));
  if (aa.snoozed) meta.appendChild(h('span', { class: 'z', title: `Still needs you, snoozed on purpose — the cards go quiet until the time is up.` }, h('i', { class: 'dot needs_you snoozed' }), `${aa.snoozed} snoozed`));
  const colEls = Array.from({ length: cols }, () => h('div', { class: 'col' }));
  cards.forEach((c, i) => colEls[columnOf(i, cols)].appendChild(cardEl(c, 0)));
  const hiddenTop = topOf(a).length - cards.length;
  if (!cards.length) colEls[0].appendChild(h('div', { class: 'empty' },
    hiddenTop ? `${hiddenTop} card${hiddenTop === 1 ? '' : 's'} here, all hidden by the filter.`
      : a.count ? 'Every card here is nested under a parent in another Area.'
        : 'No cards yet — press + or drop a session here'));
  return h('section', { class: 'area', 'data-area': a.id },
    h('header', { class: 'area-head' }, h('h2', { class: 'area-title' }, a.name), meta,
      h('button', { class: `area-menu${popKey === `area:${a.id}` ? ' open' : ''}`, 'data-act': 'area-menu', 'aria-haspopup': 'menu', title: `More for ${a.name}` }, '\u22EF'),
      h('button', { class: 'area-add', 'data-act': 'add-to-area', title: `New idea in ${a.name}` }, '+')),
    h('div', { class: 'cols' }, ...colEls));
}
// ------------------------------------------------------------------ area layout
// Areas stack in columns, ceil(sqrt(n)) of them. That is a count, not a pixel budget: an Area that
// grows a third column widens its own column, and nothing a card does changes how many columns there
// are. Which column an Area lands in is decided by height. Each Area, in order, goes under the
// shortest column so far, so a one-card Area sits right under a short neighbour instead of a screen
// below the tallest one (rows were as tall as their tallest member, and the small Area alone in the
// second row sat under all that blank space). Heights are read from the DOM, so the packing is
// remembered between renders and redone only when a fresh one would cut the canvas height by more
// than LAYOUT_SLACK -- a card created, folded or hidden nudges heights every few seconds, and that
// must not shuffle Areas around.
const areaColumns = n => Math.ceil(Math.sqrt(n));
const LAYOUT_SLACK = 240;   // px of canvas height a fresh packing must save before Areas move
function packAreas(areas, heightOf, cols, gap) {   // -> one list per column, top to bottom
  const out = Array.from({ length: cols }, () => []), tall = new Array(cols).fill(0);
  for (const a of areas) {
    let k = 0; for (let i = 1; i < cols; i++) if (tall[i] < tall[k]) k = i;   // shortest; ties go left
    tall[k] += (out[k].length ? gap : 0) + heightOf(a); out[k].push(a);
  }
  return out;
}
const canvasHeight = (packed, heightOf, gap) => Math.max(0, ...packed.map(col => col.reduce((s, a, i) => s + (i ? gap : 0) + heightOf(a), 0)));
let LAYOUT = null;   // the packing on screen: { key: ordered Area ids, cols: [[id, ...], ...] }
function layoutAreas(areas, heightOf, gap) {
  const key = areas.map(a => a.id).join('\n'), fresh = packAreas(areas, heightOf, areaColumns(areas.length), gap);
  if (LAYOUT && LAYOUT.key === key) {
    const kept = LAYOUT.cols.map(ids => ids.map(id => areas.find(a => a.id === id)));
    if (canvasHeight(kept, heightOf, gap) <= canvasHeight(fresh, heightOf, gap) + LAYOUT_SLACK) return kept;
  }
  LAYOUT = { key, cols: fresh.map(col => col.map(a => a.id)) };
  return fresh;
}
function render() {
  computeVisible();
  world.innerHTML = '';
  // build every Area first and measure it, then move each into the column the packing picks
  const els = new Map(AREAS.map(a => [a.id, areaEl(a)]));
  world.appendChild(h('div', { class: 'area-col' }, ...els.values()));
  const gap = parseFloat(getComputedStyle(world).columnGap) || 0;
  const cols = layoutAreas(AREAS, a => els.get(a.id).offsetHeight, gap);
  world.innerHTML = '';
  cols.forEach(col => world.appendChild(h('div', { class: 'area-col' }, ...col.map(a => els.get(a.id)))));
  world.appendChild(h('i', { class: 'insline', id: 'insline' }));
  if (!AREAS.length) stage.appendChild(h('div', { class: 'empty-state', id: 'emptyState' }, h('div', {}, h('div', { style: 'font-family:var(--serif);font-style:italic;font-size:22px;color:var(--ink);margin-bottom:6px' }, 'Nothing here yet'), 'Create an Area with + Area, then + Idea.')));
  else { const es = $('#emptyState'); if (es) es.remove(); }
  renderTopbar(); renderRail(); renderInspector(); renderAttnPill(); renderFresh();
}
function renderFocus() {
  const hid = hiddenCount();
  $$('#focus button').forEach(b => b.classList.toggle('on', b.dataset.focus === state.focus));
  const n = $('#focusCount');
  n.hidden = !hid;
  n.textContent = `${hid} hidden`;
  n.title = `${hid} card${hid === 1 ? '' : 's'} hidden by the filter — click to show everything.\nA card whose session needs you is never hidden.`;
}
function renderTopbar() {
  const shown = VISIBLE ? VISIBLE.size : CARDS.length;
  const cards = shown === CARDS.length ? `${CARDS.length} card${CARDS.length === 1 ? '' : 's'}` : `${shown} of ${CARDS.length} cards`;
  $('#summary').textContent = `${AREAS.length} area${AREAS.length === 1 ? '' : 's'} · ${cards} · ${SESSIONS.length} session${SESSIONS.length === 1 ? '' : 's'}`;
  renderFocus();
  const ps = parents(); $('#collapseAll').textContent = ps.length && ps.every(p => collapsed.has(p.id)) ? 'Expand all' : 'Collapse all';
  const repo = OV && OV.repo, el = $('#repo');
  if (repo) { el.textContent = repo.error ? `⚠ ${repo.error}` : `${shortPath(repo.path)} · ${repo.worktrees.length} worktree${repo.worktrees.length === 1 ? '' : 's'}`; el.classList.toggle('err', !!repo.error); el.title = repo.error || (repo.worktrees || []).map(w => `${w.branch || '(detached)'}  ${w.path}`).join('\n'); }
  $('#stale').hidden = !(OV && OV.server && OV.server.stale);
}
function renderAttnPill() {
  const n = needsYouCount(), working = SESSIONS.filter(s => s.state === 'working').length, zz = snoozedCount(), pill = $('#attnPill');
  const trail = t => pill.append(h('span', { class: 'muted', style: 'margin-left:6px;font-weight:400' }, `· ${t}`));
  pill.innerHTML = '';
  if (n) { pill.append(h('i', { class: 'dot needs_you', style: 'margin-right:7px' }), `${n} need${n === 1 ? 's' : ''} you`); if (working) trail(`${working} working`); pill.style.borderColor = 'var(--attn)'; pill.style.color = 'var(--attn-ink)'; }
  else { pill.append(working ? h('i', { class: 'dot working', style: 'margin-right:7px' }) : '', working ? `${working} working` : 'All quiet'); pill.style.borderColor = ''; pill.style.color = ''; }
  // Snoozed sessions still need you. They are out of the count on purpose, never out of sight:
  // the pill says how many are waiting quietly, and Needs you in the rail lists them on request.
  if (zz) trail(`${zz} snoozed`);
  pill.title = `Press J to jump to the next card that needs you.${zz ? `\n\n${zz === 1 ? 'One session is' : `${zz} sessions are`} snoozed: still needing you, not counted, and quiet until the time is up. The Needs you list in the rail brings them back.` : ''}`;
}
// Hiding: one row, or a whole list of them in one request (and one Undo). Nothing is
// destroyed and nothing is named -- a hidden session only leaves the Unattached list.
const hideApi = (ids, hidden) => ids.length === 1
  ? api('PATCH', `/api/sessions/${encodeURIComponent(ids[0])}`, { hidden })
  : api('POST', '/api/sessions/hide', { session_ids: ids, hidden });
function hideSessions(ss, hidden) {
  const ids = ss.map(s => s.id); if (!ids.length) return Promise.resolve();
  const what = ids.length === 1 ? `“${sessTitle(ss[0])}”` : `${ids.length} sessions`;
  return mutate(() => hideApi(ids, hidden), {
    msg: hidden ? `Hid ${what} — out of Unattached, still under All` : `${what} back in Unattached`,
    undo: () => hideApi(ids, !hidden),
  });
}
// Snoozing: the same shape as hiding, one request for however many rows the gesture covers, and
// one Undo. Waking is offered no Undo -- it takes a fresh choice of how long, not a repeat of the
// old one, and the menu is right there.
const snoozeApi = (ids, minutes) => api('POST', '/api/sessions/snooze', { session_ids: ids, minutes });
function snoozeSessions(ss, minutes) {
  const ids = ss.map(s => s.id); if (!ids.length) return Promise.resolve();
  const what = ids.length === 1 ? `“${sessTitle(ss[0])}”` : `${ids.length} sessions`;
  const dur = (SNOOZE_OPTS.find(([, m]) => m === minutes) || [`${minutes} minutes`])[0].toLowerCase();
  return mutate(() => snoozeApi(ids, minutes), {
    msg: minutes ? `Snoozed ${what} for ${dur} — still needs you, just quiet` : `Woke ${what}`,
    undo: minutes ? () => snoozeApi(ids, 0) : null,
  });
}
// The button at the end of an unattached row: hide it, or -- when you are looking at the
// hidden ones -- put it back. A session on a card is not in that list, so it gets neither.
function hideChip(s) {
  if (s.items.length) return '';
  if (s.hidden) return h('button', { class: 'where act', title: 'Hidden from Unattached — click to put it back in the list', onclick: () => hideSessions([s], false) }, 'hidden · unhide');
  return h('button', { class: 'where act onhover', title: 'Hide it from Unattached. Nothing is deleted: it stays under All, and the line at the bottom of this list brings the hidden ones back.', onclick: () => hideSessions([s], true) }, 'hide');
}
// The same pair on a rail row, for the session rather than the card: this is where you triage,
// and a row you have read is silenced without going looking for the cards it is on.
function snoozeChip(s) {
  if (s.state !== 'needs_you') return '';
  if (snoozed(s)) return h('button', { class: 'where act zzed', title: `Snoozed — still needs you, quiet for another ${snoozeText(s)}. Click to bring it back now.`, onclick: () => snoozeSessions([s], 0) }, moonIcon(), `${snoozeText(s)} · wake`);
  return h('button', { class: 'where act onhover', title: SNOOZE_TIP, onclick: e => openSnoozeMenu(e.currentTarget, [s]) }, 'snooze');
}
function renderRail() {
  const rail = $('#rail'); rail.innerHTML = '';
  const picked = railRows(SESSIONS, state.railFilter, state.showHidden), tucked = picked.tucked;
  const shown = picked.rows.filter(railVisible), offBoard = picked.rows.length - shown.length; // a row goes wherever its card went
  let list = shown;
  const unhidden = state.railFilter === 'unattached' ? list.filter(s => !s.hidden) : [];
  $('#railCount').textContent = `${list.length}/${SESSIONS.length}`;
  // Clearing out a rail that has collected a fortnight of one-off sessions is one gesture,
  // not twenty: this hides exactly the rows listed below it, and the toast undoes the lot.
  // Both bulk actions sit above the list -- under it they would be a screen of scrolling away.
  const bulk = h('div', { class: 'rail-bulk' });
  if (unhidden.length > 1) bulk.appendChild(h('button', { onclick: () => hideSessions(unhidden, true),
    title: `Hide all ${unhidden.length} sessions listed here. Nothing is deleted — they stay under All, the line at the bottom lists them again, and Undo puts them straight back.` },
    `Hide all ${unhidden.length}`));
  if (state.showHidden && tucked) bulk.appendChild(h('button', { onclick: () => hideSessions(SESSIONS.filter(s => s.hidden && !s.items.length), false),
    title: `Put all ${tucked} hidden sessions back in this list.` }, `Unhide all ${tucked}`));
  if (bulk.children.length) rail.appendChild(bulk);
  let any = false;
  for (const [st, label] of RAIL_GROUPS) {
    const rows = list.filter(s => railState(s) === st); if (!rows.length) continue; any = true;
    const g = h('div', { class: 'rail-group' }, h('h2', {}, h('i', { class: `dot ${st}` }), label, h('span', { class: 'n' }, String(rows.length))));
    for (const s of rows) {
      // one chip per card the session sits on -- click one to go to that card
      const cards = cardsOf(s);
      const where = h('div', { class: 'wheres' }, cards.length
        ? cards.map(card => h('span', { class: 'where', 'data-id': card.id, title: `On “${card.name}” — click to go there` }, h('i', { class: `glyph ${lifecycle(card)}` }), card.name))
        : (s.hidden ? '' : h('span', { class: 'where none' }, 'unattached · drag onto a card')), snoozeChip(s), hideChip(s));
      g.appendChild(h('div', { class: `srow${s.hidden && !cards.length ? ' tucked' : ''}${snoozed(s) ? ' snoozed' : ''}`, 'data-sid': s.id, tabindex: '0', title: sessTip(s) }, h('i', { class: `dot ${s.state}${snoozed(s) ? ' snoozed' : ''}` }),
        h('div', { style: 'min-width:0' }, h('div', { class: 't' }, sessTitle(s)),
          s.prompt ? h('div', { class: 'p' }, s.prompt) : '',
          h('div', { class: 'm' }, s.branch ? h('span', { class: 'br' }, s.branch) : (s.cwd ? h('span', { class: 'cwd', title: s.cwd }, shortPath(s.cwd)) : ''), s.attention ? h('span', {}, `· ${s.attention}`) : '', h('span', { class: 'sid' }, s.short), h('span', { class: 'ago', title: agoTip(s) }, timeAgo(s.updated))),
          where)));
    }
    rail.appendChild(g);
  }
  if (!any) rail.appendChild(h('div', { class: 'rail-empty' }, offBoard ? 'Every session here is on a card the filter hides.' : state.railFilter === 'unattached' ? (tucked ? 'Nothing left in Unattached — the rest are hidden.' : 'Every session is attached to a card.') : state.railFilter === 'attention' ? (tucked ? `Nothing needs you right now — ${tucked === 1 ? 'the one session that does is' : `the ${tucked} sessions that do are`} snoozed.` : 'Nothing needs you right now.') : 'No Claude sessions observed yet. Install the hook (folio hooks install) and start one.'));
  if (offBoard) rail.appendChild(h('button', { class: 'rail-hidden', title: `Their cards are hidden by the “${FOCUS_MODES[state.focus].label.toLowerCase()}” filter — click to show everything.`, onclick: () => setFocus('all') },
    `${offBoard} on hidden card${offBoard === 1 ? '' : 's'}`));
  // Both lists leave rows out -- Unattached the ones you hid, Needs you the ones you snoozed --
  // but never silently. The count sits under the list and puts them back on screen with one
  // click, so the whole list is always one click away; from there each row can come back, or
  // all of them at once.
  if (tucked && ['unattached', 'attention'].includes(state.railFilter)) {
    const zz = state.railFilter === 'attention';
    rail.appendChild(h('button', { class: 'rail-hidden', onclick: () => { state.showHidden = !state.showHidden; $('#rail').scrollTop = 0; renderRail(); },
      title: state.showHidden ? (zz ? 'Back to the sessions that are actually waiting on you.' : 'Back to the sessions you have not hidden.')
        : zz ? 'Needing you, and snoozed by you: this list leaves them out so the ones you have not seen stand alone. Click to list them here too.'
          : 'On no card, and you hid them: this list leaves them out. Click to list them here too — nothing was deleted.' },
      state.showHidden ? `${zz ? 'quiet' : 'hide'} the ${tucked} again` : `${tucked} ${zz ? 'snoozed' : 'hidden'} · show ${tucked === 1 ? 'it' : 'them'}`));
  }
  // The spare is Claude Code's next background session, started ahead of time: no prompt,
  // no title, nothing to open or attach. It used to sit under Ready as “Untitled”. Say it
  // exists, without giving it a row -- it gets one the moment a job claims it.
  const spares = SPARES.standing_by;
  if (spares && state.railFilter !== 'attention') rail.appendChild(h('div', { class: 'rail-spare', title: 'Claude Code keeps the next background session started ahead of time so a new job opens at once. Nothing has prompted it yet, so there is nothing to open or attach; it joins the list as a normal session the moment a job claims it.' },
    h('i', { class: 'dot spare' }), `${spares} spare session${spares === 1 ? '' : 's'} standing by for the next job`));
}
function fitTitle(el) { if (!el.isConnected) return; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
// The title textarea while it is being typed in, if it belongs to this card: the text so far and where
// the caret is. renderInspector rebuilds the panel from scratch, and a redraw can land mid-word -- the
// detail read arrives a few ms after a new card is selected and its title focused, and until this the
// fresh textarea took the place of the focused one, dropping the focus and anything typed. That is why
// "type the title right away" did not work: the caret was there, then gone.
function titleUnderEdit(ins, id) {
  const t = ins.querySelector('.ins-title textarea');
  return t && document.activeElement === t && ins.dataset.card === id ? { value: t.value, start: t.selectionStart, end: t.selectionEnd, dir: t.selectionDirection } : null;
}
function restoreTitleEdit(t, keep) { t.value = keep.value; fitTitle(t); t.focus({ preventScroll: true }); t.setSelectionRange(keep.start, keep.end, keep.dir); }
function renderInspector() {
  const ins = $('#inspector'); const c = state.selected && cardById(state.selected);
  if (!c) { ins.classList.remove('open'); ins.dataset.card = ''; insShown = null; return; }
  const d = state.detail && state.detail.id === c.id ? state.detail : null;
  const typing = titleUnderEdit(ins, c.id);
  const restoreScroll = keepScroll(ins, c.id);
  ins.classList.add('open'); ins.innerHTML = ''; ins.dataset.card = c.id;
  const lc = lifecycle(c), kids = kidsOf(c.id), sess = sessOf(c.id), ag = attn(c.id), area = areaOf(c.id);
  const path = h('div', { class: 'ins-path' }, h('b', {}, area ? area.name : c.area));
  ancestors(c.id).forEach(pid => { path.append(h('span', { class: 'crumb-sep' }, '›'), h('button', { class: 'crumb', style: 'padding:0 2px', 'data-act': 'reveal', 'data-id': pid }, cardById(pid).name)); });
  const acts = h('span', { class: 'ins-acts' }, h('button', { class: 'mini ico', 'data-act': 'copy-brief', title: COPY_TIP }, copyIcon(), 'Copy for Claude'));
  if (c.parent) acts.appendChild(h('button', { class: 'mini', 'data-act': 'move-out', title: 'Make it a sibling of its parent' }, '↑ Move out'));
  path.appendChild(acts);
  const title = h('textarea', { value: c.name, rows: 1, 'data-act': 'rename', 'aria-label': 'Card name', oninput: e => fitTitle(e.target) });
  ins.appendChild(h('div', { class: 'ins-head' }, path, h('div', { class: 'ins-title' }, h('i', { class: `glyph ${lc}` }), title),
    h('button', { class: 'ins-close', 'data-act': 'close', title: 'Close (Esc)' }, '×')));
  fitTitle(title); document.fonts.ready.then(() => fitTitle(title));
  if (typing) restoreTitleEdit(title, typing);
  const body = h('div', { class: 'ins-body' });
  // state
  const st = h('div', { class: 'sec' }, h('h3', {}, 'State'),
    h('div', { class: 'state-line' }, h('i', { class: `glyph ${lc}` }), h('b', {}, lc[0].toUpperCase() + lc.slice(1)), h('span', { class: 'why' }, `— ${lifecycleWhy(c)}`)));
  st.appendChild(h('div', { class: 'seg' },
    h('button', { class: c.human === 'done' ? 'on' : '', 'data-act': 'toggle-done' }, h('i', { class: 'glyph done' }), c.human === 'done' ? 'Done ✓' : 'Mark done'),
    h('button', { class: c.human === 'parked' ? 'on' : '', 'data-act': 'toggle-park' }, h('i', { class: 'glyph parked' }), c.human === 'parked' ? 'Parked' : 'Park')));
  if (c.human === 'parked') st.appendChild(h('input', { class: 'park-note', 'data-act': 'park-note', value: c.parkNote, placeholder: 'why / until when (optional)', 'aria-label': 'Park note' }));
  if (!c.human && kids.length && kids.every(k => lifecycle(k) === 'done')) st.appendChild(h('div', { class: 'state-line', style: 'margin-top:8px;color:var(--muted);font-size:12px' }, 'Every child is done — mark this done?'));
  if (ag.needs) st.appendChild(h('div', { class: 'attn-call' }, h('i', { class: 'dot needs_you' }), h('span', {}, h('b', {}, ag.needs === 1 ? '1 session' : `${ag.needs} sessions`), ag.descNeeds ? ` need${ag.needs === 1 ? 's' : ''} you (inside)` : ` need${ag.needs === 1 ? 's' : ''} you`),
    h('button', { class: 'zz', 'data-act': 'snooze', title: SNOOZE_TIP, 'aria-label': 'Snooze' }, moonIcon()), h('button', { 'data-act': 'resume-first' }, 'Open')));
  else if (ag.snoozed) {
    const zzz = attnSessions(c.id, snoozed, true);
    st.appendChild(h('div', { class: 'attn-call quiet' }, h('i', { class: 'dot needs_you snoozed' }),
      h('span', {}, h('b', {}, ag.snoozed === 1 ? '1 session' : `${ag.snoozed} sessions`), ` still need${ag.snoozed === 1 ? 's' : ''} you — snoozed, back in ${snoozeText(zzz)}`),
      h('button', { 'data-act': 'wake' }, 'Wake')));
  }
  body.appendChild(st);
  // sessions
  const ss = h('div', { class: 'sec' }, h('h3', {}, 'Sessions', h('span', { class: 'n' }, String(sess.length)), h('button', { class: 'act', 'data-act': 'attach-hint' }, 'Attach…')));
  if (!sess.length) ss.appendChild(h('div', { class: 'muted', style: 'font-size:12px' }, 'None yet. Drag one from the rail, or start Claude in this card’s worktree and attach it here. A session can sit on several cards at once.'));
  for (const s of sess) {
    const also = otherCardsOf(s, c.id); // the same session, on other cards too
    const row = h('div', { class: 'ins-sess' }, h('i', { class: `dot ${s.state}` }),
      h('div', { style: 'min-width:0' }, h('div', { class: 't' }, h('button', { class: 'link', 'data-act': 'rename-session', 'data-sid': s.id, title: (s.title ? 'Click to rename' : 'Named by Claude Code — click to rename') + (also.length ? ' — the name follows the session onto every card it is on' : '') }, sessTitle(s))),
        s.prompt ? h('div', { class: 'p', title: s.prompt }, s.prompt) : '',
        h('div', { class: 'm' }, h('span', {}, (STATE_LABEL[s.state] || s.state) + (s.attention ? ' · ' + s.attention : '') + (snoozed(s) ? ` · snoozed ${snoozeText(s)}` : '')), s.branch ? h('span', { class: 'mono' }, s.branch) : '', h('span', { class: 'mono', title: s.id }, s.short), h('span', { title: agoTip(s) }, agoText(s.updated))),
        also.length ? h('div', { class: 'also' }, 'also on ', ...also.flatMap((o, i) => [i ? ', ' : '', h('button', { class: 'link', 'data-act': 'reveal', 'data-id': o.id, title: `Go to “${o.name}”` }, o.name)])) : ''),
      h('div', { class: 'acts' }, h('button', { class: `mini ${needy(s) ? 'primary' : ''}`, 'data-act': 'resume', 'data-sid': s.id }, s.resume && s.resume.kind === 'attach' ? 'Attach' : (['ended', 'inactive', 'unknown'].includes(s.state) ? 'Resume' : 'Open')),
        s.state === 'needs_you' ? h('button', { class: 'mini ico zz', 'data-act': snoozed(s) ? 'wake-one' : 'snooze-one', 'data-sid': s.id, title: snoozed(s) ? `Snoozed — quiet for another ${snoozeText(s)}. Click to bring it back now.` : SNOOZE_TIP, 'aria-label': snoozed(s) ? 'Wake' : 'Snooze' }, moonIcon(), snoozed(s) ? snoozeText(s) : '') : '',
        h('button', { class: 'mini', 'data-act': 'detach', 'data-sid': s.id, title: `Detach from this card (the Claude session itself is untouched${also.length ? `, and it stays on ${quoteNames(also)}` : ''})` }, '×')));
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
  const shownKids = visKidsOf(c.id), hiddenKids = kids.length - shownKids.length; // the list obeys the filter, like the canvas and the rail
  const ks = h('div', { class: 'sec' }, h('h3', {}, 'Children', h('span', { class: 'n' }, hiddenKids ? `${shownKids.length}/${kids.length}` : String(kids.length)), shownKids.length ? h('button', { class: 'act', 'data-act': 'toggle-kids' }, collapsed.has(c.id) ? 'Expand' : 'Collapse') : ''));
  for (const k of shownKids) { const ka = attn(k.id); ks.appendChild(h('button', { class: 'ins-kid', style: 'width:100%;text-align:left', 'data-act': 'reveal', 'data-id': k.id }, h('i', { class: `glyph ${lifecycle(k)}` }), h('span', {}, k.name), h('span', { class: 'st' }, ka.needs ? h('i', { class: 'dot needs_you' }) : ka.working ? h('i', { class: 'dot working' }) : lifecycle(k)), h('span', { class: 'arrow' }, '›'))); }
  if (hiddenKids) ks.appendChild(h('button', { class: 'ins-hidden', 'data-act': 'show-all', title: `Hidden by the “${FOCUS_MODES[state.focus].label.toLowerCase()}” filter — click to show everything.` }, `${hiddenKids} hidden by the filter`));
  ks.appendChild(h('form', { class: 'ins-add', 'data-act': 'add-kid-form' }, h('input', { placeholder: 'New child idea…', 'aria-label': 'New child idea' }), h('button', { class: 'mini', type: 'submit' }, 'Add')));
  body.appendChild(ks);
  // AI state
  if (d && d.ai_state) body.appendChild(h('div', { class: 'sec ai' }, h('h3', {}, 'AI state', h('span', { class: 'muted', style: 'font-weight:400;letter-spacing:0;text-transform:none' }, 'from the `## AI state` section')), h('div', { class: 'notes-view', html: d.ai_state_html })));
  // notes
  if (d) { const ed = noteEditorFor(c, d); body.appendChild(h('div', { class: 'sec' }, h('h3', {}, 'Notes', ed.status, ed.modeBtn), ed.el)); }
  else body.appendChild(h('div', { class: 'sec' }, h('h3', {}, 'Notes'), h('div', { class: 'muted', style: 'font-size:12px' }, 'Loading…')));
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
  restoreScroll();
}

/* The poll redraws this panel every few seconds, and a redraw used to start at the top:
   the body is a new element, and the notes box -- the same node, kept by noteEditorFor --
   loses its scroll position while it is out of the document. Reading a long note, you
   were thrown back to its first line on every refresh. So a redraw of the card you
   already have open remembers where the body, and anything scrolled inside it, was and
   puts it back once rebuilt. Opening another card still starts at the top. */
let insShown = null;   // the card the inspector last drew
function keepScroll(ins, id) {
  const same = insShown === id; insShown = id;
  if (!same) return () => { };
  const body = $('.ins-body', ins), top = body ? body.scrollTop : 0;
  const inner = $$('*', ins).filter(e => e !== body && e.scrollTop > 0).map(e => [e, e.scrollTop]);
  return () => {
    const nb = $('.ins-body', ins);
    if (nb && top) nb.scrollTop = top;
    for (const [e, t] of inner) if (e.isConnected) e.scrollTop = t;   // the notes box came back; a node that did not is left alone
  };
}

// ------------------------------------------------------------------ notes editor
/* One editor instance per open card, kept across inspector re-renders so the poll
   cannot pull the text out from under you mid-sentence. It saves itself (debounced,
   on blur, on ⌘S) rather than going through mutate(), which would re-render the
   panel -- and blur the box -- on every pause in typing. */
let noteEd = null;
function noteEditorFor(c, d) {
  if (noteEd && noteEd.id === c.id) { noteEd.ed.setRemote(d.notes || ''); return noteEd.ed; }
  closeNoteEditor(c.id);
  const ed = NoteEditor.create({
    value: d.notes || '',
    placeholder: 'Write. “- ” makes a bullet, Tab nests it. Saved as Markdown in the Notes section of the file.',
    save: async text => {
      await api('PATCH', `/api/items/${encodeURIComponent(c.id)}`, { notes: text });
      if (state.detail && state.detail.id === c.id) state.detail.notes = text;   // keep the next re-render in sync
    },
    onError: toastError,
  });
  noteEd = { id: c.id, ed };
  return ed;
}
function closeNoteEditor(keepId) { if (noteEd && noteEd.id !== keepId) { noteEd.ed.destroy(); noteEd = null; } }
// a closed tab must not eat an unsaved note
window.addEventListener('pagehide', () => {
  if (!noteEd || !noteEd.ed.isDirty()) return;
  fetch(`/api/items/${encodeURIComponent(noteEd.id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: noteEd.ed.value() }), keepalive: true,
  });
});

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
function select(id) { closeNoteEditor(id); if (state.selected !== id) { state.detail = null; state.resumeOpen = null; } state.selected = id; render(); if (id) loadDetail(id); location.hash = id ? `card=${id}` : ''; }
function reveal(id, flash = true) {
  let opened = false; ancestors(id).forEach(pid => { if (collapsed.has(pid)) { collapsed.delete(pid); opened = true; } });
  select(id);
  if (opened) { persist(); ancestors(id).forEach(pid => { const k = $(`.card[data-id="${pid}"] > .kids`); if (k) k.classList.add('opening'); }); }
  ensureVisible(cardRect(id), 56); if (flash) flashCard(id);
}
const foldLineOf = id => $(`.card[data-id="${id}"] > .kids > div > .kids-list > .fold`);
function toggleFold(id) {
  const line = foldLineOf(id), was = line ? line.getBoundingClientRect().top : null;
  if (unfolded.has(id)) unfolded.delete(id); else unfolded.add(id);
  persist(); render();
  // folding pulls the line up by everything that left; keep it where the click landed instead of
  // leaving the pointer over empty canvas. Opening adds cards below the line, so it stays put on its own.
  if (was !== null && !unfolded.has(id)) { const now = foldLineOf(id); if (now) { const d = now.getBoundingClientRect().top - was; if (d) setCam(state.cam.x, state.cam.y - d, state.cam.s, false); } }
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
// A session may sit on several cards. Attaching adds it to one more; `from` names a card
// to leave at the same time (a move), which the server does in the one request.
const attachApi = (item, s, from) => api('POST', `/api/items/${encodeURIComponent(item)}/sessions`, { session_id: s.id, title: s.title || '', ...(from ? { from } : {}) });
const detachApi = (item, sid) => api('DELETE', `/api/items/${encodeURIComponent(item)}/sessions/${encodeURIComponent(sid)}`);
const nameOf = id => (cardById(id) || {}).name || 'its card';
function attachSession(s, target, from = null) {
  const tgt = cardById(target), also = otherCardsOf(s, target);
  let msg;
  if (from) msg = `Moved “${sessTitle(s)}” from “${nameOf(from)}” to “${tgt.name}”`;
  else if (also.length) msg = `Attached “${sessTitle(s)}” to “${tgt.name}” — it’s on ${quoteNames(also)} too`;
  else msg = `Attached “${sessTitle(s)}” to “${tgt.name}” — it’s now active`;
  return mutate(() => attachApi(target, s, from), {
    msg,
    undo: () => from ? attachApi(from, s, target) : detachApi(target, s.id),
  }).then(() => flashCard(target));
}
// Detach from one card (`from`: the chip you dragged, the × in the inspector), or -- a rail
// row dragged off the board -- from every card it is on, so it is back to unattached.
function detachSession(s, from = null) {
  if (from) {
    const left = otherCardsOf(s, from);
    const tail = left.length ? ` — still on ${quoteNames(left)}` : ' — it’s back in the rail';
    return mutate(() => detachApi(from, s.id), { msg: `Detached “${sessTitle(s)}” from “${nameOf(from)}”${tail}`, undo: () => attachApi(from, s) });
  }
  const ids = s.items.slice(); if (!ids.length) return Promise.resolve();
  const what = ids.length === 1 ? `“${nameOf(ids[0])}”` : `${ids.length} cards`;
  return mutate(() => Promise.all(ids.map(id => detachApi(id, s.id))), { msg: `Detached “${sessTitle(s)}” from ${what} — it’s back in the rail`, undo: () => Promise.all(ids.map(id => attachApi(id, s))) });
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
    // straight into the title, placeholder selected, so the first keystroke replaces it. select() also
    // started the detail read; when it lands, renderInspector carries this focus over (see titleUnderEdit).
    requestAnimationFrame(() => { const i = $('.ins-title textarea'); if (i) { i.focus({ preventScroll: true }); i.select(); } });
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
  if (chip) { const on = chip.closest('.card'); beginSessDrag(e, chip.dataset.sid, chip, on ? on.dataset.id : null); stage.setPointerCapture(e.pointerId); return; }
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
stage.addEventListener('dblclick', e => { if (e.target.closest('button')) return; const card = e.target.closest('.card'); if (card && kidsOf(card.dataset.id).length) toggleCollapse(card.dataset.id); });
stage.addEventListener('wheel', e => {
  // the inspector sits inside the stage, so its wheel events bubble here. It scrolls itself.
  if (e.target.closest('.inspector')) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { const r = stage.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0035)); }
  else setCam(state.cam.x - e.deltaX, state.cam.y - e.deltaY, state.cam.s, false);
}, { passive: false });

// sessions: drag a rail row or a chip on a card. A rail row onto a card *attaches* -- the
// session keeps every card it already has, this is how it gets onto several. A chip is the
// session's place on one card, so a chip onto another card *moves* it from this card to that
// one. Empty canvas or the rail detaches: a chip from its card, a rail row from all of them.
function sessDropTarget(s, from, hitId, over) {
  if (hitId && !s.items.includes(hitId)) return { kind: 'card', id: hitId, label: `${from ? 'Move' : 'Attach'} to “${nameOf(hitId)}”` };
  if (hitId) return null; // a card it is already on
  if (!(over.rail || (over.stage && !over.chrome))) return null;
  if (from) return { kind: 'detach', id: from, label: `Release to detach from “${nameOf(from)}”` };
  if (!s.items.length) return null;
  return { kind: 'detach', id: null, label: `Release to detach from ${s.items.length === 1 ? `“${nameOf(s.items[0])}”` : `all ${s.items.length} cards`}` };
}
const rail = $('#rail'); let sdrag = null;
function beginSessDrag(e, sid, srcEl, from = null) {
  const where = e.target.closest ? e.target.closest('.where[data-id]') : null; // a card chip inside a rail row: a click goes to that card
  sdrag = { sid, srcEl, from, goto: where ? where.dataset.id : null, sx: e.clientX, sy: e.clientY, moved: false, ghost: null, target: null };
}
function moveSessDrag(e) {
  const d = sdrag, dx = e.clientX - d.sx, dy = e.clientY - d.sy, s = sessById(d.sid); if (!s) return;
  if (!d.moved) { if (Math.hypot(dx, dy) < 5) return; d.moved = true; d.srcEl.classList.add('dragging'); stage.classList.add('sess-drag');
    d.ghost = h('div', { class: 'sess sghost ' + s.state }, h('i', { class: 'dot ' + s.state }), sessTitle(s)); document.body.appendChild(d.ghost); }
  d.ghost.style.left = e.clientX + 'px'; d.ghost.style.top = e.clientY + 'px';
  clearDropTargets(); $('.rail').classList.remove('droptarget'); d.ghost.classList.remove('detaching'); d.target = null;
  const els = document.elementsFromPoint(e.clientX, e.clientY), hit = hitAt(e.clientX, e.clientY);
  const over = { rail: els.some(x => x.classList && x.classList.contains('rail')), stage: els.some(x => x.id === 'stage'), chrome: els.some(x => x.classList && (x.classList.contains('inspector') || x.classList.contains('zoomctl') || x.classList.contains('legend'))) };
  const t = sessDropTarget(s, d.from, hit.card ? hit.card.dataset.id : null, over); d.target = t;
  if (!t) return;
  if (t.kind === 'card') mark(hit.card, t.label);
  else { d.ghost.classList.add('detaching'); if (over.rail) $('.rail').classList.add('droptarget'); hint(t.label); }
}
function endSessDrag(e) {
  if (!sdrag) return; const d = sdrag; sdrag = null;
  d.srcEl.classList.remove('dragging'); stage.classList.remove('sess-drag'); if (d.ghost) d.ghost.remove(); clearDropTargets(); $('.rail').classList.remove('droptarget');
  const s = sessById(d.sid); if (!s) return;
  if (!d.moved) {
    if (d.srcEl.classList.contains('srow')) { if (s.items.length) reveal(d.goto && s.items.includes(d.goto) ? d.goto : s.items[0]); else { d.srcEl.classList.add('flash'); hint('Unattached — drag it onto a card, or hide it to clear it from this list'); } }
    else if (d.from) select(d.from);
    return;
  }
  const t = d.target; if (!t) return;
  if (t.kind === 'card') attachSession(s, t.id, d.from);
  if (t.kind === 'detach') detachSession(s, t.id);
}
// A button inside a row (hide, unhide) is a button, not a drag handle: leave it alone,
// capture nothing, and let the click through.
rail.addEventListener('pointerdown', e => { const row = e.target.closest('.srow'); if (!row || e.button !== 0 || e.target.closest('button')) return; beginSessDrag(e, row.dataset.sid, row); row.setPointerCapture(e.pointerId); });
rail.addEventListener('pointermove', e => { if (sdrag) moveSessDrag(e); });
rail.addEventListener('pointerup', endSessDrag); rail.addEventListener('pointercancel', endSessDrag);
$$('.rail-filters .chip-btn[data-f]').forEach(b => b.addEventListener('click', () => { state.railFilter = b.dataset.f; $$('.rail-filters .chip-btn[data-f]').forEach(x => x.classList.toggle('on', x === b)); renderRail(); }));
$('#allRepos').addEventListener('change', e => { state.allRepos = e.target.checked; refresh(); });

// ------------------------------------------------------------------ area menu + type-to-confirm
// Deleting an Area is the one action folio cannot take back: the server rmtree's the
// directory and every Markdown file under it, and there is no undo to offer. So it is
// not a button sitting in the header any more. It hides in a menu, under a harmless
// first item, behind a dialog that stays inert until you type the Area's name back.
let popKey = null, popEl = null, popBtn = null;
function closePop() {
  if (!popEl) return;
  popEl.remove(); popEl = null; popKey = null;
  if (popBtn) popBtn.classList.remove('open');
  popBtn = null;
  document.removeEventListener('pointerdown', onPopOut, true);
  document.removeEventListener('keydown', onPopKey, true);
  window.removeEventListener('wheel', closePop, true);
  window.removeEventListener('resize', closePop);
  $$('.area-menu.open, .zz.open').forEach(b => b.classList.remove('open'));  // a redraw can have replaced the button
}
const onPopOut = e => { if (popEl && !popEl.contains(e.target)) closePop(); };
const onPopKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); } };
// One menu at a time, hung under the button that opened it, and that button toggles it shut.
// `key` is what "the same menu" means: the Area, or the exact set of sessions being snoozed.
function openMenu(btn, key, items) {
  if (popKey === key) { closePop(); return; }
  closePop();
  popKey = key; popBtn = btn; btn.classList.add('open');
  popEl = h('div', { class: 'pop', role: 'menu' }, ...items);
  document.body.appendChild(popEl);
  const r = btn.getBoundingClientRect(), m = popEl.getBoundingClientRect();
  popEl.style.left = Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8)) + 'px';
  popEl.style.top = (r.bottom + 6 + m.height > window.innerHeight ? Math.max(8, r.top - 6 - m.height) : r.bottom + 6) + 'px';
  document.addEventListener('pointerdown', onPopOut, true);
  document.addEventListener('keydown', onPopKey, true);
  window.addEventListener('wheel', closePop, true);
  window.addEventListener('resize', closePop);
}
function openAreaMenu(btn, area) {
  openMenu(btn, `area:${area.id}`, [
    h('button', { class: 'pop-i', role: 'menuitem', onclick: () => { closePop(); newCard({ area: area.id }); } }, `New idea in ${area.name}`),
    h('i', { class: 'pop-sep' }),
    h('button', { class: 'pop-i harm', role: 'menuitem', onclick: () => { closePop(); deleteArea(area); } }, 'Delete this Area…'),
  ]);
}
// How long to stay quiet. The three lengths are the shape of the answer to "not now": the rest of
// this train of thought, the rest of the afternoon, tomorrow. The note is there because silencing
// something that needs you should never feel like dismissing it.
function openSnoozeMenu(btn, ss) {
  if (!ss.length) return;
  openMenu(btn, `snooze:${ss.map(s => s.id).sort().join(',')}`, [
    h('div', { class: 'pop-h' }, ss.length === 1 ? `Quiet “${sessTitle(ss[0])}” for…` : `Quiet ${ss.length} sessions for…`),
    ...SNOOZE_OPTS.map(([label, mins]) => h('button', { class: 'pop-i', role: 'menuitem', onclick: () => { closePop(); snoozeSessions(ss, mins); } }, label)),
    h('i', { class: 'pop-sep' }),
    h('div', { class: 'pop-n' }, 'It still needs you and stays in the list. Anything new from the session ends the quiet at once.'),
  ]);
}

// What deleting an Area actually costs, counted from the tree the canvas already has.
// Cards filed elsewhere whose parent lived here survive -- the server clears their
// parent -- so they are named separately from the ones that are destroyed.
function areaDamage(a) {
  const gone = CARDS.filter(c => c.area === a.id), goneIds = new Set(gone.map(c => c.id));
  const orphaned = CARDS.filter(c => c.area !== a.id && c.parent && goneIds.has(c.parent));
  return { cards: gone.length, orphaned: orphaned.length, dir: `${(OV && OV.data_dir) || '~'}/items/${a.name}` };
}
function deleteArea(area) {
  const d = areaDamage(area), n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  typeToConfirm({
    title: `Delete the Area “${area.name}”?`,
    damage: [
      d.cards ? `${n(d.cards, 'card', 'cards')} filed here — and every Markdown file behind ${d.cards === 1 ? 'it' : 'them'} — will be deleted.` : 'No cards are filed here.',
      d.orphaned ? `${n(d.orphaned, 'card', 'cards')} in other Areas will lose ${d.orphaned === 1 ? 'its parent' : 'their parent'} and move to the top level.` : null,
      h('span', { class: 'path' }, d.dir),
    ].filter(Boolean),
    note: 'Nothing here can be undone — folio has no trash, and the Undo toast cannot bring an Area back.',
    phrase: area.name,
    label: 'Delete this Area',
  }).then(ok => {
    if (ok) mutate(() => api('DELETE', `/api/areas/${encodeURIComponent(area.name)}`), { msg: `Deleted area ${area.name}` });
  });
}

// The gate itself: the typed text must be the phrase, exactly. Surrounding whitespace is
// forgiven (it is invisible, and a paste often carries it); nothing else is -- wrong case
// or a near miss keeps the button dead, which is the whole point of asking.
const confirmMatches = (typed, phrase) => typed.trim() === phrase.trim() && phrase.trim() !== '';
function typeToConfirm({ title, damage, note, phrase, label }) {
  return new Promise(resolve => {
    const prev = document.activeElement;
    const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: phrase, 'aria-label': `Type ${phrase} to confirm` });
    const go = h('button', { class: 'go', type: 'submit', disabled: true, title: `Type “${phrase}” above to arm this` }, label);
    const cancel = h('button', { class: 'cancel', type: 'button' }, 'Cancel');
    const armed = () => confirmMatches(input.value, phrase);
    input.addEventListener('input', () => { const ok = armed(); go.disabled = !ok; go.classList.toggle('armed', ok); });
    const dlg = h('form', { class: 'dlg', role: 'dialog', 'aria-modal': 'true' },
      h('h3', {}, title),
      h('div', { class: 'dlg-damage' }, ...damage.map(d => h('div', {}, d))),
      note ? h('p', { class: 'dlg-note' }, note) : null,
      h('label', { class: 'dlg-type' }, h('span', {}, 'Type ', h('b', {}, phrase), ' to confirm'), input),
      h('div', { class: 'dlg-acts' }, cancel, go));
    const scrim = h('div', { class: 'scrim' }, dlg);
    const close = ok => { document.removeEventListener('keydown', onKey, true); scrim.remove(); if (prev && prev.focus) prev.focus(); resolve(ok); };
    dlg.addEventListener('submit', e => { e.preventDefault(); if (armed()) close(true); });   // Enter only lands when the name matches
    cancel.addEventListener('click', () => close(false));
    scrim.addEventListener('pointerdown', e => { if (e.target === scrim) close(false); });
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
      if (e.key !== 'Tab') return;                                        // focus stays in the dialog
      const f = [...dlg.querySelectorAll('input, button:not([disabled])')];
      if (!f.length) return;
      const edge = e.shiftKey ? f[0] : f[f.length - 1];
      if (document.activeElement === edge) { e.preventDefault(); (e.shiftKey ? f[f.length - 1] : f[0]).focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    requestAnimationFrame(() => { scrim.classList.add('show'); input.focus(); });
  });
}

// ------------------------------------------------------------------ clicks: canvas buttons, inspector
stage.addEventListener('click', e => {
  const act = e.target.closest('[data-act]'); if (!act || e.target.closest('.inspector')) return;
  const a = act.dataset.act;
  if (a === 'toggle') toggleCollapse(act.closest('.card').dataset.id);
  if (a === 'fold') toggleFold(act.closest('.card').dataset.id);
  if (a === 'add-to-area') newCard({ area: act.closest('.area').dataset.area });
  if (a === 'add-child') newCard({ parent: act.closest('.card').dataset.id });
  if (a === 'area-menu') openAreaMenu(act, areaById(act.closest('.area').dataset.area));
  if (a === 'copy-brief') copyBrief(cardById(act.closest('.card').dataset.id));
  if (a === 'snooze') openSnoozeMenu(act, attnSessions(act.closest('.card').dataset.id, needy));
  if (a === 'wake') snoozeSessions(attnSessions(act.closest('.card').dataset.id, snoozed), 0);
});
$('#inspector').addEventListener('click', e => {
  const act = e.target.closest('[data-act]'); if (!act) return; const a = act.dataset.act, c = cardById(state.selected); if (!c) return;
  if (a === 'close') select(null);
  if (a === 'copy-brief') copyBrief(c);
  if (a === 'toggle-done') setStatus(c, c.human === 'done' ? 'open' : 'done');
  if (a === 'toggle-park') setStatus(c, c.human === 'parked' ? 'open' : 'parked');
  if (a === 'detach') { const s = sessById(act.dataset.sid); if (s) detachSession(s, c.id); }
  // The card's own pair covers everything under it -- the panel counts what is inside as well --
  // while a session row snoozes just that one.
  if (a === 'snooze') openSnoozeMenu(act, attnSessions(c.id, needy, true));
  if (a === 'wake') snoozeSessions(attnSessions(c.id, snoozed, true), 0);
  if (a === 'snooze-one') { const s = sessById(act.dataset.sid); if (s) openSnoozeMenu(act, [s]); }
  if (a === 'wake-one') { const s = sessById(act.dataset.sid); if (s) snoozeSessions([s], 0); }
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
  if (a === 'show-all') setFocus('all');
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
  if (a === 'rename') { const name = e.target.value.replace(/\s+/g, ' ').trim(); if (name && name !== c.name) mutate(() => api('PATCH', `/api/items/${encodeURIComponent(c.id)}`, { name }), {}); else { e.target.value = c.name; fitTitle(e.target); } }
  if (a === 'park-note' && e.target.value.trim() !== c.parkNote) {
    const note = e.target.value.trim();
    mutate(() => api('PATCH', `/api/items/${encodeURIComponent(c.id)}`, { status: 'parked', park_note: note }), { msg: note ? 'Park note saved' : 'Park note cleared' });
  }
});
$('#inspector').addEventListener('keydown', e => { if (e.target.dataset.act === 'rename' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } if (e.key === 'Escape') e.target.blur(); });
// A paste into the title lands as one line with nothing after it. What you copy usually ends in a
// newline -- a line from a terminal, a heading from a doc -- and pasted as-is it opened a blank second
// row under the title, with the caret sitting on it, until the blur trimmed the name. So the pasted
// text is folded onto one line, its trailing whitespace dropped, and its leading run too when it lands
// at the very start (no title begins with a space). Inserted through execCommand so ⌘Z still takes
// the paste back; a browser without it gets the plain replacement.
function titlePaste(text, atStart) { const t = text.replace(/\s+/g, ' ').trimEnd(); return atStart ? t.trimStart() : t; }
$('#inspector').addEventListener('paste', e => {
  const t = e.target; if (t.dataset.act !== 'rename' || !e.clipboardData) return;
  const text = titlePaste(e.clipboardData.getData('text/plain'), t.selectionStart === 0);
  e.preventDefault();
  if (!text && t.selectionStart === t.selectionEnd) return;   // nothing but whitespace, and nothing selected to replace: no-op
  if (text ? document.execCommand('insertText', false, text) : document.execCommand('delete')) return;
  t.setRangeText(text, t.selectionStart, t.selectionEnd, 'end'); t.dispatchEvent(new Event('input', { bubbles: true }));
});
$('#inspector').addEventListener('submit', e => {
  e.preventDefault(); const c = cardById(state.selected); if (!c) return;
  if (e.target.dataset.act === 'add-kid-form') { const name = e.target.querySelector('input').value.trim(); if (!name) return; mutate(() => api('POST', '/api/items', { name, parent: c.id }), { msg: `Added “${name}” inside “${c.name}”` }).then(() => collapsed.delete(c.id)); }
  if (e.target.dataset.act === 'add-ctx-form' && state.detail) {
    const [t, r] = e.target.querySelectorAll('input'); if (!r.value.trim()) { toast('A URL or path is required', null, { error: true }); return; }
    mutate(() => api('PATCH', `/api/items/${encodeURIComponent(c.id)}`, { context: [...state.detail.context, { title: t.value.trim() || r.value.trim(), ref: r.value.trim() }] }), { msg: 'Added context ref' });
  }
});

// ------------------------------------------------------------------ top bar / zoom / keys / boot
function setFocus(mode, announce = true) {
  if (!FOCUS_MODES[mode] || mode === state.focus) return;
  state.focus = mode; persist(); render();
  const hid = hiddenCount();
  if (announce) hint(`${FOCUS_MODES[mode].label}${hid ? ` — ${hid} card${hid === 1 ? '' : 's'} out of sight` : ''}`);
}
$('#focus').addEventListener('click', e => { const b = e.target.closest('button[data-focus]'); if (b) setFocus(b.dataset.focus); });
$('#focusCount').addEventListener('click', () => setFocus('all'));
$('#attnPill').addEventListener('click', jumpNext);
$('#collapseAll').addEventListener('click', () => { const ps = parents(); const all = ps.every(p => collapsed.has(p.id)); ps.forEach(p => all ? collapsed.delete(p.id) : collapsed.add(p.id)); persist(); render(); if (all) $$('.kids').forEach(k => k.classList.add('opening')); });
$('#newIdeaBtn').addEventListener('click', () => { const inbox = AREAS.find(a => a.name.toLowerCase() === 'inbox') || AREAS[0]; if (!inbox) { toast('Create an Area first (+ Area)', null, { error: true }); return; } newCard({ area: inbox.id }); });
$('#newAreaBtn').addEventListener('click', () => { const name = window.prompt('New Area name (becomes a directory)', ''); if (!name || !name.trim()) return; mutate(() => api('POST', '/api/areas', { name: name.trim() }), { msg: `Created area ${name.trim()}` }); });
$('#zoomIn').addEventListener('click', () => zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.25));
$('#zoomOut').addEventListener('click', () => zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, .8));
$('#zoomFit').addEventListener('click', () => fitRect(workspaceRect(), 40));
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea') || e.target.isContentEditable) return;   // never steal a keystroke from a field
  if (e.key === 'Escape') { if (state.selected) select(null); }
  if (e.key === 'j' || e.key === 'J') jumpNext();
  if (e.key === 'h' || e.key === 'H') setFocus(FOCUS_ORDER[(FOCUS_ORDER.indexOf(state.focus) + 1) % FOCUS_ORDER.length]);
  if (e.key === 'f' || e.key === 'F') $('#zoomFit').click();
  if (e.key === 'n' || e.key === 'N') $('#newIdeaBtn').click();
  if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey) { if (state.selected) copyBrief(cardById(state.selected)); else hint('Open a card first, then press C to copy it for Claude'); }
  if (e.key === '=' || e.key === '+') $('#zoomIn').click();
  if (e.key === '-') $('#zoomOut').click();
});
window.addEventListener('resize', () => applyCam(false));
window.addEventListener('hashchange', () => { const id = hashCard(); if (id && cardById(id) && id !== state.selected) reveal(id); });
function hashCard() { const hsh = location.hash.slice(1); const m = hsh.match(/^card=(.+)$/) || hsh.match(/^\/item\/(.+)$/); return m ? decodeURIComponent(m[1]) : null; }

(async function boot() {
  restore();
  await poll();  // a server that is down at boot is reported in the indicator, not fatal: the ticker keeps trying and the page fills in when it answers
  setInterval(tick, 1000);  // one ticker: it advances the "checked … ago" label every second and polls whenever a read is due and safe
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNow(); });
  window.addEventListener('focus', pollNow);
  $('#fresh').addEventListener('click', () => { if (inFlight === 0) poll(); });  // a click asks outright: menus have already closed on pointerdown, and the button now has focus, so nothing is under edit
})();
