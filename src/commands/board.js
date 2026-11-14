// crew board [--port 4747] — a local task board for humans: the queue by status, PRs waiting, and
// manual steering (assignee, status, priority) through gh on this machine. No agent tokens are spent.
// Security: listens on 127.0.0.1 only, checks the Host header (DNS rebinding) and a random per-run token
// on every API call; page input never reaches gh unvalidated (src/core/board.js actionArgs).
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { ok, fail } from '../core/output.js';
import { gh, ghJson } from '../core/exec.js';
import { loadConfig } from '../core/config.js';
import { listIssues } from '../core/issues.js';
import { boardModel, actionArgs, renderPage } from '../core/board.js';
import { openQuestions, teamOf, claimCommentsOf } from './digest.js';

const PR_FIELDS = 'number,title,body,headRefOid,createdAt,isDraft,author,labels,comments,statusCheckRollup,mergeable,isCrossRepository,autoMergeRequest';

/** Live data from GitHub through gh (the server calls it on every refresh). */
export function githubSource(root) {
  return {
    issues: () => listIssues({ limit: 500 }),
    prs: () => ghJson(['pr', 'list', '--state', 'open', '--limit', '50', '--json', PR_FIELDS], { cwd: root, allowFail: true }) ?? [],
    members: () => (gh(['api', 'repos/{owner}/{repo}/collaborators', '--paginate', '--jq', '.[].login'], { cwd: root, allowFail: true }).stdout || '').split('\n').filter(Boolean),
    edit: (args) => gh(args, { cwd: root, allowFail: true }),
    questions: () => openQuestions(root),
    team: () => teamOf(root),
    claimComments: () => claimCommentsOf(root),
  };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** The HTTP handler (exported for tests: no network, any source). */
export function boardHandler({ source, token, repo, config = {}, allowedHosts }) {
  let members = null;
  // cache only a real answer: a failed collaborators call would otherwise leave the assign list empty for good
  const getMembers = () => {
    if (members?.length) return members;
    const got = source.members();
    if (got?.length) members = got;
    return got ?? [];
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
    if (req.method === 'GET' && url.pathname === '/api/board') {
      return json(res, 200, boardModel({ issues: source.issues(), prs: source.prs(), members: getMembers(), questions: source.questions?.() ?? [], team: source.team?.() ?? null, claimComments: source.claimComments?.() ?? {}, config }));
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'json only' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4096) return json(res, 413, { error: 'too large' });
      }
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
      const current = source.issues().find((i) => i.number === Number(body.issue));
      const a = actionArgs(body, current, { members: getMembers() });
      if (a.error) return json(res, 400, { error: a.error });
      if (a.noop) return json(res, 200, { ok: true, noop: true });
      const r = source.edit(a.args);
      if (r.code === 0 && a.comment) source.edit(['issue', 'comment', String(current.number), '--body', a.comment]);
      return r.code === 0 ? json(res, 200, { ok: true }) : json(res, 502, { error: (r.stderr || r.stdout || 'gh failed').split('\n')[0] });
    }
    return json(res, 404, { error: 'not found' });
  };
}

export default {
  name: 'board',
  summary: 'Local task board for humans: queue by status, PRs waiting, set assignee/status/priority by hand (no agent tokens)',
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
