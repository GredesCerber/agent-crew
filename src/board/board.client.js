// crew board page script. Globals from the page: TOKEN, REPO, COLS, ST (statuses a person may set), PR (priorities).
// Every change goes through POST /api/action, which validates it again on the server (src/core/board.js actionArgs).
'use strict';
const LABEL = { ready: 'Ready', claimed: 'In progress', review: 'In review', waiting: 'Waiting', blocked: 'Blocked', 'needs-spec': 'Needs spec' };
const COL_HINT = { ready: 'Agents can take these', claimed: 'Set by agents', review: 'Set by agents', waiting: 'Waits for another task', blocked: 'Needs a person', 'needs-spec': 'Needs criteria first' };
const SVG = {
  board: '<rect x="3" y="3" width="7" height="18" rx="2"/><rect x="14" y="3" width="7" height="11" rx="2"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"/><path d="M7 15h10"/>',
  pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-3"/><path d="m14 4-2 2 2 2"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v4M12 18h.01"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  dots: '<circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  crown: '<path d="m3 8 4 4 5-7 5 7 4-4-2 11H5z"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L4 12l8-8z"/>',
  merge: '<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 7.5v9M6 7.5c0 4 3 4.5 9.5 4.5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  done: '<path d="m4 12 5 5L20 6"/>',
};
const $ = (id) => document.getElementById(id);
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = SVG[name] || SVG.dots; // our own constant markup only, never data
  return s;
}
function e(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'on') { for (const [ev, f] of Object.entries(v)) n.addEventListener(ev, f); } else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false && c !== '') n.append(c);
  return n;
}
const sel = (label, opts, cur, on) => { const s = e('select', { 'aria-label': label, on: { change: () => on(s.value) } }); for (const [v, l] of opts) { const o = e('option', { value: v }, l); if (v === cur) o.selected = true; s.append(o); } return s; };
function toast(text, err) {
  const t = e('div', { class: 'toast' + (err ? ' err' : ''), role: err ? 'alert' : 'status' }, text);
  $('toasts').append(t);
  setTimeout(() => t.remove(), err ? 6500 : 2600);
}
const ago = (m) => (m == null ? '' : m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd');
const since = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60000)) : null; };
const hhmm = (iso) => {
  const d = new Date(iso); if (!Number.isFinite(d.getTime())) return '';
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t;
};
const HUES = [243, 262, 199, 152, 330, 24, 174, 280];
const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; };
const avatar = (login, size) => e('span', { class: 'av' + (size ? ' ' + size : ''), style: 'background:hsl(' + hue(login || '?') + ' 62% 56%)', 'aria-hidden': 'true' }, String(login || '?').replace(/^@/, '').slice(0, 1).toUpperCase());
const gh = (kind, n) => 'https://github.com/' + REPO + '/' + kind + '/' + n;
const link = (kind, n, text, cls) => e('a', { class: cls, href: gh(kind, n), target: '_blank', rel: 'noopener' }, text);
const badge = (tone, ic, text) => e('span', { class: 'badge b-' + tone }, ic ? icon(ic) : '', text);
/** A check or crew-guard state as a badge: success, failure, anything else is still pending. */
const stateBadge = (state, label) => badge(state === 'success' ? 'good' : state === 'failure' ? 'bad' : 'warn', state === 'success' ? 'ok' : state === 'failure' ? 'x' : 'clock', label);
const empty = (ic, title, text) => e('div', { class: 'empty' }, icon(ic), e('b', {}, title), text ? e('span', {}, text) : '');
function copyBox(text, label) {
  return e('button', { class: 'copy', title: 'Copy to the clipboard', on: { click: async () => { try { await navigator.clipboard.writeText(text); toast('Copied: ' + text); } catch { toast('Copy failed: select the text by hand', true); } } } }, icon('copy'), e('span', { class: 'mono' }, label || text));
}
/**
 * Ask for a confirmation with an optional note (instead of window.prompt). Resolves to the note ('' when empty)
 * or null when cancelled. <dialog> keeps the focus inside and gives it back when it closes.
 */
function ask({ title, text, ok, danger, placeholder }) {
  return new Promise((resolve) => {
    const note = e('textarea', { placeholder: placeholder || 'Optional note for the team', 'aria-label': 'Note' });
    const d = e('dialog', { class: 'ask', 'aria-labelledby': 'ask-title' });
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    d.append(e('h2', { id: 'ask-title' }, title), e('p', { class: 'hint' }, text), note,
      e('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' },
        e('button', { class: 'btn', on: { click: () => done(null) } }, 'Cancel'),
        e('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), on: { click: () => done(note.value.trim()) } }, ok)));
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); done(null); });
    document.body.append(d); d.showModal(); note.focus();
  });
}
/**
 * Release a lease. holder: the agent the person saw; the server refuses if someone else holds it by now.
 * Without it (an alert line) the page asks the server who holds the task first, and names them in the question.
 */
async function releaseTask(n, lease) {
  if (lease === undefined) {
    try { const o = (await api('/api/task?n=' + n)).owner; lease = o ? { id: o.lease_id, agent: o.agent } : null; } catch (x) { toast(x.message, true); return; }
  }
  const why = await ask({ title: 'Release the lease on #' + n + '?', text: (lease ? 'Held by ' + lease.agent + '. ' : '') + 'The agent loses the task: it goes back to Ready and anyone may take it. Do this when the agent is gone or went the wrong way.', ok: 'Release lease', danger: true });
  if (why !== null) act({ issue: n, op: 'release', reason: why, expect: lease ? lease.id : '' });
}
function panel(title, ...kids) { return e('section', { class: 'panel' }, e('h2', {}, title), ...kids); }
function panelH(title, extra, ...kids) { return e('section', { class: 'panel' }, e('div', { class: 'panel-h' }, e('h2', {}, title), extra || ''), ...kids); }
function pageH(title, text) { return e('div', { class: 'page-h' }, e('h1', {}, title), e('p', {}, text)); }

/* ---------- state, data, actions ---------- */
const TABS = [
  ['board', 'Board', 'board'], ['team', 'Team & roles', 'team'], ['inbox', 'Inbox', 'inbox'],
  ['discovery', 'Discovery', 'flask'], ['prs', 'Pull requests', 'pr'], ['activity', 'Activity', 'pulse'],
];
let tab = (location.hash || '#board').slice(1); if (!TABS.some((t) => t[0] === tab)) tab = 'board';
let model = null; let view = null; let drag = null; let busy = 0; let openTask = null; let prFilter = 'all';
let boardError = null; let viewError = null; let seq = 0;
const pick = { to: null, hours: '4' }; // the handover form, kept across refreshes
async function api(path) {
  let r;
  try { r = await fetch(path, { headers: { 'x-crew-token': TOKEN } }); } catch { throw new Error('crew board is not reachable: is it still running in the terminal?'); }
  const j = await r.json().catch(() => ({ error: 'bad answer from crew board' }));
  if (j && j.error) throw new Error(j.error);
  return j;
}
const SAID = {
  assign: (b) => (b.value ? 'assigned to @' + b.value : 'unassigned'), status: (b) => 'moved to ' + (LABEL[b.value] || b.value), priority: (b) => 'priority ' + b.value,
  idea: (b) => (b.value === 'accept' ? 'accepted as a task' : 'rejected'), release: () => 'lease released, back in Ready', answer: () => 'answer sent, question closed',
  pause: () => 'team paused: agents stop taking tasks', resume: () => 'team resumed', handoff: (b) => '@' + b.value + ' acts as captain now', back: () => 'you are the captain again', 'approve-plan': () => 'plan approved',
};
async function act(body) {
  busy++;
  try {
    const r = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-crew-token': TOKEN }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: 'bad answer from crew board' }));
    if (j.error) { toast(j.error, true); return false; }
    if (!j.noop) toast((body.issue ? '#' + body.issue + ': ' : '') + (j.message || (SAID[body.op] ? SAID[body.op](body) : 'done')));
    return true;
  } catch { toast('crew board is not reachable: is it still running?', true); return false; } finally { busy--; load(true); if (openTask) showTask(openTask, true); }
}

/* ---------- header, tabs, pause ---------- */
function renderChrome() {
  const m = model; const d = m.digest; const c = d.counts;
  $('phase').replaceChildren(d.phase ? e('span', { class: 'pill ' + d.phase, title: d.phase === 'discovery' ? 'Research only: no product code until the plan is approved' : 'Building the approved plan' }, 'phase: ' + d.phase) : '');
  const cap = d.captain;
  $('captain').replaceChildren(cap ? e('span', { class: 'pill' + (cap.acting ? ' acting' : ''), title: cap.acting ? 'Handed over until ' + (cap.acting.until || '?') : 'Plans, decides on ideas, gets questions for a human' }, icon('crown'), cap.acting ? 'acting @' + cap.acting.login : 'captain @' + cap.captain) : '');
  const counts = { inbox: (c.ideas || 0) + (m.human_questions || 0), prs: c.prs || 0 };
  const nav = $('tabs'); const hadFocus = nav.contains(document.activeElement); nav.replaceChildren();
  for (const [id, label, ic] of TABS) {
    const n = counts[id];
    nav.append(e('button', { class: 'tab', role: 'tab', id: 'tab-' + id, 'aria-controls': 'main', tabindex: tab === id ? '0' : '-1', 'aria-selected': String(tab === id), on: { click: () => go(id) } }, icon(ic), label, n ? e('span', { class: 'count' + (id === 'inbox' ? ' hot' : '') }, String(n)) : ''));
  }
  $('main').setAttribute('aria-labelledby', 'tab-' + tab);
  if (hadFocus) $('tab-' + tab).focus(); // the tabs were rebuilt: keep the keyboard where it was
  const paused = m.paused || [];
  $('pausebar').replaceChildren(...(paused.length ? [e('div', { class: 'pausebar' }, icon('pause'), 'The team is paused: agents do not take or claim tasks (' + paused.map((p) => '#' + p.number).join(', ') + ').', e('span', { class: 'grow' }), e('button', { class: 'btn', on: { click: () => act({ op: 'resume', issues: paused.map((p) => p.number) }) } }, icon('play'), 'Resume'))] : []));
  $('pause').hidden = paused.length > 0;
}
function go(id) { tab = id; history.replaceState(null, '', '#' + id); view = null; viewError = null; if (model) renderChrome(); renderTab(); load(true); }
$('tabs').addEventListener('keydown', (ev) => {
  const i = TABS.findIndex((t) => t[0] === tab);
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[ev.key];
  if (to === undefined) return;
  ev.preventDefault();
  go(TABS[(to + TABS.length) % TABS.length][0]);
  $('tab-' + tab).focus();
});

/* ---------- Board ---------- */
const matches = (t, q) => !q || ('#' + t.number + ' ' + t.title + ' ' + (t.area || '') + ' ' + t.assignees.map((a) => '@' + a).join(' ')).toLowerCase().includes(q.toLowerCase());
const canDrop = (t, col) => !!t && ST.includes(col) && t.status !== col && !['claimed', 'review'].includes(t.status);
function marks() { for (const col of document.querySelectorAll('.col')) { col.classList.remove('can', 'no', 'over'); if (drag) col.classList.add(canDrop(drag, col.dataset.col) ? 'can' : 'no'); } }
function zone(el, ok, drop) {
  el.addEventListener('dragover', (ev) => { if (drag && ok()) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; el.classList.add('over'); } });
  el.addEventListener('dragleave', (ev) => { if (!el.contains(ev.relatedTarget)) el.classList.remove('over'); });
  el.addEventListener('drop', (ev) => { ev.preventDefault(); el.classList.remove('over'); if (drag && ok()) drop(drag); });
}
function card(t) {
  const c = e('div', {
    class: 'card prio-' + t.priority, draggable: 'true', tabindex: '0', 'data-n': String(t.number), 'aria-label': '#' + t.number + ' ' + t.title + ', press Enter to open',
    on: {
      dragstart: (ev) => { drag = t; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', '#' + t.number + ' ' + t.title); requestAnimationFrame(() => c.classList.add('ghost')); document.body.classList.add('dragging-on'); marks(); },
      dragend: () => { c.classList.remove('ghost'); drag = null; document.body.classList.remove('dragging-on'); marks(); },
      keydown: (ev) => { if (ev.target === c && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); showTask(t.number); } },
    },
  });
  const who = t.assignees[0];
  const old = t.status === 'claimed' && t.idle_min >= 120;
  c.append(
    e('span', { class: 'num mono' }, '#' + t.number),
    e('button', { class: 't', on: { click: () => showTask(t.number) } }, t.title),
    e('div', { class: 'chips' }, t.area && e('span', { class: 'chip area' }, 'area: ' + t.area), t.risk && e('span', { class: 'chip risk-' + t.risk }, 'risk: ' + t.risk), t.tier && e('span', { class: 'chip' }, 'tier ' + t.tier), t.priority === 'high' && e('span', { class: 'chip p-high' }, '▲ priority'), t.priority === 'low' && e('span', { class: 'chip' }, '▼ low')),
    e('div', { class: 'foot' }, who ? e('span', { class: 'who' }, avatar(who, 'sm'), t.assignees.join(', ')) : e('span', { class: 'who none' }, 'unassigned'),
      e('span', { class: 'idle' + (old ? ' old' : ''), title: old ? 'No activity for ' + t.idle_min + ' min: the lease may be stale' : 'No activity for ' + t.idle_min + ' min' }, ago(t.idle_min) + ' idle')),
  );
  return c;
}
const KPI = [
  ['ready', 'Ready', 'agents can take these', '', 'board'], ['claimed', 'In progress', 'held by agents now', '', 'board'],
  ['human', 'Need a human', 'blocked or asking you', 'bad', 'inbox'], ['stale', 'Stale leases', 'no heartbeat: free them?', 'warn', 'activity'],
  ['prs', 'PRs waiting', 'review, fix or merge', '', 'prs'], ['questions', 'Open questions', 'between agents', '', 'inbox'],
  ['ideas', 'Ideas to decide', 'accept or reject', 'warn', 'inbox'], ['idle', 'Idle members', 'nothing to work on', 'warn', 'team'],
];
const ALERT_IC = { human: ['alert', 'red'], stale: ['clock', 'amber'], questions: ['chat', 'blue'], idle: ['user', 'amber'], newcomers: ['user', 'violet'], research: ['clock', 'amber'] };
const taskByN = (n) => Object.values(model.columns).flat().find((t) => t.number === n) || null;
/** One alert line with the action that resolves it: open the task, release a stale lease, answer a question. */
function alertLine(key, line) {
  const n = Number((/^#(\d+)/.exec(line) || [])[1]);
  const t = n ? taskByN(n) : null;
  const acts = [];
  if (t) {
    if (key === 'stale' || (key === 'human' && t.status === 'blocked')) acts.push(e('button', { class: 'btn small danger', on: { click: () => releaseTask(n) } }, 'Release'));
    acts.push(e('button', { class: 'btn small', on: { click: () => showTask(n) } }, 'Open'));
  } else if (n && key === 'human') acts.push(e('button', { class: 'btn small primary', on: { click: () => go('inbox') } }, 'Answer'));
  else if (n) acts.push(link('issues', n, 'Open', 'btn small'));
  else if (key === 'idle' || key === 'newcomers') acts.push(e('button', { class: 'btn small', on: { click: () => go('team') } }, 'Team'));
  return e('li', { class: 'row' }, e('span', { class: 'grow' }, line), ...acts);
}
/** What waits in pull requests, on the board itself: the next step for each, one click to the PR. */
const PR_KIND = { merge: ['accent', 'merge', 'merge'], review: ['warn', 'eye', 'review'], fix: ['bad', 'wrench', 'fix'], checks: ['info', 'clock', 'checks'] };
function prStrip() {
  const prs = model.prs || [];
  if (!prs.length) return '';
  const row = e('div', { class: 'prstrip' });
  for (const p of prs.slice(0, 8)) {
    const [tone, ic, word] = PR_KIND[p.kind] || ['muted', 'pr', p.kind];
    row.append(e('a', { class: 'prchip', href: gh('pull', p.number), target: '_blank', rel: 'noopener', title: p.kind === 'fix' && p.reason ? 'Author fixes: ' + p.reason : p.kind === 'review' ? 'Needs review ' + p.have + '/' + p.need : '' }, badge(tone, ic, word), e('span', { class: 'mono muted' }, '#' + p.number), e('span', { class: 'ttl' }, p.title)));
  }
  if (prs.length > 8) row.append(e('button', { class: 'btn small', on: { click: () => go('prs') } }, '+' + (prs.length - 8) + ' more'));
  return panelH('Pull requests waiting', e('button', { class: 'btn small', on: { click: () => go('prs') } }, 'All PRs'), row);
}
function renderBoard(root) {
  const m = model; const d = m.digest; const c = d.counts;
  const kp = e('div', { class: 'kpis' });
  for (const [key, label, hint, tone, to] of KPI) {
    const n = c[key] || 0;
    kp.append(e('button', { class: 'kpi ' + (n ? tone : ''), title: 'Open ' + to, on: { click: () => go(to) } }, e('span', {}, label), e('b', {}, String(n)), e('small', {}, hint)));
  }
  const al = e('div', { class: 'alerts' });
  if ((m.ideas || []).length) {
    const ul = e('ul');
    for (const i of m.ideas.slice(0, 3)) ul.append(e('li', { class: 'row' }, e('span', { class: 'grow' }, '#' + i.number + ' ' + i.title.replace(/^Idea:\s*/i, '') + (i.who ? ' · from @' + i.who : '')), e('button', { class: 'btn small primary', on: { click: () => act({ issue: i.number, op: 'idea', value: 'accept' }) } }, 'Accept'), e('button', { class: 'btn small', on: { click: () => go('inbox') } }, 'Reject…')));
    al.append(e('div', { class: 'alert' }, e('span', { class: 'ic' }, icon('bulb')), e('div', { class: 'body' }, e('h3', {}, 'Ideas waiting for the captain'), ul)));
  }
  for (const s of d.sections.filter((x) => !['prs', 'ideas'].includes(x.key) && x.lines.length)) {
    const [ic, tone] = ALERT_IC[s.key] || ['alert', 'amber'];
    const ul = e('ul'); for (const l of s.lines.slice(0, 5)) ul.append(alertLine(s.key, l));
    if (s.lines.length > 5) ul.append(e('li', { class: 'faint' }, '+' + (s.lines.length - 5) + ' more'));
    al.append(e('div', { class: 'alert' }, e('span', { class: 'ic ' + tone }, icon(ic)), e('div', { class: 'body' }, e('h3', {}, s.title + ' · ' + s.lines.length), ul)));
  }
  if (!al.children.length) al.append(e('div', { class: 'alert clear' }, e('span', { class: 'ic green' }, icon('ok')), 'All clear: nobody waits for a human, no stale leases, everyone has work.'));
  root.append(panel('Captain panel', kp, al));
  const strip = prStrip(); if (strip) root.append(strip);

  const touch = matchMedia('(pointer: coarse)').matches;
  const team = e('section', { class: 'panel team', 'aria-label': 'Team: drop a card on a person to assign it' }, e('h2', {}, 'Team'), e('span', { class: 'sep', 'aria-hidden': 'true' }), e('span', { class: 'hint' }, touch ? 'Tap a card, then assign it or change its status at the bottom of the panel' : 'Drag a card onto a person to assign it, or onto a column to change its status'));
  for (const p of m.members) { const el = e('span', { class: 'person', title: 'Drop a card here to give it to @' + p }, avatar(p), p); zone(el, () => !drag.assignees.includes(p), (t) => act({ issue: t.number, op: 'assign', value: p })); team.append(el); }
  if (!m.members.length) team.append(e('span', { class: 'hint' }, '(gh shows no members)'));
  const un = e('span', { class: 'person unassign', title: 'Drop a card here to unassign it' }, '✕ Unassign'); zone(un, () => drag.assignees.length > 0, (t) => act({ issue: t.number, op: 'assign', value: '' })); team.append(un);
  root.append(team);

  const q = $('q').value.trim(); const cols = e('div', { class: 'board' });
  for (const col of COLS) {
    const list = m.columns[col].filter((t) => matches(t, q)); const locked = !ST.includes(col);
    const el = e('div', { class: 'col', 'data-col': col }, e('div', { class: 'col-h' }, e('div', {}, e('b', {}, LABEL[col] || col), e('small', {}, COL_HINT[col] || '')), locked ? icon('lock') : '', e('span', { class: 'n' }, String(list.length))));
    for (const t of list) el.append(card(t));
    if (!locked || !list.length) el.append(e('div', { class: 'drop' }, q && !list.length ? 'No matches' : locked ? 'Nothing here' : 'Drop a card here'));
    zone(el, () => canDrop(drag, col), (t) => { const node = document.querySelector('.card[data-n="' + t.number + '"]'); if (node) { node.classList.add('saving'); el.insertBefore(node, el.querySelector('.drop')); } act({ issue: t.number, op: 'status', value: col }); });
    cols.append(el);
  }
  root.append(cols);
  if (m.untracked) root.append(e('p', { class: 'hint' }, m.untracked + ' open issue(s) have no status label and are not shown.'));
}

/* ---------- Task drawer ---------- */
const TONE = { good: '', bad: 'bad', warn: 'warn', info: 'info' };
let returnFocus = null;
async function showTask(n, quiet) {
  if (!quiet && !openTask) returnFocus = document.activeElement;
  openTask = n;
  if (!quiet) { $('d-body').replaceChildren(e('div', { class: 'hint' }, 'Loading #' + n + '…')); $('d-title').textContent = '#' + n; $('d-foot').replaceChildren(); }
  $('drawer').classList.add('on'); $('scrim').classList.add('on'); $('drawer').setAttribute('aria-hidden', 'false');
  if (!quiet) $('d-close').focus();
  let t; try { t = await api('/api/task?n=' + n); } catch (x) { if (!quiet) $('d-body').replaceChildren(empty('alert', 'Could not load #' + n, x.message)); return; }
  if (openTask !== n) return;
  $('d-kicker').textContent = 'Task #' + t.number;
  $('d-title').textContent = t.title;
  $('d-status').replaceChildren(t.status ? badge(t.status === 'blocked' ? 'bad' : t.status === 'claimed' || t.status === 'review' ? 'accent' : 'muted', '', LABEL[t.status] || t.status) : badge('muted', '', t.state.toLowerCase()));
  const left = e('div', { class: 'panel' });
  left.append(e('div', { class: 'sect' }, e('h3', {}, 'Goal'), e('div', {}, t.goal || e('span', { class: 'muted' }, 'No goal written in the issue.'))));
  const crit = e('div', { class: 'sect' }, e('h3', {}, 'Acceptance criteria'));
  if (t.criteria.length) for (const k of t.criteria) crit.append(e('div', { class: 'check' }, e('span', { class: 'box' + (k.done ? ' on' : '') }, k.done ? icon('check') : ''), e('span', {}, k.text)));
  else crit.append(e('div', { class: 'hint' }, 'No checklist in the issue: agents will not take it as ready (Definition of Ready).'));
  left.append(crit);
  left.append(e('div', { class: 'sect' }, e('h3', {}, 'Labels'), e('div', { class: 'chips' }, t.area && e('span', { class: 'chip area' }, 'area · ' + t.area), t.risk && e('span', { class: 'chip risk-' + t.risk }, 'risk · ' + t.risk), t.tier && e('span', { class: 'chip' }, 'tier · ' + t.tier), e('span', { class: 'chip ' + (t.priority === 'high' ? 'red' : 'accent') }, 'priority · ' + t.priority))));
  const own = e('div', { class: 'sect' }, e('h3', {}, 'Owner & lease'));
  const person = t.assignees[0];
  own.append(e('div', { class: 'row' }, person ? avatar(person) : avatar('?'), e('div', { class: 'grow' }, e('b', {}, person ? '@' + t.assignees.join(', @') : 'Nobody'), e('div', { class: 'hint' }, person ? 'Owner of the area or assigned by hand' : 'Any agent with the right area and tier may take it')), person ? badge('accent', '', 'Owner') : ''));
  if (t.owner) {
    const l = t.owner.lease_left_min;
    own.append(e('div', { class: 'row', style: 'margin-top:10px' }, e('span', { class: 'ic violet' }, icon('cpu')), e('div', { class: 'grow' }, e('b', { class: 'mono' }, t.owner.agent || 'agent'), e('div', { class: 'hint' }, 'holds the lease since ' + hhmm(t.owner.since))), l == null ? '' : badge(l < 0 ? 'bad' : l < 10 ? 'warn' : 'good', 'clock', l < 0 ? 'stale ' + ago(-l) : l + ' min left')));
    own.append(e('div', { class: 'hint', style: 'margin-top:6px' }, 'The lease is ' + t.lease_minutes + ' min and renews with every heartbeat or commit. Release it if the agent is gone.'));
  } else own.append(e('div', { class: 'hint', style: 'margin-top:6px' }, 'No agent holds this task now.'));
  left.append(own);
  if (t.after.length) {
    const dep = e('div', { class: 'sect' }, e('h3', {}, 'Dependencies'));
    for (const d of t.deps || t.after.map((n) => ({ number: n }))) {
      const closed = d.state === 'CLOSED';
      dep.append(e('div', { class: 'row' }, e('span', { class: 'ic ' + (closed ? 'green' : 'amber') }, icon(closed ? 'ok' : 'clock')),
        e('div', { class: 'grow' }, e('button', { class: 'btn small', on: { click: () => showTask(d.number) } }, '#' + d.number), ' ', d.title || ''),
        closed ? badge('good', '', 'done') : d.status ? badge(d.status === 'blocked' ? 'bad' : 'muted', '', LABEL[d.status] || d.status) : ''));
    }
    const open = (t.deps || []).filter((d) => d.state !== 'CLOSED').length;
    dep.append(e('div', { class: 'hint', style: 'margin-top:6px' }, open || !t.deps ? 'It moves to Ready by itself when all of these are closed.' : 'All done: the sweep moves it to Ready.'));
    left.append(dep);
  }
  left.append(e('div', { class: 'sect' }, e('details', {}, e('summary', {}, 'Full issue text'), e('pre', { class: 'body' }, t.body || '(empty)'))));
  const right = e('div', { class: 'panel' });
  const tl = e('ol', { class: 'tl' });
  for (const ev of t.timeline.slice().reverse()) tl.append(e('li', {}, e('time', {}, hhmm(ev.at)), e('span', { class: 'dot ' + (TONE[ev.tone] || '') }), e('div', {}, e('b', {}, ev.title), ev.detail ? e('span', {}, ev.detail) : '')));
  right.append(e('div', { class: 'sect' }, e('h3', {}, 'Timeline'), t.timeline.length ? tl : e('div', { class: 'hint' }, 'Nothing yet: claims, heartbeats and releases show up here.')));
  const prs = e('div', { class: 'sect' }, e('h3', {}, 'Linked pull request'));
  if (t.pr) {
    const p = t.pr;
    prs.append(e('div', { class: 'row' }, e('span', { class: 'mono muted' }, '#' + p.number), link('pull', p.number, p.title, 'grow'), e('a', { class: 'btn icon', href: gh('pull', p.number), target: '_blank', rel: 'noopener', 'aria-label': 'Open PR on GitHub' }, icon('ext'))));
    prs.append(e('div', { class: 'chips' },
      stateBadge(p.check, 'checks: ' + (p.check || 'none yet')),
      stateBadge(p.guard, 'crew-guard: ' + (p.guard || 'waiting')),
      p.kind === 'review' ? badge('warn', 'eye', 'review ' + p.have + '/' + p.need) : p.kind === 'merge' ? badge('accent', 'merge', 'ready to merge') : p.kind === 'fix' ? badge('bad', 'wrench', 'author fixes') : ''));
    if (p.guard_text) prs.append(e('div', { class: 'hint' }, p.guard_text));
    if (p.author) prs.append(e('div', { class: 'hint' }, 'Written by ', e('span', { class: 'mono' }, p.author)));
  } else prs.append(e('div', { class: 'hint' }, 'No open PR says "Closes #' + t.number + '" yet.'));
  right.append(prs);
  right.append(e('div', { class: 'sect' }, e('h3', {}, 'Agent command'), copyBox(t.claim_command), e('div', { class: 'hint', style: 'margin-top:6px' }, 'Paste it to an agent to make it take exactly this task.')));
  $('d-body').replaceChildren(left, right);
  const foot = $('d-foot'); foot.replaceChildren();
  const members = (model && model.members) || [];
  foot.append(e('label', { class: 'f' }, 'Assign', sel('Assignee', [['', 'unassigned'], ...members.map((x) => [x, '@' + x])], person || '', (v) => act({ issue: t.number, op: 'assign', value: v }))));
  if (ST.includes(t.status)) foot.append(e('label', { class: 'f' }, 'Status', sel('Status', ST.map((x) => [x, LABEL[x]]), t.status, (v) => act({ issue: t.number, op: 'status', value: v }))));
  foot.append(e('label', { class: 'f' }, 'Priority', sel('Priority', PR.map((x) => [x, x]), t.priority, (v) => act({ issue: t.number, op: 'priority', value: v }))));
  foot.append(e('span', { class: 'grow' }));
  if (t.status === 'claimed' || t.status === 'blocked') foot.append(e('button', { class: 'btn danger', on: { click: () => releaseTask(t.number, t.owner ? { id: t.owner.lease_id, agent: t.owner.agent } : null) } }, icon('lock'), 'Release lease'));
  foot.append(e('a', { class: 'btn', href: gh('issues', t.number), target: '_blank', rel: 'noopener' }, icon('ext'), 'Open on GitHub'));
}
function closeTask() {
  openTask = null; $('drawer').classList.remove('on'); $('scrim').classList.remove('on'); $('drawer').setAttribute('aria-hidden', 'true');
  const back = returnFocus; returnFocus = null;
  // the card may have been re-rendered while the drawer was open: focus the same task's new card
  const n = back && back.closest && back.closest('.card') ? back.closest('.card').dataset.n : null;
  const target = back && document.contains(back) ? back : n ? document.querySelector('.card[data-n="' + n + '"]') : null;
  if (target) target.focus();
}
$('drawer').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Tab' || !openTask) return;
  const f = [...$('drawer').querySelectorAll('a[href],button:not([disabled]),select,textarea,input,summary,[tabindex="0"]')].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0]; const last = f[f.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); } else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
});

/* ---------- Team & roles ---------- */
function renderTeam(root, v) {
  root.append(pageH('Team & roles', 'Who owns each area, what their agents do now, and who acts as captain.'));
  const pol = v.policy; const me = model.login; const isCaptain = me && v.captain && me.toLowerCase() === v.captain.toLowerCase();
  const capCard = e('section', { class: 'panel captain' });
  capCard.append(avatar(v.acting ? v.acting.login : v.captain || '?', 'xl'), e('div', { class: 'meta' }, e('h2', {}, v.acting ? 'Acting captain @' + v.acting.login : v.captain ? 'Captain @' + v.captain : 'No captain set'), e('div', { class: 'hint' }, v.acting ? 'Until ' + new Date(v.acting.until).toLocaleString() + ' · handed over by @' + v.captain : 'Plans the work (kickoff), decides on ideas, answers questions only a human can.')));
  capCard.append(e('span', { class: 'vsep' }));
  const modes = e('div', { class: 'modes', title: 'Change it with crew captain policy (the repo owner)' });
  for (const md of ['off', 'deputies', 'team']) modes.append(e('span', { class: 'mode' + (pol.mode === md ? ' on' : ''), 'aria-hidden': pol.mode === md ? null : 'true' }, md[0].toUpperCase() + md.slice(1)));
  capCard.append(e('div', {}, e('div', { class: 'hint', style: 'margin-bottom:6px' }, 'Handover rule'), modes, e('div', { class: 'hint', style: 'margin-top:6px' }, pol.mode === 'deputies' ? 'Deputies: ' + (pol.deputies.map((d) => '@' + d).join(', ') || 'none') : pol.mode === 'team' ? 'Anyone with write access' : 'Nobody else can act as captain'), pol.fallback_hours ? e('div', { class: 'hint' }, 'Auto fallback after ' + pol.fallback_hours + ' h of silence') : ''));
  capCard.append(e('span', { class: 'vsep' }));
  const box = e('div', { style: 'display:grid;gap:8px;min-width:240px' });
  if (pol.mode === 'off') box.append(e('div', { class: 'hint' }, 'Handover is off. The repo owner can change it:'), copyBox('crew captain policy --mode deputies --deputies a,b'));
  else if (!isCaptain) box.append(e('div', { class: 'hint' }, 'Only @' + v.captain + ' hands the role over' + (me ? ' (you are @' + me + ')' : '') + '.'));
  else if (v.acting) box.append(e('button', { class: 'btn primary', on: { click: () => act({ op: 'back' }) } }, icon('crown'), 'Take the role back'));
  else {
    const who = (pol.mode === 'deputies' ? pol.deputies : v.people.map((p) => p.login)).filter((l) => l.toLowerCase() !== String(v.captain).toLowerCase());
    if (!who.length) box.append(e('div', { class: 'hint' }, 'No deputies listed yet.'));
    else {
      const keepTo = who.includes(pick.to) ? pick.to : who[0];
      const to = sel('Hand over to', who.map((l) => [l, '@' + l]), keepTo, (v) => { pick.to = v; });
      const hours = sel('For how long', [['2', '2 hours'], ['4', '4 hours'], ['8', '8 hours'], ['24', '1 day'], ['72', '3 days']], pick.hours, (v) => { pick.hours = v; });
      box.append(e('div', { class: 'row' }, to, hours), e('button', { class: 'btn primary', on: { click: () => act({ op: 'handoff', value: to.value, hours: Number(hours.value) }) } }, icon('swap'), 'Hand over captain'), e('div', { class: 'hint' }, 'They can plan and decide until the time runs out or you take it back.'));
    }
  }
  capCard.append(box);
  root.append(capCard);
  const grid = e('div', { class: 'people' });
  for (const p of v.people) {
    const active = p.working.length > 0;
    const quiet = active && p.active_min != null && p.active_min >= 45;
    const st = quiet ? badge('warn', 'clock', 'Quiet ' + ago(p.active_min) + ': lease may be stale') : active ? badge('good', '', 'Working · active ' + ago(p.active_min) + ' ago') : p.queued ? badge('warn', 'clock', p.queued + ' queued, not started') : badge('muted', '', 'Idle');
    const c = e('div', { class: 'pcard' });
    c.append(e('div', { class: 'row' }, avatar(p.login, 'lg'), e('div', { class: 'grow' }, e('b', { style: 'font-size:16px' }, '@' + p.login), e('div', { class: 'row', style: 'gap:4px;margin-top:2px' }, p.captain ? e('span', { class: 'chip violet' }, '👑 captain') : '', p.reviewer ? e('span', { class: 'chip accent' }, 'team reviewer') : '')), st));
    c.append(e('div', { class: 'line' }, icon('layers'), 'Areas:', p.areas.length ? p.areas.map((a) => e('span', { class: 'chip area' }, a)) : e('span', { class: 'chip amber' }, v.has_team_block ? 'none yet' : 'no crew-team block')));
    c.append(e('div', { class: 'line' }, icon('cpu'), 'Agent:', p.agents.length ? p.agents.map((a) => e('b', { class: 'mono' }, a)) : e('span', { class: 'faint' }, 'no lease held now')));
    c.append(e('div', { class: 'line' }, icon('code'), 'Now:', p.working.length ? p.working.map((w) => e('button', { class: 'btn small', on: { click: () => showTask(w.number) } }, '#' + w.number + ' ' + w.title)) : e('span', { class: 'faint' }, 'nothing in progress')));
    c.append(e('div', { class: 'row' }, badge('good', 'done', p.done_week + ' done this week'), p.queued ? e('span', { class: 'hint' }, p.queued + ' more in Ready') : ''));
    grid.append(c);
  }
  for (const n of v.newcomers) grid.append(e('div', { class: 'pcard', style: 'background:var(--accent-soft)' }, e('div', { class: 'row' }, avatar(n, 'lg'), e('b', {}, 'Joined without an area')), e('div', { class: 'hint' }, '@' + n + ' has access but no area, so their agent only takes free tasks. Add a line to the crew-team block in docs/prd.md (a PR the captain merges):'), copyBox('@' + n + ': web', n + ': <area>')));
  root.append(panelH('Members', e('span', { class: 'hint' }, v.people.length + ' people'), v.people.length ? grid : empty('team', 'Nobody yet', 'gh shows no collaborators for this repo.')));
}

/* ---------- Inbox ---------- */
function renderInbox(root, v) {
  root.append(pageH('Inbox', 'Turn useful ideas into work and unblock agents that wait for a person.'));
  const grid = e('div', { class: 'grid3' });
  const ideas = e('ul', { class: 'list' });
  for (const i of v.ideas) {
    const why = e('textarea', { placeholder: 'Why not now? The person who suggested it will read this.', 'aria-label': 'Reason to reject #' + i.number });
    ideas.append(e('li', {}, e('div', { class: 'row' }, e('span', { class: 'ic' }, icon('bulb')), e('div', { class: 'grow' }, link('issues', i.number, i.title), e('div', { class: 'hint mono' }, [i.from, i.who ? 'with @' + i.who : '', ago(i.age_min) + ' ago'].filter(Boolean).join(' · ')))),
      i.task ? e('div', { class: 'hint', style: 'margin:8px 0' }, 'Came up while working on ', e('button', { class: 'btn small', on: { click: () => showTask(i.task) } }, '#' + i.task)) : '',
      e('details', { style: 'margin:6px 0' }, e('summary', {}, 'What exactly'), e('pre', { class: 'body' }, i.text)),
      e('div', { class: 'row', style: 'margin-top:8px' }, e('button', { class: 'btn primary', on: { click: () => act({ issue: i.number, op: 'idea', value: 'accept' }) } }, 'Accept as task'), e('button', { class: 'btn', on: { click: () => { if (!why.value.trim()) { why.focus(); toast('Write a reason first', true); return; } act({ issue: i.number, op: 'idea', value: 'reject', reason: why.value }); } } }, 'Reject with reason')), e('div', { style: 'margin-top:8px' }, why)));
  }
  grid.append(panelH('Ideas', v.ideas.length ? badge('bad', '', v.ideas.length + ' need a decision') : '', v.ideas.length ? ideas : empty('inbox', 'No ideas waiting', 'When a person suggests something outside a task, the agent records it here instead of building it.')));
  const hq = e('ul', { class: 'list' });
  for (const q of v.human) {
    const ans = e('textarea', { placeholder: 'Write the answer (any language; the agent will use it)', 'aria-label': 'Answer to #' + q.number });
    hq.append(e('li', {}, e('b', {}, q.title), e('div', { class: 'hint mono' }, [q.from, ago(q.age_min) + ' ago', q.task ? '#' + q.task : ''].filter(Boolean).join(' · ')), e('details', { style: 'margin:6px 0' }, e('summary', {}, 'Context'), e('pre', { class: 'body' }, q.text)), ans,
      e('div', { class: 'row', style: 'margin-top:8px' }, e('button', { class: 'btn primary', on: { click: () => { if (!ans.value.trim()) { ans.focus(); return; } act({ issue: q.number, op: 'answer', value: ans.value }); } } }, 'Send answer'), link('issues', q.number, 'Open thread', 'hint'))));
  }
  grid.append(panelH('Questions for a human', v.human.length ? badge('warn', 'clock', v.human.length + ' waiting') : '', v.human.length ? hq : empty('user', 'Nothing waits for you', 'Agents ask with crew ask --human when only a person can decide.')));
  const aq = e('ul', { class: 'list' });
  for (const q of v.agents) aq.append(e('li', {}, e('b', {}, q.title), e('div', { class: 'hint mono' }, (q.from || '?') + ' → ' + (q.area ? 'area ' + q.area : 'owner')), e('div', { class: 'row', style: 'margin-top:6px' }, badge(q.age_min > 30 ? 'warn' : 'muted', 'clock', 'waiting ' + ago(q.age_min)), q.task ? e('button', { class: 'btn small', on: { click: () => showTask(q.task) } }, '#' + q.task) : '', link('issues', q.number, 'View thread', 'hint'))));
  grid.append(panelH('Questions between agents', v.agents.length ? badge('muted', '', v.agents.length + ' open') : '', v.agents.length ? aq : empty('chat', 'No open questions', 'Agents ask the owner of another area with crew ask; answers arrive through crew task next.')));
  root.append(grid);
}

/* ---------- Discovery ---------- */
function renderDiscovery(root, v) {
  root.append(pageH('Discovery', v.phase === 'discovery' ? 'Research the unknowns of the brief before any product code. Done when the exit criteria are met and the PRD is reviewed.' : 'The project is in the build phase. A big feature can still get a small research round here.'));
  const grid = e('div', { class: 'grid2' });
  const leftCol = e('div', { style: 'display:grid;gap:16px' });
  if (v.tasks.length) {
    const tb = e('tbody');
    for (const t of v.tasks) {
      const pct = t.budget_hours && t.used_hours != null ? Math.min(100, Math.round((t.used_hours / t.budget_hours) * 100)) : t.state === 'done' ? 100 : 0;
      tb.append(e('tr', {}, e('td', {}, e('div', { class: 'row' }, e('span', { class: 'ic' }, icon('flask')), e('div', {}, link('issues', t.number, t.title), e('div', { class: 'hint mono' }, t.id || '#' + t.number)))),
        e('td', {}, t.owner ? e('span', { class: 'who' }, avatar(t.owner, 'sm'), '@' + t.owner) : e('span', { class: 'faint' }, 'not taken')),
        e('td', {}, e('div', { class: 'hint' }, (t.used_hours != null ? t.used_hours + ' h' : '–') + ' / ' + (t.budget_hours != null ? t.budget_hours + ' h' : '?')), e('div', { class: 'bar' + (t.over ? ' over' : t.state === 'done' ? ' done' : '') }, e('i', { style: 'width:' + pct + '%' }))),
        e('td', {}, t.state === 'done' ? badge('good', 'ok', 'Done') : t.over ? badge('warn', 'alert', 'Over budget: write up and stop') : badge(t.state === 'claimed' ? 'accent' : 'muted', '', LABEL[t.state] || t.state))));
    }
    leftCol.append(panel('Research tasks', e('div', { class: 'table-wrap' }, e('table', { class: 'table' }, e('thead', {}, e('tr', {}, e('th', {}, 'Question'), e('th', {}, 'Owner'), e('th', {}, 'Used / budget'), e('th', {}, 'Status'))), tb))));
  } else leftCol.append(panel('Research tasks', empty('flask', 'No research tasks', 'List the open questions as crew-research blocks in docs/discovery.md, then the captain runs:'), copyBox('crew discover plan --apply')));
  const dl = e('tbody');
  for (const d of v.decisions) dl.append(e('tr', {}, e('td', { class: 'mono muted' }, d.date), e('td', {}, e('b', {}, d.title || '(no title)'))));
  leftCol.append(panel('Decisions log', v.decisions.length ? e('div', { class: 'table-wrap' }, e('table', { class: 'table' }, e('thead', {}, e('tr', {}, e('th', {}, 'Date'), e('th', {}, 'Decision'))), dl)) : empty('flag', 'No decisions yet', 'Agreed choices go to docs/decisions.md as "## YYYY-MM-DD — what was decided".')));
  grid.append(leftCol);
  const rightCol = e('div', { style: 'display:grid;gap:16px' });
  const ex = e('div');
  for (const k of v.exit) ex.append(e('div', { class: 'check' }, e('span', { class: 'box' + (k.done ? ' on' : '') }, k.done ? icon('check') : ''), e('span', {}, k.text)));
  rightCol.append(panel('Exit criteria', v.exit.length ? ex : e('div', { class: 'hint' }, 'No "## Exit criteria" checklist in docs/discovery.md on main.')));
  const met = v.exit.filter((x) => x.done).length;
  const ready = e('section', { class: 'panel', style: 'background:var(--accent-soft);border-color:transparent' });
  ready.append(e('div', { class: 'row' }, e('span', { class: 'ic' }, icon('flag')), e('div', {}, e('h2', { style: 'margin:0;font-size:20px' }, v.ready ? 'Ready to plan' : 'Ready to plan?'), v.exit.length ? badge(met === v.exit.length ? 'good' : 'warn', '', met + ' of ' + v.exit.length + ' exit criteria met') : '')));
  if (v.missing.length) { const ul = e('ul', { style: 'margin:10px 0;padding-left:18px' }); for (const m of v.missing) ul.append(e('li', { class: 'hint', style: 'margin:4px 0' }, m)); ready.append(ul); }
  ready.append(copyBox('crew kickoff --apply'), e('div', { class: 'hint', style: 'margin-top:6px' }, v.ready ? 'The captain runs it: it creates the tasks and switches the phase to build.' : 'It refuses until the list above is empty (a human may override with --skip_discovery).'));
  rightCol.append(ready);
  grid.append(rightCol);
  root.append(grid);
  root.append(planPanel(v.plan));
}

/**
 * The plan (docs/prd.md in this folder) and its approval. crew kickoff --apply creates tasks only from a revision the
 * captain approved here; any edit makes a new revision. The page sends the revision it shows, so an approval is
 * always for the text the person read.
 */
function planPanel(p) {
  if (!p) return panel('The plan', empty('flag', 'No PRD yet', 'The planner writes docs/prd.md (crew-kickoff skill); it shows up here to read and approve.'));
  const me = model.login; const cap = model.digest.captain;
  const isCaptain = !cap || (me && [cap.captain, cap.acting && cap.acting.login].filter(Boolean).some((l) => l.toLowerCase() === me.toLowerCase()));
  const state = p.approved
    ? badge('good', 'ok', 'approved by @' + p.approved_by + (p.approved_at ? ' · ' + hhmm(p.approved_at) : ''))
    : p.changed_since ? badge('warn', 'alert', 'changed since the last approval') : badge('warn', 'clock', 'not approved');
  const head = e('div', { class: 'row' }, e('span', { class: 'ic' }, icon('flag')), e('div', { class: 'grow' }, e('b', {}, p.file), e('div', { class: 'hint mono', title: p.rev }, 'revision ' + p.rev.slice(0, 12) + (p.tasks != null ? ' · ' + p.tasks + ' tasks' : ''))), state);
  const notes = [];
  if (p.same_as_main === false) notes.push(e('div', { class: 'hint' }, 'This folder has a different PRD than main (main: ' + (p.main_rev || 'none') + '). You approve the text below; crew kickoff --apply publishes it.'));
  const body = p.too_long ? e('div', { class: 'hint' }, 'The PRD is too long to show here, so it cannot be approved here: shorten it.') : e('details', { style: 'margin-top:10px' }, e('summary', {}, 'Read the whole plan (exactly the text that gets approved)'), e('pre', { class: 'body' }, p.text || '(empty)'));
  const acts = e('div', { class: 'row', style: 'margin-top:12px' });
  if (p.approved) acts.append(e('span', { class: 'hint' }, 'The captain runs crew kickoff --apply to create the tasks.'), copyBox('crew kickoff --apply'));
  else if (p.too_long) acts.append(e('span', { class: 'hint' }, 'Shorten docs/prd.md to approve it.'));
  else if (!isCaptain) acts.append(e('span', { class: 'hint' }, 'Only the captain approves the plan' + (me ? ' (you are @' + me + ')' : '') + '.'));
  else acts.append(e('button', { class: 'btn primary', on: { click: async () => {
    const ok = await ask({ title: 'Approve revision ' + p.rev.slice(0, 12) + '?', text: 'Agents will turn exactly this text into tasks. Any later edit needs a new approval. Agents never approve a plan themselves.', ok: 'Approve the plan', placeholder: 'Optional note (not posted)' });
    if (ok !== null) act({ op: 'approve-plan', rev: p.rev });
  } } }, icon('ok'), 'Approve the plan'), e('span', { class: 'hint' }, 'Read it first: this is what agents will build.'));
  return panelH('The plan', '', head, ...notes, body, acts);
}

/* ---------- Pull requests ---------- */
const NEXT_TONE = { accent: 'accent', warn: 'warn', info: 'info', bad: 'bad' };
function renderPrs(root, list) {
  root.append(pageH('Pull requests', 'What each PR needs next: a review from another agent, a fix by its author, or a merge.'));
  const groups = { all: list, review: list.filter((p) => p.kind === 'review'), fix: list.filter((p) => p.kind === 'fix'), merge: list.filter((p) => p.kind === 'merge') };
  const f = e('div', { class: 'filters' });
  for (const [k, label, ic] of [['all', 'All open', 'pr'], ['review', 'Needs review', 'eye'], ['fix', 'Needs a fix', 'wrench'], ['merge', 'Ready to merge', 'merge']]) f.append(e('button', { class: 'btn', 'aria-pressed': String(prFilter === k), on: { click: () => { prFilter = k; renderTab(); } } }, icon(ic), label, e('span', { class: 'count' }, String(groups[k].length))));
  const rows = groups[prFilter] || list;
  const tb = e('tbody');
  for (const p of rows) {
    const rv = p.reviews.filter((r) => r.current);
    tb.append(e('tr', {},
      e('td', {}, e('span', { class: 'mono muted' }, '#' + p.number), e('div', {}, link('pull', p.number, p.title)), p.issue ? e('button', { class: 'btn small', style: 'margin-top:4px', on: { click: () => showTask(p.issue) } }, 'task #' + p.issue) : ''),
      e('td', {}, p.author ? e('span', { class: 'chip' }, icon('cpu'), p.author) : e('span', { class: 'faint' }, 'not via crew')),
      e('td', {}, rv.length ? rv.map((r) => e('div', { title: r.own ? 'The author reviewed their own PR: crew-guard does not count it' : '' }, r.own ? badge('muted', 'user', r.agent + ' (own, not counted)') : badge(r.verdict === 'approve' ? 'good' : 'bad', r.verdict === 'approve' ? 'ok' : 'x', r.agent))) : e('span', { class: 'faint' }, 'no review on this commit')),
      e('td', {}, stateBadge(p.check, p.check || 'pending')),
      e('td', { title: p.guard_text || '' }, stateBadge(p.guard, p.guard === 'failure' && p.guard_text ? p.guard_text.slice(0, 48) : p.guard || 'pending')),
      e('td', {}, e('span', { class: 'chip risk-' + p.risk }, p.risk)),
      e('td', { class: 'muted' }, ago(p.age_min)),
      e('td', {}, p.conflict ? badge('bad', 'alert', 'conflict') : e('span', { class: 'faint' }, 'none')),
      e('td', {}, p.next ? badge(NEXT_TONE[p.next.tone] || 'muted', p.kind === 'merge' ? 'merge' : p.kind === 'review' ? 'eye' : p.kind === 'fix' ? 'wrench' : 'clock', p.next.label) : e('span', { class: 'faint' }, '–'))));
  }
  root.append(e('section', { class: 'panel' }, f, rows.length ? e('div', { class: 'table-wrap' }, e('table', { class: 'table' }, e('thead', {}, e('tr', {}, ['Pull request', 'Author agent', 'Review', 'Checks', 'crew-guard', 'Risk', 'Age', 'Conflicts', 'Next'].map((h) => e('th', {}, h)))), tb)) : empty('pr', 'Nothing here', prFilter === 'all' ? 'No open pull requests.' : 'No PR in this group right now.')));
  root.append(e('p', { class: 'hint' }, 'Agents act on these through crew task next: fixes first, then merges, then reviews. Hover a crew-guard badge for the rule that failed.'));
}

/* ---------- Activity ---------- */
const FEED = { done: ['done', 'green', 'Task done'], merged: ['merge', 'green', 'Merged'], task_claim: ['user', 'blue', 'Task claimed'], pr_open: ['pr', 'violet', 'PR opened'], task_release: ['lock', 'amber', 'Lease released'], idea: ['bulb', '', 'Idea recorded'], ask: ['chat', 'blue', 'Question asked'], pr_review: ['eye', 'violet', 'Review'] };
function renderActivity(root, v) {
  root.append(pageH('Activity', 'How work moved this week, and where the crew needs help.'));
  const grid = e('div', { class: 'grid2' });
  const feed = e('ul', { class: 'feed' });
  for (const f of v.feed) { const [ic, tone, label] = FEED[f.kind] || ['dots', '', f.kind]; feed.append(e('li', {}, e('time', {}, hhmm(f.at)), e('span', { class: 'ic ' + tone }, icon(ic)), e('div', {}, e('b', {}, label), e('div', { class: 'hint' }, f.who ? e('span', { class: 'mono' }, f.who) : '', f.who ? ' · ' : '', f.title)), e('span', { class: 'faint' }, ago(since(f.at)) + ' ago'))); }
  grid.append(panelH('This week', v.metrics_local ? '' : e('span', { class: 'hint' }, 'GitHub events only: agent events come from .crew/metrics.jsonl on this machine'), v.feed.length ? feed : empty('pulse', 'Quiet week', 'Closed tasks, merges and agent events show up here.')));
  const right = e('div', { style: 'display:grid;gap:16px' });
  const max = Math.max(1, ...v.days.map((d) => d.done));
  const chart = e('div', { class: 'chart', role: 'img', 'aria-label': 'Tasks done per day: ' + v.days.map((d) => d.day + ' ' + d.done).join(', ') });
  const xs = e('div', { class: 'chart-x' });
  for (const d of v.days) { chart.append(e('div', { class: 'c' }, e('b', {}, String(d.done)), e('i', { style: 'height:' + Math.round((d.done / max) * 100) + '%' }))); xs.append(e('span', {}, new Date(d.day + 'T12:00:00').toLocaleDateString([], { weekday: 'short' }))); }
  right.append(panelH('Tasks done per day', badge('good', 'ok', v.done_total + ' this week'), chart, xs));
  const hb = e('div');
  const maxc = Math.max(1, ...v.claim_to_pr.map((x) => x.median_min || 0));
  for (const a of v.claim_to_pr) hb.append(e('div', { class: 'hbar' }, e('span', { class: 'mono' }, a.agent), e('div', { class: 'bar' }, e('i', { style: 'width:' + Math.round(((a.median_min || 0) / maxc) * 100) + '%' })), e('span', { class: 'muted' }, (a.median_min ?? '–') + ' min')));
  right.append(panel('Median time from claim to PR', v.claim_to_pr.length ? hb : e('div', { class: 'hint' }, 'No claim → PR pairs in this machine\'s metrics yet.'), e('div', { class: 'hint', style: 'margin-top:8px' }, 'Long times usually mean the task is too big: split it in the PRD.')));
  const st = e('ul', { class: 'list' }); for (const s of v.stale) st.append(e('li', { class: 'hint' }, s));
  right.append(panelH('Stale leases', v.stale.length ? badge('warn', 'clock', v.stale.length + ' now') : badge('good', 'ok', 'none'), v.stale.length ? st : e('div', { class: 'hint' }, 'Every claimed task has a recent heartbeat or commit.'), v.stale.length ? e('div', { class: 'hint', style: 'margin-top:8px' }, 'Open the task on the Board and press Release lease, or wait for the sweep job.') : ''));
  grid.append(right);
  root.append(grid);
}

/* ---------- loading ---------- */
const RENDER = { team: renderTeam, inbox: renderInbox, discovery: renderDiscovery, prs: renderPrs, activity: renderActivity };
const PATH = { team: '/api/team', inbox: '/api/inbox', discovery: '/api/discovery', prs: '/api/prs', activity: '/api/activity' };
const failed = (what, msg) => e('section', { class: 'panel' }, e('div', { class: 'empty' }, icon('alert'), e('b', {}, 'Could not load ' + what), e('span', {}, msg), e('button', { class: 'btn', on: { click: () => load(true) } }, 'Try again')));
const TAB_NAME = Object.fromEntries(TABS.map((t) => [t[0], t[1]]));
const staleBar = (msg) => e('div', { class: 'pausebar warn', role: 'alert' }, icon('alert'), 'Could not refresh: ' + msg + '. This is older data.', e('span', { class: 'grow' }), e('button', { class: 'btn', on: { click: () => load(true) } }, 'Try again'));
function renderTab() {
  const root = $('main'); const keep = root.scrollTop; root.replaceChildren();
  const old = tab === 'board' ? model && boardError : view && (viewError || boardError);
  if (old) root.append(staleBar(tab === 'board' ? boardError : viewError || boardError));
  if (tab === 'board' && model) renderBoard(root);
  else if (tab === 'board') root.append(boardError ? failed('the board', boardError) : e('div', { class: 'hint' }, 'Loading…'));
  else if (view && model) RENDER[tab](root, view);
  else root.append(viewError ? failed(TAB_NAME[tab], viewError) : boardError && !model ? failed('the board', boardError) : e('div', { class: 'hint' }, 'Loading…'));
  root.scrollTop = keep;
}
// a refresh must not rebuild a form under the person's hands: a focused field or an open select keeps the page
const busyForm = () => { const a = document.activeElement; return !!a && a.id !== 'q' && (a.tagName === 'SELECT' || (['TEXTAREA', 'INPUT'].includes(a.tagName) && !!a.value)); };
async function load(force) {
  if (drag || busy || document.querySelector('dialog[open]') || (!force && busyForm())) return;
  const my = ++seq; const want = tab;
  document.body.classList.add('loading');
  const [m, v] = await Promise.allSettled([api('/api/board'), want === 'board' ? Promise.resolve(null) : api(PATH[want])]);
  document.body.classList.remove('loading');
  if (my !== seq) return; // a newer refresh started: its answer wins
  const why = (r) => (r.reason && r.reason.message) || 'crew board is not reachable: is it still running?';
  if (m.status === 'fulfilled') { model = m.value; boardError = null; } else boardError = why(m);
  if (want === tab && want !== 'board') { if (v.status === 'fulfilled') { view = v.value; viewError = null; } else viewError = why(v); }
  if (model) renderChrome();
  renderTab();
  const err = boardError || (want !== 'board' && viewError);
  $('time').textContent = err ? 'could not refresh' : 'updated ' + new Date(model.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('time').classList.toggle('bad', !!err);
  if (err && force) toast(err, true);
}

/* ---------- wiring ---------- */
function theme(t) { if (t) document.documentElement.dataset.theme = t; const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; $('light').setAttribute('aria-pressed', String(!dark)); $('dark').setAttribute('aria-pressed', String(dark)); }
try { theme(localStorage.getItem('crew-board-theme')); } catch { theme(); }
for (const t of ['light', 'dark']) $(t).onclick = () => { theme(t); try { localStorage.setItem('crew-board-theme', t); } catch { /* private mode */ } };
$('q').addEventListener('input', () => { if (tab !== 'board') go('board'); else renderTab(); });
$('refresh').onclick = () => load(true);
$('pause').onclick = async () => {
  const why = await ask({ title: 'Pause the whole team?', text: 'Agents stop taking and claiming tasks until you press Resume. Work already claimed is not interrupted.', ok: 'Pause team', danger: true, placeholder: 'Reason (the team sees it)' });
  if (why !== null) act({ op: 'pause', reason: why });
};
$('d-close').onclick = closeTask; $('scrim').onclick = closeTask;
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && openTask && !document.querySelector('dialog[open]')) closeTask(); });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h !== tab && TABS.some((t) => t[0] === h)) go(h); });
load(true); setInterval(() => load(false), 30000);
