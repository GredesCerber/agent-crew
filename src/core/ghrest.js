// gh issue / gh pr / gh repo / gh label over the REST API, for where GitHub GraphQL is not reachable (Claude Code
// cloud sessions: their GitHub proxy lets only `gh api` REST calls through). crew keeps calling `gh issue list ...`;
// exec.js routes the call here, and the answer has the same JSON shape `gh --json` gives (only the fields crew uses).
// api(method, path, body) → { code, data, stderr } is passed in, so this module has no I/O of its own and tests stub it.

const VALUE_FLAGS = new Set(['--state', '--label', '--limit', '--json', '--search', '--title', '--body', '--body-file', '--assignee',
  '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--reason', '--comment', '--head', '--base', '--color',
  '--description', '-q', '--jq', '--match-head-commit', '-R', '--repo']);
const LIST_FLAGS = new Set(['--label', '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--assignee']);

/** ['issue', 'list', '--label', 'a,b', '--json', 'x'] → { group, verb, target, flags: { '--label': ['a','b'], ... } } */
export function parseGhArgs(args) {
  const [group, verb, ...rest] = args;
  const flags = {};
  let target = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE_FLAGS.has(a)) {
      const v = rest[++i] ?? '';
      if (LIST_FLAGS.has(a)) (flags[a] ??= []).push(...String(v).split(',').map((s) => s.trim()).filter(Boolean));
      else flags[a] = v;
    } else if (a.startsWith('-')) flags[a] = true;
    else if (target === null) target = a;
  }
  return { group, verb, target, flags };
}

const up = (s) => (s == null ? null : String(s).toUpperCase());
const fieldsOf = (flags) => String(flags['--json'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const pick = (obj, fields) => (fields.length ? Object.fromEntries(fields.map((f) => [f, obj[f] ?? null])) : obj);
const numberOf = (target) => Number(/(\d+)\/?$/.exec(String(target ?? ''))?.[1]);

/** The subset of jq crew uses: '.a.b' paths. */
function jq(expr, value) {
  if (!/^(\.[A-Za-z_][\w]*)+$/.test(expr)) return { error: `jq expression not supported over REST: ${expr}` };
  let v = value;
  for (const k of expr.slice(1).split('.')) v = v?.[k];
  return { value: v };
}

function output(value, flags) {
  const expr = flags['-q'] ?? flags['--jq'];
  if (expr) {
    const r = jq(expr, value);
    if (r.error) return { code: 1, stdout: '', stderr: r.error };
    return { code: 0, stdout: typeof r.value === 'string' ? r.value : JSON.stringify(r.value ?? null), stderr: '' };
  }
  return { code: 0, stdout: JSON.stringify(value), stderr: '' };
}

const fail = (stderr) => ({ code: 1, stdout: '', stderr });

/**
 * Run one gh issue/pr/repo/label command over REST. → { code, stdout, stderr }, or null when the command is not one
 * this layer knows (the caller then runs the real gh).
 */
export function ghViaRest(args, { api, input } = {}) {
  const p = parseGhArgs(args);
  const ctx = new Ctx(api);
  const handler = HANDLERS[`${p.group} ${p.verb}`];
  if (!handler) return null;
  try {
    return handler(p, ctx, input);
  } catch (e) {
    return fail(String(e?.message ?? e));
  }
}

class Ctx {
  constructor(api) { this.api = api; this.cache = new Map(); }
  call(method, path, body) {
    const r = this.api(method, path, body);
    if (r.code !== 0) throw new Error((r.stderr || `gh api ${method} ${path} failed`).split('\n')[0]);
    return r.data;
  }
  tryCall(method, path, body) { return this.api(method, path, body); }
  once(key, fn) { if (!this.cache.has(key)) this.cache.set(key, fn()); return this.cache.get(key); }
  repo() { return this.once('repo', () => this.call('GET', 'repos/{owner}/{repo}')); }
  login() { return this.once('login', () => this.call('GET', 'user').login); }
  /** Every page of a list endpoint, up to limit items. */
  pages(path, limit = 1000, keep = () => true) {
    const out = [];
    for (let page = 1; out.length < limit && page <= 50; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = this.call('GET', `${path}${sep}per_page=100&page=${page}`);
      const items = Array.isArray(batch) ? batch : batch?.items ?? [];
      out.push(...items.filter(keep));
      if (items.length < 100) break;
    }
    return out.slice(0, limit);
  }
  comments(n) {
    return this.once(`comments ${n}`, () => this.pages(`repos/{owner}/{repo}/issues/${n}/comments`).map((c) => ({
      body: c.body ?? '', author: { login: c.user?.login ?? null }, authorAssociation: c.author_association ?? null, createdAt: c.created_at,
    })));
  }
  /** "a,b" or ['a'] with @me → logins */
  logins(list) { return (list ?? []).map((l) => (l === '@me' ? this.login() : l)); }
}

/* ---------- issues ---------- */

function issueShape(i, fields, ctx) {
  const all = {
    number: i.number,
    title: i.title,
    body: i.body ?? '',
    state: up(i.state),
    stateReason: up(i.state_reason),
    labels: (i.labels ?? []).map((l) => ({ name: typeof l === 'string' ? l : l.name })),
    assignees: (i.assignees ?? []).map((a) => ({ login: a.login })),
    author: { login: i.user?.login ?? null },
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.closed_at ?? null,
    url: i.html_url,
  };
  if (fields.includes('comments')) all.comments = ctx.comments(i.number);
  return pick(all, fields);
}

const stateParam = (s) => (s === 'all' || s === 'closed' ? s : 'open');

function issueList(p, ctx) {
  const fields = fieldsOf(p.flags);
  const limit = Number(p.flags['--limit']) || 30;
  const state = p.flags['--state'] ?? 'open';
  if (p.flags['--search']) {
    const q = [`repo:${ctx.repo().full_name}`, 'is:issue', state === 'all' ? '' : `is:${state}`, ...(p.flags['--label'] ?? []).map((l) => `label:"${l}"`), p.flags['--search']].filter(Boolean).join(' ');
    return output(ctx.pages(`search/issues?q=${encodeURIComponent(q)}`, limit).map((i) => issueShape(i, fields, ctx)), p.flags);
  }
  const labels = (p.flags['--label'] ?? []).join(',');
  const path = `repos/{owner}/{repo}/issues?state=${stateParam(state)}${labels ? `&labels=${encodeURIComponent(labels)}` : ''}`;
  // the issues endpoint returns PRs too: gh issue list does not
  const items = ctx.pages(path, limit, (i) => !i.pull_request);
  return output(items.map((i) => issueShape(i, fields, ctx)), p.flags);
}

function issueView(p, ctx) {
  const i = ctx.call('GET', `repos/{owner}/{repo}/issues/${numberOf(p.target)}`);
  return output(issueShape(i, fieldsOf(p.flags), ctx), p.flags);
}

const bodyOf = (p, input) => (p.flags['--body-file'] === '-' ? input ?? '' : p.flags['--body'] ?? '');

function issueCreate(p, ctx, input) {
  const i = ctx.call('POST', 'repos/{owner}/{repo}/issues', {
    title: p.flags['--title'] ?? '',
    body: bodyOf(p, input),
    labels: p.flags['--label'] ?? [],
    assignees: ctx.logins(p.flags['--assignee']),
  });
  return { code: 0, stdout: i.html_url, stderr: '' };
}

function issueEdit(p, ctx, input) {
  const n = numberOf(p.target);
  const base = `repos/{owner}/{repo}/issues/${n}`;
  const patch = {};
  if (p.flags['--title'] !== undefined) patch.title = p.flags['--title'];
  if (p.flags['--body'] !== undefined || p.flags['--body-file'] !== undefined) patch.body = bodyOf(p, input);
  if (Object.keys(patch).length) ctx.call('PATCH', base, patch);
  if (p.flags['--add-label']?.length) ctx.call('POST', `${base}/labels`, { labels: p.flags['--add-label'] });
  for (const l of p.flags['--remove-label'] ?? []) {
    const r = ctx.tryCall('DELETE', `${base}/labels/${encodeURIComponent(l)}`);
    if (r.code !== 0 && !/404|not found/i.test(r.stderr ?? '')) throw new Error(r.stderr);
  }
  if (p.flags['--add-assignee']?.length) ctx.call('POST', `${base}/assignees`, { assignees: ctx.logins(p.flags['--add-assignee']) });
  if (p.flags['--remove-assignee']?.length) ctx.call('DELETE', `${base}/assignees`, { assignees: ctx.logins(p.flags['--remove-assignee']) });
  return { code: 0, stdout: `https://github.com/${ctx.repo().full_name}/issues/${n}`, stderr: '' };
}

function comment(p, ctx, input) {
  const n = numberOf(p.target);
  const c = ctx.call('POST', `repos/{owner}/{repo}/issues/${n}/comments`, { body: bodyOf(p, input) });
  return { code: 0, stdout: c.html_url ?? '', stderr: '' };
}

function issueClose(p, ctx) {
  const n = numberOf(p.target);
  if (p.flags['--comment']) ctx.call('POST', `repos/{owner}/{repo}/issues/${n}/comments`, { body: p.flags['--comment'] });
  const reason = /not planned/i.test(String(p.flags['--reason'] ?? '')) ? 'not_planned' : 'completed';
  ctx.call('PATCH', `repos/{owner}/{repo}/issues/${n}`, { state: 'closed', state_reason: reason });
  return { code: 0, stdout: '', stderr: '' };
}

/** Pinning exists only in GraphQL: the issue stays unpinned, nothing else depends on it. */
const issuePin = () => ({ code: 0, stdout: '', stderr: 'pinning needs GitHub GraphQL: skipped here' });

/* ---------- pull requests ---------- */

function rollup(ctx, sha) {
  if (!sha) return [];
  const runs = ctx.tryCall('GET', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`);
  const statuses = ctx.tryCall('GET', `repos/{owner}/{repo}/commits/${sha}/statuses?per_page=100`);
  // one row per check name, its latest run (gh pr checks does the same; reruns of a workflow add older runs here)
  const latest = new Map();
  for (const c of runs.data?.check_runs ?? []) {
    const t = Date.parse(c.started_at ?? c.completed_at ?? '') || 0;
    const had = latest.get(c.name);
    if (!had || t > had.t) latest.set(c.name, { t, c });
  }
  const out = [...latest.values()].map(({ c }) => ({ name: c.name, status: up(c.status), conclusion: up(c.conclusion) ?? '', detailsUrl: c.details_url ?? c.html_url }));
  const seen = new Set();
  for (const s of Array.isArray(statuses.data) ? statuses.data : []) {
    if (seen.has(s.context)) continue; // newest first: the latest state of each context
    seen.add(s.context);
    out.push({ context: s.context, state: up(s.state), description: s.description ?? '', targetUrl: s.target_url ?? null });
  }
  return out;
}

function prShape(pr, fields, ctx) {
  const need = (f) => fields.length === 0 || fields.includes(f);
  const detail = need('mergeable') || need('mergedBy') ? ctx.once(`pr ${pr.number}`, () => ctx.call('GET', `repos/{owner}/{repo}/pulls/${pr.number}`)) : pr;
  const all = {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state: pr.merged_at ? 'MERGED' : up(pr.state),
    url: pr.html_url,
    headRefOid: pr.head?.sha ?? null,
    headRefName: pr.head?.ref ?? null,
    baseRefOid: pr.base?.sha ?? null,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at ?? null,
    isDraft: !!pr.draft,
    author: { login: pr.user?.login ?? null },
    labels: (pr.labels ?? []).map((l) => ({ name: l.name })),
    isCrossRepository: !!pr.head?.repo && !!pr.base?.repo && pr.head.repo.full_name !== pr.base.repo.full_name,
    autoMergeRequest: pr.auto_merge ? { enabledAt: null, mergeMethod: up(pr.auto_merge.merge_method) } : null,
    mergeable: detail.mergeable === true ? 'MERGEABLE' : detail.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    mergedBy: detail.merged_by ? { login: detail.merged_by.login } : null,
  };
  if (need('comments')) all.comments = ctx.comments(pr.number);
  if (need('statusCheckRollup')) all.statusCheckRollup = rollup(ctx, pr.head?.sha);
  if (need('commits')) {
    all.commits = ctx.pages(`repos/{owner}/{repo}/pulls/${pr.number}/commits`).map((c) => {
      const [headline, ...rest] = String(c.commit?.message ?? '').split('\n');
      return { oid: c.sha, messageHeadline: headline, messageBody: rest.join('\n').trim() };
    });
  }
  return pick(all, fields);
}

function prList(p, ctx) {
  const fields = fieldsOf(p.flags);
  const limit = Number(p.flags['--limit']) || 30;
  const state = p.flags['--state'] ?? 'open';
  if (p.flags['--search'] || state === 'merged') {
    const q = [`repo:${ctx.repo().full_name}`, 'is:pr', state === 'merged' ? 'is:merged' : state === 'all' ? '' : `is:${state}`, p.flags['--search'] ?? ''].filter(Boolean).join(' ');
    const found = ctx.pages(`search/issues?q=${encodeURIComponent(q)}`, limit);
    const prs = found.map((i) => ctx.once(`pr ${i.number}`, () => ctx.call('GET', `repos/{owner}/{repo}/pulls/${i.number}`)));
    return output(prs.map((pr) => prShape(pr, fields, ctx)), p.flags);
  }
  const prs = ctx.pages(`repos/{owner}/{repo}/pulls?state=${stateParam(state)}`, limit);
  return output(prs.map((pr) => prShape(pr, fields, ctx)), p.flags);
}

/** A PR by number, URL or head branch. */
function findPr(ctx, target) {
  const n = numberOf(target);
  if (Number.isInteger(n) && /^\d+$|\/pull\/\d+/.test(String(target))) return ctx.call('GET', `repos/{owner}/{repo}/pulls/${n}`);
  const owner = ctx.repo().full_name.split('/')[0];
  const list = ctx.call('GET', `repos/{owner}/{repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${target}`)}&per_page=10`);
  if (!Array.isArray(list) || !list.length) throw new Error(`no pull requests found for branch "${target}"`);
  return list[0];
}

function prView(p, ctx) {
  return output(prShape(findPr(ctx, p.target), fieldsOf(p.flags), ctx), p.flags);
}

function prCreate(p, ctx, input) {
  const pr = ctx.call('POST', 'repos/{owner}/{repo}/pulls', {
    title: p.flags['--title'] ?? '',
    head: p.flags['--head'],
    base: p.flags['--base'] ?? ctx.repo().default_branch,
    body: bodyOf(p, input),
    draft: !!p.flags['--draft'],
  });
  return { code: 0, stdout: pr.html_url, stderr: '' };
}

function prEdit(p, ctx, input) {
  const pr = findPr(ctx, p.target);
  return issueEdit({ ...p, target: String(pr.number) }, ctx, input);
}

function prComment(p, ctx, input) {
  const pr = findPr(ctx, p.target);
  return comment({ ...p, target: String(pr.number) }, ctx, input);
}

function prMerge(p, ctx) {
  // auto-merge is a GraphQL-only feature: crew merge-ready (CI or crew tick) merges the PR once it is ready
  if (p.flags['--auto']) return fail('auto-merge needs GitHub GraphQL, which this environment blocks: crew merge-ready merges the PR when its checks and review are green');
  const pr = findPr(ctx, p.target);
  const method = p.flags['--squash'] ? 'squash' : p.flags['--rebase'] ? 'rebase' : 'merge';
  const body = { merge_method: method, ...(p.flags['--match-head-commit'] ? { sha: p.flags['--match-head-commit'] } : {}) };
  ctx.call('PUT', `repos/{owner}/{repo}/pulls/${pr.number}/merge`, body);
  // --delete-branch: branch deletion is refused by some proxies; a leftover branch is harmless
  if (p.flags['--delete-branch'] && pr.head?.ref) ctx.tryCall('DELETE', `repos/{owner}/{repo}/git/refs/heads/${encodeURIComponent(pr.head.ref)}`);
  return { code: 0, stdout: '', stderr: '' };
}

function prChecks(p, ctx) {
  const pr = findPr(ctx, p.target);
  const bucket = (c) => {
    const s = String(c.conclusion || c.state || c.status || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL'].includes(s)) return 'pass';
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) return 'fail';
    if (s === 'SKIPPED') return 'skipping';
    if (s === 'CANCELLED') return 'cancel';
    return 'pending';
  };
  const rows = rollup(ctx, pr.head?.sha).map((c) => ({ name: c.name ?? c.context, state: c.conclusion || c.state || c.status, bucket: bucket(c), link: c.detailsUrl ?? c.targetUrl ?? '' }));
  return output(rows.map((r) => pick(r, fieldsOf(p.flags))), p.flags);
}

/* ---------- repo, labels ---------- */

const PERMISSION = (perms = {}) => (perms.admin ? 'ADMIN' : perms.maintain ? 'MAINTAIN' : perms.push ? 'WRITE' : perms.triage ? 'TRIAGE' : perms.pull ? 'READ' : null);

function repoView(p, ctx) {
  const r = p.target ? ctx.call('GET', `repos/${p.target}`) : ctx.repo();
  const all = {
    nameWithOwner: r.full_name,
    defaultBranchRef: { name: r.default_branch },
    visibility: up(r.visibility ?? (r.private ? 'private' : 'public')),
    viewerPermission: PERMISSION(r.permissions),
  };
  return output(pick(all, fieldsOf(p.flags)), p.flags);
}

function labelList(p, ctx) {
  const labels = ctx.pages('repos/{owner}/{repo}/labels', Number(p.flags['--limit']) || 1000);
  return output(labels.map((l) => pick({ name: l.name, color: l.color, description: l.description ?? '' }, fieldsOf(p.flags))), p.flags);
}

function labelCreate(p, ctx) {
  const body = { name: p.target, color: String(p.flags['--color'] ?? 'ededed').replace(/^#/, ''), description: p.flags['--description'] ?? '' };
  const r = ctx.tryCall('POST', 'repos/{owner}/{repo}/labels', body);
  if (r.code === 0) return { code: 0, stdout: '', stderr: '' };
  if (p.flags['--force'] && /422|already_exists|already exists/i.test(r.stderr ?? '')) {
    ctx.call('PATCH', `repos/{owner}/{repo}/labels/${encodeURIComponent(p.target)}`, { new_name: p.target, color: body.color, description: body.description });
    return { code: 0, stdout: '', stderr: '' };
  }
  return fail(r.stderr);
}

const HANDLERS = {
  'issue list': issueList,
  'issue view': issueView,
  'issue create': issueCreate,
  'issue edit': issueEdit,
  'issue comment': comment,
  'issue close': issueClose,
  'issue pin': issuePin,
  'pr list': prList,
  'pr view': prView,
  'pr create': prCreate,
  'pr edit': prEdit,
  'pr comment': prComment,
  'pr merge': prMerge,
  'pr checks': prChecks,
  'repo view': repoView,
  'label list': labelList,
  'label create': labelCreate,
};

/** Which gh commands this layer answers (for docs and tests). */
export const REST_COMMANDS = Object.keys(HANDLERS);
