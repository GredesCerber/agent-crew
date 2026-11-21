// crew board [--port 4747] — a local captain's console for humans: the kanban (drag and drop), a task drawer,
// Team & roles, Inbox, Discovery, Pull requests and Activity, plus manual steering through gh on this machine.
// No agent tokens are spent.
// Security: listens on 127.0.0.1 only and checks the Host header (DNS rebinding). The page itself needs the per-run
// key from the address crew board prints (another user of the same computer cannot open it), and every API call
// carries that key. Page input never reaches gh unvalidated (src/core/board.js actionArgs); every write is checked
// against fresh GitHub state and the gh account in use right now.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, fail } from '../core/output.js';
import { gh, ghJson } from '../core/exec.js';
import { loadConfig } from '../core/config.js';
import { listIssues, PAUSE_LABEL, labelValue, currentOwner } from '../core/issues.js';
import { QUESTION_LABEL } from '../core/questions.js';
import { IDEA_LABEL } from '../core/ideas.js';
import { boardModel, actionArgs, renderPage } from '../core/board.js';
import { taskView, teamView, inboxView, discoveryView, prsView, activityView, pauseView, planView } from '../core/board-views.js';
import { readEvents, metricsRoot } from '../core/metrics.js';
import { RESEARCH_LABEL, DISCOVERY_DOC, DECISIONS_DOC } from '../core/discovery.js';
import { DEFAULT_PRD, PRD_APPROVAL_LABEL, PRD_APPROVAL_TITLE, prdRevision, approvalFor, approvalComment, parsePrd, shortRev, MAX_PRD_CHARS } from '../core/prd.js';
import { mainCaptain } from './kickoff.js';
import { hasCaptainPowers } from '../core/captain.js';
import { teamOf, claimCommentsOf } from './digest.js';
import captainCmds, { loadActingCaptain } from './captain.js';
import { loadDiscoveryStatus, mainDoc } from './discover.js';
import { lastBranchCommitAt } from './task.js';

const PR_FIELDS = 'number,title,body,headRefOid,createdAt,isDraft,author,labels,comments,statusCheckRollup,mergeable,isCrossRepository,autoMergeRequest';
const since = (days, now = Date.now()) => new Date(now - days * 86400000).toISOString().slice(0, 10);

/** A list read through gh. A failed call throws, so the page says "could not load" instead of showing an empty list. */
function listOf(j, args, what) {
  const r = j(args);
  if (!Array.isArray(r)) throw new Error(`gh could not read ${what}`);
  return r;
}

/** Live data from GitHub through gh (the server calls it on every refresh). Every call runs in the project root. */
export function githubSource(root) {
  const j = (args) => ghJson(args, { cwd: root, allowFail: true });
  return {
    issues: () => listIssues({ limit: 500, cwd: root }),
    prs: () => listOf(j, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', PR_FIELDS], 'open pull requests'),
    members: () => (gh(['api', 'repos/{owner}/{repo}/collaborators', '--paginate', '--jq', '.[].login'], { cwd: root, allowFail: true }).stdout || '').split('\n').filter(Boolean),
    edit: (args) => gh(args, { cwd: root, allowFail: true }),
    questions: () => listOf(j, ['issue', 'list', '--state', 'open', '--label', QUESTION_LABEL, '--limit', '100', '--json', 'number,title,body,labels,assignees,createdAt'], 'questions'),
    team: () => teamOf(root),
    claimComments: () => claimCommentsOf(root),
    ideas: () => listOf(j, ['issue', 'list', '--state', 'open', '--label', IDEA_LABEL, '--limit', '100', '--json', 'number,title,body,labels,createdAt'], 'ideas').sort((a, b) => a.number - b.number),
    isAdmin: (login) => (gh(['api', `repos/{owner}/{repo}/collaborators/${login}/permission`, '--jq', '.permission'], { cwd: root, allowFail: true }).stdout || '').trim() === 'admin',
    login: () => (gh(['api', 'user', '--jq', '.login'], { cwd: root, allowFail: true }).stdout || '').trim() || null,
    acting: (config) => loadActingCaptain(root, config),
    issue: (n) => j(['issue', 'view', String(n), '--json', 'number,title,body,labels,assignees,comments,state,stateReason,createdAt,updatedAt']),
    lastCommitAt: (n) => lastBranchCommitAt(n, root),
    closed: (days = 7) => listOf(j, ['issue', 'list', '--state', 'closed', '--search', `closed:>=${since(days)}`, '--limit', '200', '--json', 'number,title,closedAt,assignees,labels,stateReason'], 'closed issues'),
    merged: (days = 7) => listOf(j, ['pr', 'list', '--state', 'merged', '--search', `merged:>=${since(days)}`, '--limit', '100', '--json', 'number,title,mergedAt,mergedBy'], 'merged pull requests'),
    events: () => readEvents(metricsRoot(root)),
    research: () => listOf(j, ['issue', 'list', '--state', 'all', '--label', RESEARCH_LABEL, '--limit', '100', '--json', 'number,title,body,state,labels,assignees,comments'], 'research tasks'),
    discoveryStatus: () => loadDiscoveryStatus(root),
    doc: (rel) => mainDoc(root, rel) ?? '',
    // the PRD as it is in this folder: that is what crew kickoff --apply turns into tasks
    prdLocal: (rel = DEFAULT_PRD) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null),
    approvals: () => listOf(j, ['issue', 'list', '--label', PRD_APPROVAL_LABEL, '--state', 'all', '--limit', '20', '--json', 'number,comments'], 'PRD approvals'),
    captain: (name, args, deps) => captainCmds.find((c) => c.name === name).run(args, deps),
  };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const firstLine = (r) => (r.stderr || r.stdout || 'gh failed').split('\n')[0];

// Reads that several views make in one refresh (the board plus the open tab) share one gh call for a few seconds.
const READS = ['issues', 'prs', 'questions', 'team', 'claimComments', 'ideas', 'issue', 'lastCommitAt', 'closed', 'merged', 'events', 'research', 'discoveryStatus', 'doc', 'acting', 'approvals', 'prdLocal'];
/**
 * source with short-lived memoized reads; any write (edit, captain) clears it so the next read is fresh.
 * Only answers are kept: a read that throws is asked again next time.
 */
export function cachedSource(source, { ttlMs = 5000, now = () => Date.now() } = {}) {
  const memo = new Map();
  const out = { ...source, clear: () => memo.clear() };
  for (const name of READS) {
    if (typeof source[name] !== 'function') continue;
    out[name] = (...args) => {
      const key = name + JSON.stringify(args);
      const hit = memo.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = source[name](...args);
      memo.set(key, { at: now(), value });
      return value;
    };
  }
  for (const name of ['edit', 'captain']) {
    if (typeof source[name] !== 'function') continue;
    out[name] = (...args) => { try { return source[name](...args); } finally { memo.clear(); } };
  }
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);
/** Constant-time comparison of the per-run key. */
export function sameKey(given, token) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}
const MAX_BODY = 8192;

/** The HTTP handler (exported for tests: no network, any source). */
export function boardHandler({ source: rawSource, token, repo, config = {}, allowedHosts, now = () => Date.now(), cacheMs = 5000 }) {
  const source = cacheMs > 0 ? cachedSource(rawSource, { ttlMs: cacheMs }) : rawSource;
  let members = null;
  // cache only a real answer: a failed collaborators call would otherwise leave the assign list empty for good
  const getMembers = () => {
    if (members?.length) return members;
    const got = source.members();
    if (got?.length) members = got;
    return got ?? [];
  };
  // shown on the page; cached only when gh returned one
  let login = null;
  const getLogin = () => login ?? (login = source.login?.() || null);
  // A write is authorized as the account gh uses right now: someone may have switched gh accounts since the start.
  const freshLogin = () => { const l = source.login?.() || null; if (l) login = l; return l; };
  const freshMembers = () => { const got = source.members(); if (got?.length) { members = got; return got; } return getMembers(); };
  // Same lease rule as the sweep: a recent commit on the task branch counts as activity, not only crew markers.
  const commitsOf = (issues) => Object.fromEntries(issues.filter((i) => labelValue(i, 'status') === 'claimed').map((i) => [i.number, source.lastCommitAt?.(i.number) ?? null]));
  const board = () => {
    const issues = source.issues();
    const questions = source.questions?.() ?? [];
    const model = boardModel({ issues, prs: source.prs(), members: getMembers(), questions, team: source.team?.() ?? null, claimComments: source.claimComments?.() ?? {}, ideas: source.ideas?.() ?? [], lastCommits: commitsOf(issues), config, now: now() });
    const human_questions = questions.filter((q) => (q.labels ?? []).some((l) => l.name === 'needs-human')).length;
    return { ...model, paused: pauseView(issues), login: getLogin(), human_questions };
  };
  // the captain (as main's crew.config.json says, see run) or the acting captain; with no captain, a repo admin
  const mayApprove = (who) => (config.captain ? hasCaptainPowers(who, config, source.acting?.(config) ?? null) : !!who && !!source.isAdmin?.(who));
  const plan = () => {
    const text = source.prdLocal?.(DEFAULT_PRD) ?? null;
    if (text === null) return null;
    const rev = prdRevision(text);
    const rec = approvalFor((source.approvals?.() ?? []).flatMap((i) => i.comments ?? []), rev, mayApprove);
    const onMain = source.doc?.(DEFAULT_PRD) || null;
    return planView({ text, rev, approval: rec, mainRev: onMain ? prdRevision(onMain) : null, tasks: safeCount(text), file: DEFAULT_PRD, max: MAX_PRD_CHARS });
  };
  const views = {
    '/api/board': () => board(),
    '/api/task': (url) => {
      const n = Number(url.searchParams.get('n'));
      if (!Number.isInteger(n) || n <= 0) return { http: 400, error: 'bad issue number' };
      const issue = source.issue?.(n);
      if (!issue) return { http: 404, error: `#${n} not found` };
      const t = taskView(issue, { prs: source.prs(), config, now: now(), lastCommitAt: source.lastCommitAt?.(n) ?? null });
      // dependencies with their title and state, so the drawer says what the task waits for
      t.deps = t.after.map((a) => {
        const d = source.issue?.(a);
        return d ? { number: a, title: d.title, state: d.state ?? 'OPEN', status: labelValue(d, 'status') } : { number: a, title: null, state: null, status: null };
      });
      return t;
    },
    '/api/team': () => {
      const b = board();
      return teamView({ members: getMembers(), team: source.team?.() ?? null, columns: b.columns, claimComments: source.claimComments?.() ?? {}, closed: source.closed?.(7) ?? [], config, acting: source.acting?.(config) ?? null, now: now() });
    },
    '/api/inbox': () => inboxView({ ideas: source.ideas?.() ?? [], questions: source.questions?.() ?? [], now: now() }),
    '/api/discovery': () => ({
      ...discoveryView({ config, research: source.research?.() ?? [], status: source.discoveryStatus?.() ?? null, discoveryText: source.doc?.(DISCOVERY_DOC) ?? '', decisionsText: source.doc?.(DECISIONS_DOC) ?? '', now: now() }),
      plan: plan(),
    }),
    '/api/prs': () => prsView(source.prs(), { config, now: now() }),
    '/api/activity': () => {
      const b = board();
      return activityView({ closed: source.closed?.(7) ?? [], merged: source.merged?.(7) ?? [], events: source.events?.() ?? [], stale: b.digest.sections.find((s) => s.key === 'stale')?.lines ?? [], now: now() });
    },
  };
  // Actions that are not about one issue: the emergency stop, the captain role, approving the plan.
  const teamActions = {
    pause: (body) => {
      const why = String(body.reason ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || 'stopped from crew board';
      const who = freshLogin();
      const r = source.edit(['issue', 'create', '--title', `crew:pause — ${why}`, '--label', PAUSE_LABEL, '--body', `Emergency stop from crew board${who ? ` by @${who}` : ''}. Agents stop taking and claiming tasks while this issue is open. Close it (or press Resume on crew board) to go on.`]);
      return r.code === 0 ? { ok: true } : { error: firstLine(r) };
    },
    resume: (body) => {
      const open = pauseView(source.issues());
      if (!open.length) return { ok: true, noop: true };
      // Resume ends the stops the person saw: one opened after the page loaded may have a reason they have not read.
      if (!Array.isArray(body.issues) || !body.issues.every((x) => Number.isInteger(x) && x > 0)) return { http: 400, error: 'resume needs the stops the page showed (issues: [numbers])' };
      const seen = body.issues;
      const unseen = open.filter((p) => !seen.includes(p.number));
      if (unseen.length) return { http: 409, error: `a new stop was opened after this page loaded (${unseen.map((p) => `#${p.number} ${p.title}`).join('; ')}): read it, then press Resume again` };
      const who = freshLogin();
      for (const p of open) {
        const r = source.edit(['issue', 'close', String(p.number), '--comment', `Resumed from crew board${who ? ` by @${who}` : ''}.`]);
        if (r.code !== 0) return { error: firstLine(r) };
      }
      return { ok: true };
    },
    handoff: (body) => {
      const r = source.captain('captain handoff', { to: String(body.value ?? ''), hours: Number(body.hours) || 6 }, { config, login: freshLogin(), members: freshMembers(), gh: (args) => source.edit(args) });
      return r.status === 'error' ? { error: r.summary } : { ok: true, message: r.summary };
    },
    back: () => {
      const r = source.captain('captain back', {}, { config, login: freshLogin(), gh: (args) => source.edit(args) });
      return r.status === 'error' ? { error: r.summary } : { ok: true, message: r.summary };
    },
    // The captain approves the PRD revision they are looking at. The page sends the revision it showed: if the file
    // changed since, the approval would be for a text nobody read.
    'approve-plan': (body) => {
      const who = freshLogin();
      if (!who) return { error: 'gh did not say who is logged in: run gh auth status' };
      if (!mayApprove(who)) return { http: 403, error: `only the captain${config.captain ? ` @${config.captain}` : ''} (or the acting captain) approves the plan, and gh is logged in as @${who}` };
      const text = source.prdLocal?.(DEFAULT_PRD) ?? null;
      if (text === null) return { error: `${DEFAULT_PRD} is not in this folder` };
      if (text.length > MAX_PRD_CHARS) return { error: `${DEFAULT_PRD} is longer than the board shows (${MAX_PRD_CHARS} characters): nobody can read all of it here; shorten it` };
      const rev = prdRevision(text);
      if (String(body.rev ?? '') !== rev) return { http: 409, error: `${DEFAULT_PRD} changed after this page loaded (now revision ${shortRev(rev)}): read it again, then approve` };
      const list = source.approvals?.() ?? [];
      if (approvalFor(list.flatMap((i) => i.comments ?? []), rev, mayApprove).approved) return { ok: true, noop: true };
      let issue = list[0]?.number;
      if (!issue) {
        source.edit(['label', 'create', PRD_APPROVAL_LABEL, '--color', '0e8a16', '--description', 'PRD approvals: the captain approves one PRD revision; crew kickoff --apply needs it', '--force']);
        const c = source.edit(['issue', 'create', '--title', PRD_APPROVAL_TITLE, '--label', PRD_APPROVAL_LABEL, '--body', 'Each comment here approves one revision of the PRD (docs/prd.md). crew kickoff --apply creates tasks only from an approved revision; any edit to the PRD needs a new approval. Only the captain (or the acting captain) approves.']);
        if (c.code !== 0) return { error: firstLine(c) };
        issue = Number(/\/issues\/(\d+)/.exec(c.stdout ?? '')?.[1]);
        if (!Number.isInteger(issue)) return { error: 'gh created the approvals issue but did not say its number: press Approve again' };
      }
      const r = source.edit(['issue', 'comment', String(issue), '--body', approvalComment({ rev, login: who, file: DEFAULT_PRD, tasks: safeCount(text) })]);
      return r.code === 0 ? { ok: true, message: `plan revision ${shortRev(rev)} approved: crew kickoff --apply may create the tasks` } : { error: firstLine(r) };
    },
  };
  function act(res, body) {
    source.clear?.(); // decide on fresh data: the cache is for reads, not for the state a change is checked against
    if (Object.hasOwn(teamActions, String(body.op))) {
      const r = teamActions[body.op](body);
      return r.error ? json(res, r.http ?? 400, { error: r.error }) : json(res, 200, r);
    }
    const n = Number(body.issue);
    const current = source.issues().find((i) => i.number === n)
      ?? (body.op === 'answer' ? (source.questions?.() ?? []).find((i) => i.number === n) : undefined);
    // Release what the person saw: the page sends the lease it showed (agent and claim time). A new lease, even by the
    // same agent, is not released. A lease already freed by an earlier press whose label edit failed is completed.
    let labelsOnly = false;
    if (body.op === 'release' && current) {
      if (typeof body.expect !== 'string') return json(res, 400, { error: 'release needs the lease the page showed (expect)' });
      const owner = currentOwner(source.issue?.(n)?.comments ?? []);
      const holder = leaseId(owner);
      if (holder && body.expect !== holder) return json(res, 409, { error: `#${n} is held by ${owner.agent} under a newer lease now: reload and decide again` });
      labelsOnly = !holder && body.expect !== '';
    }
    const needsLogin = ['idea', 'release', 'answer'].includes(body.op);
    const a = actionArgs(body, current, { members: body.op === 'assign' ? freshMembers() : getMembers(), login: needsLogin ? freshLogin() : null, acting: body.op === 'idea' ? source.acting?.(config) ?? null : null, config });
    if (a.error) return json(res, 400, { error: a.error });
    if (a.noop) return json(res, 200, { ok: true, noop: true });
    const say = (r) => firstLine(r);
    if (labelsOnly) {
      const r = source.edit(a.args);
      return r.code === 0 ? json(res, 200, { ok: true, message: 'lease was already released; the task is back in Ready now' }) : json(res, 502, { error: `the labels did not change (${say(r)}): press it again` });
    }
    if (a.commentFirst) {
      // The release marker goes first: the task must never show as Ready while the old claim still holds it.
      const c = source.edit(['issue', 'comment', String(current.number), '--body', a.comment]);
      if (c.code !== 0) return json(res, 502, { error: `nothing changed: could not post the release note (${say(c)})` });
      const r = source.edit(a.args);
      return r.code === 0 ? json(res, 200, { ok: true }) : json(res, 502, { error: `the lease is released, but the labels did not change (${say(r)}): press it again` });
    }
    const r = source.edit(a.args);
    if (r.code !== 0) return json(res, 502, { error: say(r) });
    if (a.comment) {
      const c = source.edit(['issue', 'comment', String(current.number), '--body', a.comment]);
      if (c.code !== 0) return json(res, 502, { error: `changed on GitHub, but the note was not posted (${say(c)})` });
    }
    return json(res, 200, { ok: true });
  }
  async function handle(req, res) {
    if (!allowedHosts.includes(String(req.headers.host ?? '').toLowerCase())) return json(res, 403, { error: 'bad host' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
      if (!sameKey(url.searchParams.get('t'), token)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('crew board: open the full address that crew board printed in its terminal (it carries a one-time key for this run).');
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      });
      return res.end(renderPage({ token, repo }));
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (!sameKey(req.headers['x-crew-token'], token)) return json(res, 403, { error: 'bad key — reload the page from the address crew board printed' });
    if (req.method === 'GET' && Object.hasOwn(views, url.pathname)) {
      try {
        const out = views[url.pathname](url);
        return out?.http ? json(res, out.http, { error: out.error }) : json(res, 200, out);
      } catch (e) {
        return json(res, 502, { error: `crew board could not load this view: ${short(e)}` });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'json only' });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return json(res, 413, { error: 'too large' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!isPlainObject(body)) return json(res, 400, { error: 'the body must be a JSON object' });
      // a gh failure (network, auth, rate limit) answers 502; it must never take the whole board down
      try {
        return act(res, body);
      } catch (e) {
        return json(res, 502, { error: `gh failed: ${short(e)}` });
      }
    }
    return json(res, 404, { error: 'not found' });
  }
  // Nothing a request does may stop the server: an aborted upload or any other error ends that request only.
  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: `crew board: ${short(e)}` });
      else res.destroy();
    }
  };
}

/** One lease: who holds it and since when (a new claim by the same agent is a new lease). */
export const leaseId = (owner) => (owner ? `${owner.agent ?? '?'}@${owner.createdAt ?? owner.at ?? ''}` : '');

function safeCount(text) {
  try { return parsePrd(text).tasks.length; } catch { return null; }
}

export default {
  name: 'board',
  summary: "Captain's console for humans: kanban with drag and drop, task drawer, team and roles, inbox, discovery and plan approval, PRs, activity (no agent tokens)",
  agent: false,
  args: [{ name: 'port', type: 'number', description: 'port on 127.0.0.1 (default 4747)' }],
  async run({ port = 4747 } = {}) {
    const loaded = loadConfig();
    const { root } = loaded;
    // who approves the plan comes from main, not from this checkout (anyone can edit a local file)
    const config = { ...loaded.config, captain: mainCaptain(root, loaded.config) };
    const repo = ghJson(['repo', 'view', '--json', 'nameWithOwner'], { cwd: root, allowFail: true })?.nameWithOwner;
    if (!repo) return fail('no_repo', 'Not inside a GitHub repo that gh can see', { retry: 'run crew board in the project folder; gh auth status' });
    const token = randomBytes(16).toString('hex');
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const server = createServer(boardHandler({ source: githubSource(root), token, repo, config, allowedHosts }));
    const started = await new Promise((resolve) => {
      server.once('error', (e) => resolve(e));
      server.listen(port, '127.0.0.1', () => resolve(null));
    });
    if (started) return fail('port_busy', `Port ${port} is busy`, { cause_hint: started.message, retry: `crew board --port ${Number(port) + 1}` });
    // The key is in the address: only someone who can read this terminal can open the console.
    process.stderr.write(`crew board for ${repo}: http://127.0.0.1:${port}/?t=${token}  (Ctrl+C to stop; the address works for this run only)\n`);
    await new Promise((resolve) => process.once('SIGINT', resolve));
    server.close();
    return ok('Board stopped', { artifacts: { repo, port } });
  },
};
