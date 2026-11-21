// 0.11: crew up looks before it writes, github setup keeps a repo's own rules, the captain approves one PRD revision
// on crew board, and the board fixes from the cross-vendor review (key on the page, fresh state for writes, release
// order, no crash on an aborted upload). No network: gh is a stub, the server runs on 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import up, { preflight } from '../src/commands/up.js';
import { mergeProtection, planSetup } from '../src/commands/github.js';
import { boardHandler, cachedSource } from '../src/commands/board.js';
import { prdRevision, approvalComment, approvalFor, PRD_APPROVAL_LABEL } from '../src/core/prd.js';
import { isDoneTask, activityView } from '../src/core/board-views.js';
import { parseMarkers } from '../src/core/issues.js';
import { digestModel } from '../src/core/digest.js';

const OKR = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const NO = (stderr = 'HTTP 404: Not Found') => ({ code: 1, stdout: '', stderr });
const L = (...names) => names.map((name) => ({ name }));

/** gh for preflight: table of answers by the first two arguments joined. */
function ghStub({ view = NO(), plan = OKR('free'), org = NO(), tools = true } = {}) {
  const calls = [];
  const sh = (cmd, args = []) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'gh') return tools ? OKR('1.0') : NO('not found');
    if (args[0] === 'repo' && args[1] === 'view') return view;
    if (args[0] === 'api' && /^orgs\/[^/]+\/memberships\//.test(args[1])) return org;
    if (args[0] === 'api' && (args[1] === 'user' || /^orgs\/[^/]+$/.test(args[1])) && args.includes('.plan.name')) return plan;
    return OKR();
  };
  return { sh, calls };
}
const me = { login: 'alice', id: '1' };

test('preflight: a new private repo on the free plan is a blocker, before anything is written', () => {
  const free = preflight({ repo: 'alice/shop' }, ghStub().sh, me);
  assert.equal(free.facts.protection, 'unavailable');
  assert.match(free.blockers[0], /main protection is unavailable \(private repo on the free plan\).*--public/);
  assert.equal(preflight({ repo: 'alice/shop', public: true }, ghStub().sh, me).facts.protection, 'available');
  assert.equal(preflight({ repo: 'alice/shop' }, ghStub({ plan: OKR('pro') }).sh, me).blockers.length, 0);
  // the plan could not be read: unverified, a warning, not "available"
  const unknown = preflight({ repo: 'alice/shop' }, ghStub({ plan: NO('HTTP 403') }).sh, me);
  assert.equal(unknown.facts.protection, 'unverified');
  assert.equal(unknown.blockers.length, 0);
  assert.ok(unknown.warnings.some((w) => /could not read the GitHub plan/.test(w)));
  // the person chose it knowingly
  const knowing = preflight({ repo: 'alice/shop', no_protection: true }, ghStub().sh, me);
  assert.equal(knowing.blockers.length, 0);
  assert.ok(knowing.warnings.some((w) => /unavailable/.test(w)));
});

test('preflight: rights and owner', () => {
  const notAdmin = preflight({ repo: 'acme/app' }, ghStub({ view: OKR(JSON.stringify({ visibility: 'PUBLIC', viewerPermission: 'WRITE' })) }).sh, me);
  assert.match(notAdmin.blockers[0], /you are WRITE on acme\/app: .*admin/);
  const foreign = preflight({ repo: 'bob/app', public: true }, ghStub().sh, me);
  assert.match(foreign.blockers[0], /cannot create repos under bob/);
  const org = preflight({ repo: 'acme/app', public: true }, ghStub({ org: OKR('member') }).sh, me);
  assert.equal(org.blockers.length, 0);
  // an existing private repo on the free plan: only a warning (it was set up before; crew up reports the manual step)
  const old = preflight({ repo: 'alice/old' }, ghStub({ view: OKR(JSON.stringify({ visibility: 'PRIVATE', viewerPermission: 'ADMIN' })) }).sh, me);
  assert.equal(old.blockers.length, 0);
  const noAgents = preflight({ repo: 'alice/x', public: true }, ghStub({ tools: false }).sh, me);
  assert.ok(noAgents.warnings.some((w) => /no agent found/.test(w)));
});

function upRun(gh) {
  const calls = [];
  const sh = (cmd, args = []) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh') {
      if (args[0] === '--version') return OKR('gh 2');
      if (args.join(' ') === 'auth status') return OKR();
      if (args[0] === 'api' && args[1] === 'user' && args.includes('.plan.name')) return gh.plan ?? OKR('free');
      if (args[0] === 'api' && args[1] === 'user') return OKR('alice 42');
      if (args[0] === 'repo' && args[1] === 'view') return NO('Could not resolve to a Repository');
      return OKR();
    }
    if (cmd === 'git') return OKR();
    return OKR('1.0');
  };
  return { sh, calls, wrote: () => calls.some((c) => (c[0] === 'git' && ['init', 'add', 'commit', 'push'].includes(c[1])) || (c[0] === 'gh' && ['create', 'edit'].includes(c[2])) || c.includes('-X')) };
}

test('crew up --check writes nothing; crew up on a free private repo stops before the first write', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'crew-pre-')), 'shop');
  const check = upRun({});
  const c = await up.run({ repo: 'alice/shop', dir, check: true }, { run: check.sh });
  assert.equal(c.error.code, 'preflight');
  assert.match(c.error.cause_hint, /main protection is unavailable/);
  assert.equal(check.wrote(), false);
  assert.equal(existsSync(dir), false, 'no project folder');
  const fine = await up.run({ repo: 'alice/shop', dir, check: true, public: true }, { run: upRun({}).sh });
  assert.ok(['success', 'warning'].includes(fine.status), JSON.stringify(fine));
  assert.equal(fine.artifacts.protection, 'available');
  assert.match(fine.summary, /nothing was changed/);
  const real = upRun({});
  const r = await up.run({ repo: 'alice/shop', dir }, { run: real.sh });
  assert.equal(r.error.code, 'preflight');
  assert.equal(real.wrote(), false);
  assert.equal(existsSync(dir), false);
});

test('github setup keeps the rules a repo already has: checks, reviews, flags; warns on linear history', () => {
  const ours = planSetup({ repo: 'a/b' }).at(-1).body;
  const none = mergeProtection(ours, null);
  assert.deepEqual(none.body, ours);
  const existing = {
    required_status_checks: { strict: true, contexts: ['build', 'check'], checks: [{ context: 'build', app_id: 15368 }, { context: 'check', app_id: 15368 }, { context: 'lint', app_id: null }] },
    required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true, dismiss_stale_reviews: false },
    enforce_admins: { enabled: true },
    required_linear_history: { enabled: true },
    restrictions: { users: [{ login: 'ops' }], teams: [], apps: [] },
  };
  const m = mergeProtection(ours, existing);
  assert.deepEqual(m.body.required_status_checks.checks.map((c) => c.context), ['check', 'crew-guard', 'build', 'lint']);
  assert.deepEqual(m.body.required_status_checks.checks.find((c) => c.context === 'lint'), { context: 'lint' }, 'no app id: any source');
  assert.equal(m.body.required_status_checks.strict, true);
  assert.equal(m.body.required_pull_request_reviews.required_approving_review_count, 2);
  assert.equal(m.body.required_pull_request_reviews.require_code_owner_reviews, true);
  assert.equal(m.body.enforce_admins, true);
  assert.deepEqual(m.body.restrictions, { users: ['ops'], teams: [], apps: [] });
  assert.ok(m.kept.includes('required check build') && m.kept.includes('2 approving review(s) from a person'));
  assert.match(m.warnings[0], /linear history/);
  assert.equal(ours.required_status_checks.checks.length, 2, 'the plan itself is not changed in place');
});

test('approvals: only the comment author counts, and only for the exact revision', () => {
  const rev = prdRevision('# Plan\n```crew-task\nid: T1\n```');
  const c = (login, body, assoc = 'MEMBER') => ({ body, author: { login }, authorAssociation: assoc, createdAt: '2026-11-21T10:00:00Z' });
  const cap = (l) => l === 'cap';
  assert.equal(approvalFor([c('cap', approvalComment({ rev, login: 'cap' }))], rev, cap).approved, true);
  assert.equal(approvalFor([c('bob', `<!-- crew:prd-approved rev=${rev} by=cap -->`)], rev, cap).approved, false, 'by= in the marker is ignored');
  assert.equal(approvalFor([c('cap', approvalComment({ rev, login: 'cap' }), 'NONE')], rev, cap).approved, false);
  const other = approvalFor([c('cap', approvalComment({ rev: 'aaaaaaaaaaaa', login: 'cap' }))], rev, cap);
  assert.deepEqual([other.approved, other.revs], [false, ['aaaaaaaaaaaa']]);
  assert.equal(prdRevision('a\r\nb'), prdRevision('a\nb'));
  assert.equal(prdRevision('<!-- crew:prd status: approved by: cap at: x -->\na'), prdRevision('a'));
  assert.notEqual(prdRevision('a'), prdRevision('a.'));
});

/** A board server over a mutable fake GitHub. */
async function board(t, state, opts = {}) {
  const edits = [];
  const source = {
    issues: () => state.issues,
    prs: () => state.prs ?? [],
    members: () => ['cap', 'bob'],
    login: () => state.login,
    issue: (n) => state.full?.[n] ?? null,
    prdLocal: () => state.prd ?? null,
    approvals: () => state.approvals ?? [],
    doc: () => '',
    edit: (args) => {
      edits.push(args);
      const r = state.fail?.(args) ?? OKR(args[1] === 'create' ? 'https://github.com/a/b/issues/77' : '');
      if (r.code === 0 && args[1] === 'comment' && args[2] === '77') (state.approvals ??= [{ number: 77, comments: [] }])[0].comments.push({ body: args[4], author: { login: state.login }, authorAssociation: 'OWNER' });
      return r;
    },
  };
  let port;
  let h;
  const server = createServer((req, res) => (h ??= boardHandler({ source, token: 'tok', repo: 'a/b', config: { captain: 'cap', ...opts.config }, allowedHosts: [`127.0.0.1:${port}`], cacheMs: 0 }))(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    edits,
    get: (p) => fetch(base + p, { headers: { 'x-crew-token': 'tok' } }),
    post: (body) => fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-crew-token': 'tok' }, body: JSON.stringify(body) }),
  };
}

test('crew board: the captain approves the revision they read; others and stale pages cannot', async (t) => {
  const prd = '# Plan\n```crew-task\nid: T1\ntitle: x\n```\n';
  const rev = prdRevision(prd);
  const state = { issues: [], login: 'bob', prd };
  const b = await board(t, state);
  const plan = (await (await b.get('/api/discovery')).json()).plan;
  assert.deepEqual([plan.rev, plan.approved], [rev, false]);
  const notCap = await b.post({ op: 'approve-plan', rev });
  assert.equal(notCap.status, 403);
  assert.match((await notCap.json()).error, /only the captain @cap/);
  state.login = 'cap';
  assert.equal((await b.post({ op: 'approve-plan', rev: 'old' })).status, 409, 'the page showed another text');
  const okr = await b.post({ op: 'approve-plan', rev });
  assert.equal(okr.status, 200, await okr.clone().text());
  assert.ok(b.edits.some((a) => a[0] === 'label' && a[2] === PRD_APPROVAL_LABEL), 'the label exists before the issue');
  assert.ok(b.edits.some((a) => a[1] === 'create' && a.includes(PRD_APPROVAL_LABEL)));
  assert.ok(b.edits.some((a) => a[1] === 'comment' && a[2] === '77' && a[4].includes(`crew:prd-approved rev=${rev}`)));
  const after = (await (await b.get('/api/discovery')).json()).plan;
  assert.deepEqual([after.approved, after.approved_by], [true, 'cap']);
  assert.equal((await (await b.post({ op: 'approve-plan', rev })).json()).noop, true, 'approving twice posts nothing');
  state.prd = prd + 'edit\n';
  const changed = (await (await b.get('/api/discovery')).json()).plan;
  assert.deepEqual([changed.approved, changed.changed_since], [false, true]);
});

test('crew board review fixes: page key, stale controls, fresh login, release order, aborted upload', async (t) => {
  const claimed = { number: 7, title: 'T', labels: L('status:claimed'), assignees: [{ login: 'bob' }], updatedAt: new Date().toISOString() };
  const state = {
    issues: [claimed, { number: 90, title: 'crew:pause — x', labels: L('crew:pause'), assignees: [] }],
    login: 'cap',
    full: { 7: { ...claimed, comments: [{ body: '<!-- crew:claim agent=codex@b -->', author: { login: 'bob' }, authorAssociation: 'MEMBER' }] } },
  };
  const b = await board(t, state);
  // the page itself needs the key
  assert.equal((await fetch(`http://127.0.0.1:${b.port}/`)).status, 403);
  // release what the person saw: someone else holds it now
  const stale = await b.post({ op: 'release', issue: 7, expect: 'claude@a' });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /held by codex@b now/);
  // the marker goes first; if it cannot be posted, nothing changes
  state.fail = (args) => (args[1] === 'comment' ? NO('HTTP 502') : null);
  const noNote = await b.post({ op: 'release', issue: 7, expect: 'codex@b' });
  assert.equal(noNote.status, 502);
  assert.match((await noNote.json()).error, /nothing changed/);
  assert.ok(!b.edits.some((a) => a[1] === 'edit'), 'labels untouched');
  // the note is posted but the labels fail: say so, the release can be pressed again
  state.fail = (args) => (args[1] === 'edit' ? NO('HTTP 502') : null);
  const half = await b.post({ op: 'release', issue: 7, expect: 'codex@b' });
  assert.match((await half.json()).error, /lease is released, but the labels did not change/);
  state.fail = null;
  // a pause opened after the page loaded is not closed by Resume
  const r = await b.post({ op: 'resume', issues: [] });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /#90/);
  assert.equal((await b.post({ op: 'resume', issues: [90] })).status, 200);
  // the login is read again for every write
  state.login = 'bob';
  state.issues.push({ number: 30, title: 'Idea: x', labels: L('crew:idea'), assignees: [] });
  const idea = await b.post({ op: 'idea', issue: 30, value: 'accept' });
  assert.equal(idea.status, 400);
  assert.match((await idea.json()).error, /logged in as bob/);
  // an upload that is cut off does not stop the server
  await new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: b.port, path: '/api/action', method: 'POST', headers: { host: `127.0.0.1:${b.port}`, 'content-type': 'application/json', 'x-crew-token': 'tok', 'content-length': '500' } });
    req.on('error', () => resolve());
    req.write('{"op":');
    setTimeout(() => { req.destroy(); resolve(); }, 30);
  });
  assert.equal((await b.get('/api/board')).status, 200, 'still serving');
});

test('a failed read is an error, not an empty list, and is not cached', () => {
  let n = 0;
  const src = cachedSource({ prs: () => { n++; throw new Error('gh could not read open pull requests'); } }, { ttlMs: 5000, now: () => 0 });
  assert.throws(() => src.prs(), /could not read/);
  assert.throws(() => src.prs(), /could not read/);
  assert.equal(n, 2, 'asked again');
});

test('markers: a field cannot change the kind; done work excludes housekeeping closures; stale leases count commits', () => {
  const [m] = parseMarkers([{ body: '<!-- crew:heartbeat kind=release by=mallory -->', author: { login: 'bob' }, authorAssociation: 'MEMBER' }]);
  assert.deepEqual([m.kind, m.by], ['heartbeat', 'bob']);
  assert.equal(isDoneTask({ stateReason: 'COMPLETED', labels: L('status:review') }), true);
  assert.equal(isDoneTask({ stateReason: 'NOT_PLANNED', labels: [] }), false);
  assert.equal(isDoneTask({ stateReason: 'COMPLETED', labels: L('crew:question') }), false);
  assert.equal(isDoneTask({ stateReason: 'COMPLETED', labels: L('crew:pause') }), false);
  const now = Date.parse('2026-11-21T12:00:00Z');
  const v = activityView({ closed: [{ number: 1, title: 'a', closedAt: new Date(now - 60000).toISOString(), labels: L('crew:idea'), stateReason: 'NOT_PLANNED' }], now });
  assert.equal(v.done_total, 0);
  const issue = { number: 5, title: 'T', labels: L('status:claimed'), assignees: [], updatedAt: new Date(now - 90 * 60000).toISOString() };
  const claim = { 5: [{ body: '<!-- crew:claim agent=a -->', createdAt: new Date(now - 90 * 60000).toISOString() }] };
  const quiet = digestModel({ issues: [issue], claimComments: claim, config: { lease_minutes: 45 }, now });
  assert.equal(quiet.counts.stale, 1);
  const pushing = digestModel({ issues: [issue], claimComments: claim, lastCommits: { 5: new Date(now - 60000).toISOString() }, config: { lease_minutes: 45 }, now });
  assert.equal(pushing.counts.stale, 0, 'a commit a minute ago keeps the lease alive, as the sweep sees it');
});
