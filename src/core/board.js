// Task board for humans (crew board): see the queue and steer it by hand without spending agent tokens.
// Pure functions: the model shown on the page, and the gh arguments for each action the page can request.
import { readFileSync } from 'node:fs';
import { labelValue, marker, safeText } from './issues.js';
import { prQueue } from './queue.js';
import { LOGIN_RE } from './prd.js';
import { digestModel } from './digest.js';
import { IDEA_LABEL, ideaMeta, canDecide, acceptArgs } from './ideas.js';
import { QUESTION_LABEL, answerMarker } from './questions.js';

export const COLUMNS = ['ready', 'claimed', 'review', 'waiting', 'blocked', 'needs-spec'];
export const PRIORITIES = ['high', 'normal', 'low'];
/** Statuses a human may set from the board. claimed/review belong to the agent's lease and PR flow. */
export const BOARD_STATUSES = ['ready', 'blocked', 'needs-spec', 'waiting'];

const prio = (i) => labelValue(i, 'priority') ?? 'normal';

export function boardModel({ issues = [], prs = [], members = [], questions = [], ideas = [], team = null, claimComments = {}, config = {}, now = Date.now() } = {}) {
  const columns = Object.fromEntries(COLUMNS.map((c) => [c, []]));
  const other = [];
  for (const i of issues) {
    const status = labelValue(i, 'status');
    if ((i.labels ?? []).some((l) => l.name === 'epic' || l.name === IDEA_LABEL)) continue; // ideas have their own list
    const card = {
      number: i.number,
      title: i.title,
      status,
      area: labelValue(i, 'area'),
      tier: labelValue(i, 'tier'),
      risk: labelValue(i, 'risk'),
      priority: prio(i),
      assignees: (i.assignees ?? []).map((a) => a.login),
      idle_min: Math.max(0, Math.round((now - Date.parse(i.updatedAt ?? '')) / 60000)) || 0,
    };
    (columns[status] ?? other).push(card);
  }
  const order = { high: 0, normal: 1, low: 2 };
  for (const c of COLUMNS) columns[c].sort((a, b) => order[a.priority] - order[b.priority] || a.number - b.number);
  const queue = prQueue(prs, { me: 'board', login: null, reviewers: [], config, now }).map((x) => ({
    kind: x.kind, number: x.number, title: x.title, risk: x.risk, age_min: x.age, reason: x.reason ?? null, have: x.have ?? null, need: x.need ?? null,
  }));
  // Captain panel: the same status crew digest posts to the pinned issue.
  const digest = digestModel({ issues, prs, questions, ideas, team, claimComments, collaborators: members, config, now });
  const ideaList = ideas.map((i) => ({ number: i.number, title: i.title, who: ideaMeta(i)?.who ?? null }));
  return { columns, untracked: other.length, prs: queue, digest, ideas: ideaList, members: [...new Set(members)].sort((a, b) => a.localeCompare(b)), generated_at: new Date(now).toISOString() };
}

/**
 * gh arguments for one board action, or { error }. Everything is validated here because the page
 * is only a convenience: the server never passes page input to gh unchecked.
 * current: the issue as listed ({ number, labels, assignees }).
 */
export function actionArgs({ op, value, reason }, current, { members = [], login = null, config = {}, acting = null } = {}) {
  if (!current || !Number.isInteger(current.number)) return { error: 'unknown issue' };
  const n = String(current.number);
  const labels = (current.labels ?? []).map((l) => l.name);
  if (op === 'idea') {
    // only the captain decides (login of the gh account the board runs under)
    if (!canDecide(login, config, acting)) return { error: `only the captain (or the acting captain) ${config.captain} decides on ideas${login ? `, and gh is logged in as ${login}` : ''}` };
    if (!labels.includes(IDEA_LABEL)) return { error: `#${n} is not an open idea` };
    if (value === 'accept') return acceptArgs(current, { by: login ?? 'captain', config });
    if (value === 'reject') {
      const why = String(reason ?? '').trim();
      if (!why) return { error: 'a reason is needed to reject an idea' };
      return { args: ['issue', 'close', n, '--reason', 'not planned', '--comment', `<!-- crew:idea-rejected by=${login ?? 'captain'} -->\n❌ Not now (@${login ?? 'captain'}): ${safeText(why).slice(0, 1000)}`] };
    }
    return { error: 'idea action must be accept or reject' };
  }
  if (op === 'assign') {
    const to = String(value ?? '');
    const now = (current.assignees ?? []).map((a) => a.login);
    if (to && (!LOGIN_RE.test(to) || !members.some((m) => m.toLowerCase() === to.toLowerCase()))) return { error: `${to} is not a member of this repo` };
    const args = ['issue', 'edit', n];
    for (const a of now) if (a.toLowerCase() !== to.toLowerCase()) args.push('--remove-assignee', a);
    if (to && !now.some((a) => a.toLowerCase() === to.toLowerCase())) args.push('--add-assignee', to);
    return args.length > 3 ? { args } : { noop: true };
  }
  if (op === 'status') {
    const to = String(value ?? '');
    if (!BOARD_STATUSES.includes(to)) return { error: `status must be one of ${BOARD_STATUSES.join(', ')}` };
    const from = labels.filter((l) => l.startsWith('status:')).map((l) => l.slice(7));
    if (from.some((s) => s === 'claimed' || s === 'review')) {
      return { error: `#${n} is ${from.join(',')}: an agent holds it — use crew task release ${n} --force first` };
    }
    if (from.length === 1 && from[0] === to) return { noop: true };
    const args = ['issue', 'edit', n, '--add-label', `status:${to}`];
    for (const f of from) if (f !== to) args.push('--remove-label', `status:${f}`);
    // Back to the queue: also end any old claim (e.g. an agent that set blocked while holding it), as crew task release
    // does; otherwise agents get claim_conflict until that lease ages out.
    if (to === 'ready') return { args, comment: `${marker('release', { agent: 'crew-board', at: new Date().toISOString() })}\n↩️ Returned to the queue from crew board.` };
    return { args };
  }
  if (op === 'priority') {
    const to = String(value ?? '');
    if (!PRIORITIES.includes(to)) return { error: `priority must be one of ${PRIORITIES.join(', ')}` };
    const args = ['issue', 'edit', n];
    for (const l of labels.filter((x) => x.startsWith('priority:') && x !== `priority:${to}`)) args.push('--remove-label', l);
    if (to !== 'normal' && !labels.includes(`priority:${to}`)) args.push('--add-label', `priority:${to}`);
    return args.length > 3 ? { args } : { noop: true };
  }
  if (op === 'release') {
    // a person frees a task an agent holds (its session died, or it went the wrong way): same as crew task release --force
    const from = labels.filter((l) => l.startsWith('status:')).map((l) => l.slice(7));
    if (from.includes('review')) return { error: `#${n} has a PR in review: close or finish the PR instead` };
    if (!from.some((s) => s === 'claimed' || s === 'blocked')) return { error: `#${n} is not held by an agent (status ${from.join(',') || 'none'})` };
    const args = ['issue', 'edit', n, '--add-label', 'status:ready'];
    for (const f of from) if (f !== 'ready') args.push('--remove-label', `status:${f}`);
    for (const a of current.assignees ?? []) args.push('--remove-assignee', a.login);
    return { args, comment: `${marker('release', { agent: `crew-board@${login ?? 'human'}`, at: new Date().toISOString() })}\n↩️ Returned to the queue from crew board${login ? ` by @${login}` : ''}: the lease is free. ${safeText(String(reason ?? '')).slice(0, 500)}`.trim() };
  }
  if (op === 'answer') {
    // a person answers a question an agent asked: the asker gets it through crew task next (kind: answered)
    if (!labels.includes(QUESTION_LABEL)) return { error: `#${n} is not a crew question` };
    const text = String(value ?? '').trim();
    if (!text) return { error: 'write the answer first' };
    return { args: ['issue', 'close', n, '--reason', 'completed', '--comment', `${answerMarker(`@${login ?? 'human'}`)}\n${safeText(text).slice(0, 4000)}`] };
  }
  return { error: `unknown action ${op}` };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Values put into the inline script: JSON, with "<" escaped so a repo name can never close the script tag.
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const asset = (name) => readFileSync(new URL(`../board/${name}`, import.meta.url), 'utf8');

/**
 * The captain's console. The page shell is here; styles and the script live in src/board/ (board.css,
 * board.client.js) and are inlined, so the page needs no other request and the CSP stays 'self'.
 * Data comes from /api/* and every change goes to /api/action with the per-run token.
 */
export function renderPage({ token, repo }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>crew board — ${esc(repo)}</title>
<style>${asset('board.css')}</style></head><body>
<header>
<div class="top">
<div class="logo"><i aria-hidden="true">⛵</i>crew board</div><span class="sep" aria-hidden="true"></span><span class="repo">${esc(repo)}</span>
<span id="phase"></span><span id="captain"></span>
<span class="grow"></span>
<label class="searchbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" class="search" type="search" placeholder="Filter tasks…" aria-label="Filter cards by number, title, area or @login"></label>
<span class="muted" id="time">loading…</span>
<button class="btn danger" id="pause" title="Stop all agents from taking tasks (crew:pause)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>Pause team</button>
<button class="btn icon" id="refresh" title="Refresh now" aria-label="Refresh now"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button>
<span class="seg" role="group" aria-label="Theme"><button class="btn icon" id="light" title="Light" aria-label="Light theme"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button><button class="btn icon" id="dark" title="Dark" aria-label="Dark theme"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button></span>
</div>
<nav class="tabs" id="tabs" role="tablist" aria-label="Screens"></nav>
</header>
<div id="pausebar"></div>
<main class="wrap" id="main"><div id="kpis" class="hint">Loading…</div></main>
<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="d-title" aria-hidden="true">
<div class="d-head"><span class="ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/></svg></span>
<div style="flex:1;min-width:0"><div class="hint" id="d-kicker">Task</div><div class="row"><h2 id="d-title">…</h2><span id="d-status"></span></div></div>
<button class="btn icon" id="d-close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
<div class="d-body" id="d-body"></div>
<div class="d-foot" id="d-foot"></div>
</aside>
<div id="toasts" role="status" aria-live="polite"></div>
<script>
const TOKEN=${js(token)};const REPO=${js(repo)};
const COLS=${js(COLUMNS)};const ST=${js(BOARD_STATUSES)};const PR=${js(PRIORITIES)};
${asset('board.client.js')}
</script></body></html>`;
}
