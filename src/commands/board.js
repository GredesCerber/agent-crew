// crew board [--port 4747] — a local captain's console for humans: the kanban (drag and drop), a task drawer,
// Team & roles, Inbox, Discovery, Pull requests and Activity, plus manual steering through gh on this machine.
// No agent tokens are spent.
// Security: listens on 127.0.0.1 only, checks the Host header (DNS rebinding) and a random per-run token
// on every API call; page input never reaches gh unvalidated (src/core/board.js actionArgs).
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { ok, fail } from '../core/output.js';
import { gh, ghJson } from '../core/exec.js';
import { loadConfig } from '../core/config.js';
import { listIssues, PAUSE_LABEL } from '../core/issues.js';
import { boardModel, actionArgs, renderPage } from '../core/board.js';
import { taskView, teamView, inboxView, discoveryView, prsView, activityView, pauseView } from '../core/board-views.js';
import { readEvents, metricsRoot } from '../core/metrics.js';
import { RESEARCH_LABEL, DISCOVERY_DOC, DECISIONS_DOC } from '../core/discovery.js';
import { openQuestions, teamOf, claimCommentsOf } from './digest.js';
import { loadIdeas } from './idea.js';
import captainCmds, { loadActingCaptain } from './captain.js';
import { loadDiscoveryStatus, mainDoc } from './discover.js';
import { lastBranchCommitAt } from './task.js';

const PR_FIELDS = 'number,title,body,headRefOid,createdAt,isDraft,author,labels,comments,statusCheckRollup,mergeable,isCrossRepository,autoMergeRequest';
const since = (days, now = Date.now()) => new Date(now - days * 86400000).toISOString().slice(0, 10);

/** Live data from GitHub through gh (the server calls it on every refresh). */
export function githubSource(root) {
  const j = (args) => ghJson(args, { cwd: root, allowFail: true });
  return {
    issues: () => listIssues({ limit: 500 }),
    prs: () => j(['pr', 'list', '--state', 'open', '--limit', '50', '--json', PR_FIELDS]) ?? [],
    members: () => (gh(['api', 'repos/{owner}/{repo}/collaborators', '--paginate', '--jq', '.[].login'], { cwd: root, allowFail: true }).stdout || '').split('\n').filter(Boolean),
    edit: (args) => gh(args, { cwd: root, allowFail: true }),
    questions: () => openQuestions(root),
    team: () => teamOf(root),
    claimComments: () => claimCommentsOf(root),
    ideas: () => loadIdeas(root),
    login: () => (gh(['api', 'user', '--jq', '.login'], { cwd: root, allowFail: true }).stdout || '').trim() || null,
    acting: (config) => loadActingCaptain(root, config),
    issue: (n) => j(['issue', 'view', String(n), '--json', 'number,title,body,labels,assignees,comments,state,createdAt,updatedAt']),
    lastCommitAt: (n) => lastBranchCommitAt(n, root),
    closed: (days = 7) => j(['issue', 'list', '--state', 'closed', '--search', `closed:>=${since(days)}`, '--limit', '200', '--json', 'number,title,closedAt,assignees,labels']) ?? [],
    merged: (days = 7) => j(['pr', 'list', '--state', 'merged', '--search', `merged:>=${since(days)}`, '--limit', '100', '--json', 'number,title,mergedAt,mergedBy']) ?? [],
    events: () => readEvents(metricsRoot(root)),
    research: () => j(['issue', 'list', '--state', 'all', '--label', RESEARCH_LABEL, '--limit', '100', '--json', 'number,title,body,state,labels,assignees,comments']) ?? [],
    discoveryStatus: () => loadDiscoveryStatus(root),
    doc: (rel) => mainDoc(root, rel) ?? '',
    captain: (name, args, deps) => captainCmds.find((c) => c.name === name).run(args, deps),
  };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const firstLine = (r) => (r.stderr || r.stdout || 'gh failed').split('\n')[0];

/** The HTTP handler (exported for tests: no network, any source). */
export function boardHandler({ source, token, repo, config = {}, allowedHosts, now = () => Date.now() }) {
  let members = null;
  // cache only a real answer: a failed collaborators call would otherwise leave the assign list empty for good
  const getMembers = () => {
    if (members?.length) return members;
    const got = source.members();
    if (got?.length) members = got;
    return got ?? [];
  };
  let login;
  const getLogin = () => (login !== undefined ? login : (login = source.login?.() ?? null));
  const board = () => {
    const issues = source.issues();
    const questions = source.questions?.() ?? [];
    const model = boardModel({ issues, prs: source.prs(), members: getMembers(), questions, team: source.team?.() ?? null, claimComments: source.claimComments?.() ?? {}, ideas: source.ideas?.() ?? [], config, now: now() });
    const human_questions = questions.filter((q) => (q.labels ?? []).some((l) => l.name === 'needs-human')).length;
    return { ...model, paused: pauseView(issues), login: getLogin(), human_questions };
  };
  const views = {
    '/api/board': () => board(),
    '/api/task': (url) => {
      const n = Number(url.searchParams.get('n'));
      if (!Number.isInteger(n) || n <= 0) return { http: 400, error: 'bad issue number' };
      const issue = source.issue?.(n);
      if (!issue) return { http: 404, error: `#${n} not found` };
      return taskView(issue, { prs: source.prs(), config, now: now(), lastCommitAt: source.lastCommitAt?.(n) ?? null });
    },
    '/api/team': () => {
      const b = board();
      return teamView({ members: getMembers(), team: source.team?.() ?? null, columns: b.columns, claimComments: source.claimComments?.() ?? {}, closed: source.closed?.(7) ?? [], config, acting: source.acting?.(config) ?? null, now: now() });
    },
    '/api/inbox': () => inboxView({ ideas: source.ideas?.() ?? [], questions: source.questions?.() ?? [], now: now() }),
    '/api/discovery': () => discoveryView({ config, research: source.research?.() ?? [], status: source.discoveryStatus?.() ?? null, discoveryText: source.doc?.(DISCOVERY_DOC) ?? '', decisionsText: source.doc?.(DECISIONS_DOC) ?? '', now: now() }),
    '/api/prs': () => prsView(source.prs(), { config, now: now() }),
    '/api/activity': () => {
      const b = board();
      return activityView({ closed: source.closed?.(7) ?? [], merged: source.merged?.(7) ?? [], events: source.events?.() ?? [], stale: b.digest.sections.find((s) => s.key === 'stale')?.lines ?? [], now: now() });
    },
  };
  // Actions that are not about one issue: the emergency stop and the captain role.
  const teamActions = {
    pause: (body) => {
      const why = String(body.reason ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || 'stopped from crew board';
      const who = getLogin();
      const r = source.edit(['issue', 'create', '--title', `crew:pause — ${why}`, '--label', PAUSE_LABEL, '--body', `Emergency stop from crew board${who ? ` by @${who}` : ''}. Agents stop taking and claiming tasks while this issue is open. Close it (or press Resume on crew board) to go on.`]);
      return r.code === 0 ? { ok: true } : { error: firstLine(r) };
    },
    resume: () => {
      const open = pauseView(source.issues());
      if (!open.length) return { ok: true, noop: true };
      const who = getLogin();
      for (const p of open) {
        const r = source.edit(['issue', 'close', String(p.number), '--comment', `Resumed from crew board${who ? ` by @${who}` : ''}.`]);
        if (r.code !== 0) return { error: firstLine(r) };
      }
      return { ok: true };
    },
    handoff: (body) => {
      const r = source.captain('captain handoff', { to: String(body.value ?? ''), hours: Number(body.hours) || 6 }, { config, login: getLogin(), members: getMembers(), gh: (args) => source.edit(args) });
      return r.status === 'error' ? { error: r.summary } : { ok: true, message: r.summary };
    },
    back: () => {
      const r = source.captain('captain back', {}, { config, login: getLogin(), gh: (args) => source.edit(args) });
      return r.status === 'error' ? { error: r.summary } : { ok: true, message: r.summary };
    },
  };
  return async (req, res) => {
    if (!allowedHosts.includes(String(req.headers.host ?? '').toLowerCase())) return json(res, 403, { error: 'bad host' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
      return res.end(renderPage({ token, repo }));
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.headers['x-crew-token'] !== token) return json(res, 403, { error: 'bad token — reload the page from the URL crew board printed' });
    if (req.method === 'GET' && views[url.pathname]) {
      try {
        const out = views[url.pathname](url);
        return out?.http ? json(res, out.http, { error: out.error }) : json(res, 200, out);
      } catch (e) {
        return json(res, 500, { error: `crew board could not load this view: ${String(e?.message ?? e).split('\n')[0]}` });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'json only' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 8192) return json(res, 413, { error: 'too large' });
      }
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
      if (Object.hasOwn(teamActions, String(body.op))) {
        const r = teamActions[body.op](body);
        return r.error ? json(res, 400, { error: r.error }) : json(res, 200, r);
      }
      const current = source.issues().find((i) => i.number === Number(body.issue))
        ?? (body.op === 'answer' ? (source.questions?.() ?? []).find((i) => i.number === Number(body.issue)) : undefined);
      const needsLogin = ['idea', 'release', 'answer'].includes(body.op);
      const a = actionArgs(body, current, { members: getMembers(), login: needsLogin ? getLogin() : null, acting: body.op === 'idea' ? source.acting?.(config) ?? null : null, config });
      if (a.error) return json(res, 400, { error: a.error });
      if (a.noop) return json(res, 200, { ok: true, noop: true });
      const r = source.edit(a.args);
      if (r.code === 0 && a.comment) source.edit(['issue', 'comment', String(current.number), '--body', a.comment]);
      return r.code === 0 ? json(res, 200, { ok: true }) : json(res, 502, { error: firstLine(r) });
    }
    return json(res, 404, { error: 'not found' });
  };
}

export default {
  name: 'board',
  summary: "Captain's console for humans: kanban with drag and drop, task drawer, team and roles, inbox, discovery, PRs, activity (no agent tokens)",
  agent: false,
  args: [{ name: 'port', type: 'number', description: 'port on 127.0.0.1 (default 4747)' }],
  async run({ port = 4747 } = {}) {
    const { config, root } = loadConfig();
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
    process.stderr.write(`crew board for ${repo}: http://127.0.0.1:${port}/  (Ctrl+C to stop)\n`);
    await new Promise((resolve) => process.once('SIGINT', resolve));
    server.close();
    return ok('Board stopped', { artifacts: { repo, port } });
  },
};
