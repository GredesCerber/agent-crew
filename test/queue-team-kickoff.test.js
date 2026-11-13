// Findings of the 9.11 rehearsal (a real project): PRs without a review stalled the queue, kickoff got confused by closed issues,
// two people made the plan, the PRD did not reach main, human roles were not set. No network and no GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePrd, lintPrd, planKickoff, areaOwners, teamReviewers } from '../src/core/prd.js';
import { prQueue, taskOrder, prChecks } from '../src/core/queue.js';
import { runKickoff, publishPlan } from '../src/commands/kickoff.js';
import task from '../src/commands/task.js';
import { mainProtected } from '../src/commands/pr.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

const next = task.find((c) => c.name === 'task next');
const AREAS = DEFAULT_CONFIG.areas;
const APPROVED = '<!-- crew:prd status: approved by: cap at: 2026-11-10T08:00:00Z -->\n';
const block = (kind, lines) => ['```crew-' + kind, ...lines, '```', ''].join('\n');
const t = (id, area, extra = []) => block('task', [`id: ${id}`, `title: Task ${id}`, `area: ${area}`, 'tier: mid', `goal: goal ${id}`, 'acceptance:', `  - Given A When B Then C ${id}`, ...extra]);
const skel = block('task', ['id: T1', 'title: Skeleton', 'area: infra', 'tier: high', 'risk: high', 'skeleton: true', 'goal: skeleton', 'acceptance:', '  - Given repo When start Then health ok', 'tests: [e2e]']);
const team = (...lines) => block('team', lines);
const PRD = (teamBlock) => APPROVED + teamBlock + skel + t('T2', 'api') + t('T3', 'web') + t('T4', 'design');
const rules = (r) => [...r.errors, ...r.warnings].map((e) => e.rule);

test('crew-team: area owners, the reviewer, task assignment', () => {
  const p = parsePrd(PRD(team('cap: api, infra, review  # captain', 'bob: web', 'dana: design')));
  assert.deepEqual(areaOwners(p.team), { api: 'cap', infra: 'cap', web: 'bob', design: 'dana' });
  assert.deepEqual(teamReviewers(p.team), ['cap']);
  const lint = lintPrd(p, { areas: AREAS });
  assert.deepEqual(lint.errors, [], JSON.stringify(lint.errors));
  const plan = planKickoff(p, []);
  const who = Object.fromEntries(plan.ops.filter((o) => o.op === 'create').map((o) => [o.id, o.assignee]));
  assert.deepEqual(who, { T1: 'cap', T2: 'cap', T3: 'bob', T4: 'dana' });
});

test('crew-team: an area without an owner, two owners, a duplicate, a foreign area - errors; no reviewer and no tasks - warnings', () => {
  const noOwner = lintPrd(parsePrd(PRD(team('cap: api, infra, review', 'bob: web'))), { areas: AREAS });
  assert.ok(rules(noOwner).includes('area_no_owner'), 'design has no owner');
  const two = lintPrd(parsePrd(PRD(team('cap: api, infra, web, review', 'bob: web', 'dana: design'))), { areas: AREAS });
  assert.ok(rules(two).includes('area_two_owners'));
  const dup = lintPrd(parsePrd(PRD(team('cap: api, infra, review', 'cap: web', 'dana: design'))), { areas: AREAS });
  assert.ok(rules(dup).includes('team_duplicate'));
  const unknown = lintPrd(parsePrd(PRD(team('cap: api, infra, backend, review', 'bob: web', 'dana: design'))), { areas: AREAS });
  assert.ok(rules(unknown).includes('unknown_area'));
  const soft = lintPrd(parsePrd(PRD(team('cap: api, infra', 'bob: web', 'dana: design', 'carol: research'))), { areas: AREAS });
  assert.deepEqual(soft.errors, []);
  assert.ok(rules(soft).includes('no_reviewer'));
  assert.ok(rules(soft).includes('member_idle'), 'the researcher has no tasks');
  const none = lintPrd(parsePrd(APPROVED + skel), { areas: AREAS });
  assert.ok(rules(none).includes('no_team'));
});

test('kickoff: an issue closed as "not planned" does not count as a task - it is created anew; a done one is skipped', () => {
  const p = parsePrd(PRD(team('cap: api, infra, review', 'bob: web', 'dana: design')));
  const marker = (id) => `<!-- crew:task id=${id} hash=abc prd=docs/prd.md -->`;
  const existing = [
    { number: 2, title: 'old skeleton', body: marker('T1'), state: 'CLOSED', stateReason: 'NOT_PLANNED' },
    { number: 5, title: 'Task T2', body: marker('T2'), state: 'CLOSED', stateReason: 'COMPLETED' },
  ];
  const plan = planKickoff(p, existing);
  const op = (id) => plan.ops.find((o) => o.id === id);
  assert.equal(op('T1').op, 'create', 'T1 was only in the cancelled #2');
  assert.notEqual(op('T2').op, 'create', 'T2 is done in #5');
  assert.ok(plan.warnings.some((w) => /#2 was closed as "not planned"/.test(w)));
  assert.ok(plan.warnings.some((w) => /already done in closed #5/.test(w)), 'a clear message instead of "fix it by hand"');
});

function project(prd) {
  const root = mkdtempSync(join(tmpdir(), 'crew-final-'));
  writeFileSync(join(root, 'crew.config.json'), '{}');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'prd.md'), prd);
  return root;
}
function fakeGh({ login = 'cap', outsiders = [] } = {}) {
  const calls = [];
  let n = 1;
  const labels = ['epic', ...Object.keys(AREAS).map((a) => `area:${a}`), 'status:ready', 'status:waiting', 'status:needs-spec', 'tier:mid', 'tier:high', 'risk:med', 'risk:high'];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'user') return { code: 0, stdout: `${login}\n`, stderr: '' };
    if (args[0] === 'api' && /\/collaborators\//.test(args[1])) return { code: outsiders.includes(args[1].split('/').pop()) ? 1 : 0, stdout: '', stderr: '' };
    if (args[0] === 'label') return { code: 0, stdout: JSON.stringify(labels.map((name) => ({ name }))), stderr: '' };
    if (args[0] === 'issue' && args[1] === 'list') return { code: 0, stdout: '[]', stderr: '' };
    if (args[0] === 'issue' && args[1] === 'create') return { code: 0, stdout: `https://github.com/a/b/issues/${n++}`, stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { gh, calls };
}
const sleep = async () => {};

test('kickoff --apply: captain only; a non-member of the repo in crew-team - refusal; tasks with --assignee; the plan is published', async () => {
  const root = project(PRD(team('cap: api, infra, review', 'bob: web', 'dana: design')));
  const deps = { root, areas: AREAS, sleep };

  const second = fakeGh({ login: 'carol' });
  const r1 = await runKickoff({ apply: true }, { ...deps, gh: second.gh, captain: 'cap' });
  assert.equal(r1.error?.code, 'not_captain');
  assert.ok(!second.calls.some((a) => a[1] === 'create'), 'the second captain created nothing');

  const out = fakeGh({ outsiders: ['dana'] });
  const r2 = await runKickoff({ apply: true }, { ...deps, gh: out.gh, captain: 'cap' });
  assert.equal(r2.error?.code, 'team_not_collaborator');
  assert.deepEqual(r2.artifacts.outsiders, ['dana']);

  const good = fakeGh();
  let published = 0;
  const r3 = await runKickoff({ apply: true }, { ...deps, gh: good.gh, captain: 'cap', publish: () => (published++, { state: 'done' }) });
  assert.equal(r3.status, 'success', JSON.stringify(r3));
  const creates = good.calls.filter((a) => a[1] === 'create');
  const assignee = (a) => (a.includes('--assignee') ? a[a.indexOf('--assignee') + 1] : null);
  assert.deepEqual(creates.map(assignee), ['cap', 'cap', 'bob', 'dana']);
  assert.equal(published, 1);
  assert.equal(r3.artifacts.plan_published, 'done');
});

test('publishPlan: on main - commit the plan documents with Agent and push; on another branch - a clear refusal; clean - nothing', () => {
  const run = (script) => {
    const calls = [];
    const sh = (cmd, args) => {
      calls.push(args.join(' '));
      return script(args) ?? { code: 0, stdout: '', stderr: '' };
    };
    return { sh, calls };
  };
  const repo = ({ branch = 'main', status = ' M docs/prd.md\n', ahead = 'docs/prd.md\n' } = {}) => (a) =>
    a[0] === 'config' ? { code: 0, stdout: 'set\n', stderr: '' }
      : a[0] === 'status' ? { code: 0, stdout: status, stderr: '' }
      : a[0] === 'branch' ? { code: 0, stdout: `${branch}\n`, stderr: '' }
        : a[0] === 'diff' ? { code: 0, stdout: ahead, stderr: '' } : null;
  const m = run(repo());
  assert.equal(publishPlan({ root: '.', me: 'claude@cap', sh: m.sh }).state, 'done');
  assert.ok(m.calls.some((c) => c.startsWith('commit') && c.includes('Agent: claude@cap')));
  assert.ok(m.calls.indexOf('pull --rebase -q origin main') < m.calls.indexOf('push origin HEAD:main'), 'pull main first');
  // a task branch with unpushed code: even with no plan changes we push nothing (Fable review: code bypassing review into main)
  const b = run(repo({ branch: 'crew/3-x', status: '', ahead: 'web/src/App.tsx\n' }));
  assert.equal(publishPlan({ root: '.', me: 'x', sh: b.sh }).state, 'failed');
  assert.ok(!b.calls.some((c) => c.startsWith('push') || c.startsWith('commit')));
  // main with someone else's local commits - we do not push
  const foreign = run(repo({ status: '', ahead: 'docs/prd.md\napi/src/x.ts\n' }));
  assert.equal(publishPlan({ root: '.', me: 'x', sh: foreign.sh }).state, 'failed');
  assert.ok(!foreign.calls.some((c) => c.startsWith('push')));
  // a fresh clone without user.name/email (a real project, 13.11): set a noreply from the gh account, the commit goes through
  const noId = run((a) => (a[0] === 'config' && a.length === 2 ? { code: 1, stdout: '', stderr: '' }
    : a[0] === 'api' ? { code: 0, stdout: 'cap 42\n', stderr: '' } : repo()(a)));
  assert.equal(publishPlan({ root: '.', me: 'claude@cap', sh: noId.sh }).state, 'done');
  assert.ok(noId.calls.includes('config user.email 42+cap@users.noreply.github.com'), noId.calls.join(' | '));
  assert.ok(noId.calls.includes('config user.name cap'));
  const clean = run(repo({ status: '', ahead: '' }));
  assert.equal(publishPlan({ root: '.', me: 'x', sh: clean.sh }).state, 'clean');
});

const NOW = Date.parse('2026-11-10T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const SHA = 'abcdef1234567890';
const pr = (number, { agent = 'codex@bob', login = 'bob', risk = 'med', age = 5, comments = [], checks = [] } = {}) => ({
  number, title: `PR ${number}`, body: `Closes #${number}\n**Agent:** \`${agent}\``, headRefOid: SHA, createdAt: ago(age), isDraft: false,
  author: { login }, labels: [{ name: `risk:${risk}` }], comments, statusCheckRollup: checks,
});
const review = (agent, verdict = 'approve') => ({ body: `<!-- crew:review verdict=${verdict} agent=${agent} sha=${SHA.slice(0, 7)} -->`, authorAssociation: 'COLLABORATOR', createdAt: ago(1) });
const cfg = { ...DEFAULT_CONFIG, hosts: ['claude', 'codex'] };

test('PR queue: the team reviewer first, the others after the fallback; own PR and changes are not taken; a ready high - merge', () => {
  const reviewers = ['cap'];
  const fresh = pr(17, { risk: 'high', age: 10 });
  const cap = prQueue([fresh], { me: 'claude@cap', login: 'cap', reviewers, config: cfg, now: NOW });
  assert.equal(cap[0].kind, 'review');
  assert.equal(cap[0].reviewable, true);
  const dana = prQueue([fresh], { me: 'claude@dana', login: 'dana', reviewers, config: cfg, now: NOW });
  assert.equal(dana[0].reviewable, false, 'a fresh PR - the reviewer queue');
  const old = prQueue([pr(17, { risk: 'high', age: 45 })], { me: 'claude@dana', login: 'dana', reviewers, config: cfg, now: NOW });
  assert.equal(old[0].reviewable, true, 'waiting > fallback - anyone can');
  const capsOwn = prQueue([pr(20, { agent: 'claude@cap', login: 'cap' })], { me: 'codex@dana', login: 'dana', reviewers, config: cfg, now: NOW });
  assert.equal(capsOwn[0].reviewable, true, 'the reviewer\'s own PR is reviewed by anyone');
  const own = prQueue([fresh], { me: 'codex@bob', login: 'bob', reviewers: [], config: cfg, now: NOW });
  assert.equal(own[0].reviewable, false);
  const asked = prQueue([pr(18, { comments: [review('claude@cap', 'changes')] })], { me: 'claude@x', login: 'x', config: cfg, now: NOW });
  assert.equal(asked[0].kind, 'fix');
  assert.equal(asked[0].reviewable, false);
  assert.equal(asked[0].mine, false);
  const green = [{ name: 'check', conclusion: 'SUCCESS' }, { context: 'crew-guard', state: 'SUCCESS' }];
  const ready = prQueue([fresh, pr(19, { risk: 'high', comments: [review('claude@cap')], checks: green })], { me: 'claude@dana', login: 'dana', reviewers, config: cfg, now: NOW });
  assert.equal(ready[0].kind, 'merge');
  assert.equal(ready[0].number, 19);
  assert.deepEqual(prChecks({ statusCheckRollup: [{ name: 'guard', conclusion: 'CANCELLED' }, { context: 'crew-guard', state: 'PENDING' }] }), { check: null, guard: 'pending' });
});

test('Fable review: own PR with changes/conflict - first; a conflict is not merged; a fork is not reviewed; low/med without auto-merge - merge', () => {
  const green = [{ name: 'check', conclusion: 'SUCCESS' }, { context: 'crew-guard', state: 'SUCCESS' }];
  const approved = [review('claude@cap')];
  const conflict = { ...pr(30, { risk: 'high', comments: approved, checks: green }), mergeable: 'CONFLICTING' };
  const q = prQueue([conflict], { me: 'codex@bob', login: 'bob', config: cfg, now: NOW });
  assert.deepEqual(q.map((x) => [x.kind, x.reason, x.mine, x.issue]), [['fix', 'conflict with main', true, 30]], 'instead of an endless merge - to the author');
  const red = prQueue([pr(31, { checks: [{ name: 'check', conclusion: 'FAILURE' }] })], { me: 'codex@bob', login: 'bob', config: cfg, now: NOW });
  assert.equal(red[0].reason, 'red check');
  assert.equal(prQueue([{ ...pr(32), isCrossRepository: true }], { me: 'claude@cap', login: 'cap', config: cfg, now: NOW }).length, 0);
  const noAuto = prQueue([{ ...pr(33, { comments: approved, checks: green }), autoMergeRequest: null }], { me: 'claude@x', login: 'x', config: cfg, now: NOW });
  assert.equal(noAuto[0].kind, 'merge');
  const auto = prQueue([{ ...pr(34, { comments: approved, checks: green }), autoMergeRequest: { enabledAt: ago(1) } }], { me: 'claude@x', login: 'x', config: cfg, now: NOW });
  assert.equal(auto.length, 0, 'auto-merge is on - GitHub will merge by itself');

  const deps = { pauseGuard: () => null, config: cfg, root: '.', me: 'codex@bob', login: 'bob', team: null,
    prs: [pr(17, { agent: 'claude@cap', login: 'cap' }), pr(18, { comments: [review('claude@cap', 'changes')] })], ready: [] };
  const r = next.run({}, deps);
  assert.equal(r.artifacts.kind, 'fix', JSON.stringify(r));
  assert.equal(r.artifacts.pr, 18);
  assert.match(r.next_actions.join(' '), /crew pr open/);
});

test('kickoff --apply not from main - refusal before creating tasks', async () => {
  const root = project(PRD(team('cap: api, infra, review', 'bob: web', 'dana: design')));
  const f = fakeGh();
  const r = await runKickoff({ apply: true }, { root, areas: AREAS, sleep, gh: f.gh, captain: 'cap', branch: 'crew/3-x' });
  assert.equal(r.error?.code, 'not_main');
  assert.ok(!f.calls.some((a) => a[1] === 'create'));
});

test('main is not protected (private repo, free plan) -> auto-merge is not enabled', () => {
  assert.equal(mainProtected('.', () => ({ code: 1, stdout: '', stderr: 'Upgrade to GitHub Pro or make this repository public (HTTP 403)' })), false);
  const prot = (rsc) => () => ({ code: 0, stdout: JSON.stringify({ required_status_checks: rsc }), stderr: '' });
  assert.equal(mainProtected('.', prot({ contexts: ['check', 'crew-guard'], checks: [] })), true);
  assert.equal(mainProtected('.', prot({ contexts: [], checks: [{ context: 'check', app_id: 15368 }, { context: 'crew-guard', app_id: 15368 }] })), true);
  assert.equal(mainProtected('.', prot({ contexts: ['check'], checks: [{ context: 'crew-guard' }] })), true);
  assert.equal(mainProtected('.', prot({ contexts: ['unrelated-ci'], checks: [] })), false);
  assert.equal(mainProtected('.', prot({ contexts: ['check'], checks: [] })), false);
  assert.equal(mainProtected('.', prot({ contexts: ['crew-guard'], checks: [] })), false);
  assert.equal(mainProtected('.', prot({ contexts: [], checks: [] })), false);
  assert.equal(mainProtected('.', prot({ contexts: 'check crew-guard', checks: 'x' })), false);
  assert.equal(mainProtected('.', () => ({ code: 0, stdout: '{}', stderr: '' })), false);
  assert.equal(mainProtected('.', () => ({ code: 0, stdout: 'not json', stderr: '' })), false);
  // without auto-merge an approved green low/med PR is handed out for merge via crew task next
  const green = [{ name: 'check', conclusion: 'SUCCESS' }, { context: 'crew-guard', state: 'SUCCESS' }];
  const q = prQueue([{ ...pr(42, { comments: [review('claude@cap')], checks: green }), autoMergeRequest: null }], { me: 'codex@dana', login: 'dana', config: cfg, now: NOW });
  assert.equal(q[0].kind, 'merge');
  const pending = prQueue([{ ...pr(43, { checks: [{ name: 'check', conclusion: 'SUCCESS' }, { context: 'crew-guard', state: 'PENDING' }] }), autoMergeRequest: null }], { me: 'claude@cap', login: 'cap', config: cfg, now: NOW });
  assert.equal(pending[0].kind, 'review', 'without a review - not a merge');
});

test('crew task next --wait: empty - waits and checks once a minute, work appeared - hands it out at once; pause - no waiting', () => {
  let t = 0;
  const slept = [];
  let calls = 0;
  const task = { number: 7, title: 'T', labels: [{ name: 'area:web' }, { name: 'tier:mid' }], assignees: [] };
  const base = { pauseGuard: () => null, config: cfg, root: '.', me: 'codex@dana', login: 'dana', team: null, prs: [], now: () => t, sleepSync: (ms) => { slept.push(ms); t += ms; } };
  const deps = { ...base, get ready() { calls++; return calls >= 3 ? [task] : []; } };
  const r = next.run({ wait: 20 }, deps);
  assert.equal(r.artifacts.kind, 'task');
  assert.deepEqual(slept, [60_000, 60_000]);
  t = 0; slept.length = 0;
  const empty = next.run({ wait: 3 }, { ...base, ready: [] });
  assert.equal(empty.artifacts.idle, true);
  assert.match(empty.summary, /waited 3 min/);
  assert.equal(slept.reduce((a, b) => a + b, 0), 180_000);
  slept.length = 0;
  const paused = next.run({ wait: 20 }, { ...base, pauseGuard: () => ({ status: 'error', error: { code: 'paused' } }) });
  assert.equal(paused.error.code, 'paused');
  assert.equal(slept.length, 0);
  assert.equal(next.run({}, { ...base, ready: [] }).artifacts.idle, true, 'without --wait - at once');
});

test('tasks: assigned to me -> nobody\'s -> others\'', () => {
  const issue = (number, owner) => ({ number, title: `#${number}`, labels: [{ name: 'status:ready' }, { name: 'area:web' }, { name: 'tier:mid' }], assignees: owner ? [{ login: owner }] : [] });
  const order = taskOrder([issue(3, 'dana'), issue(4, null), issue(5, 'bob')], { login: 'Bob' });
  assert.deepEqual(order.map((x) => x.issue.number), [5, 4, 3]);
  assert.equal(order[0].mine, true);
});

test('crew task next: review first, then own tasks; tasks_only (crew worker) - no review', () => {
  const deps = {
    pauseGuard: () => null, config: cfg, root: '.', me: 'claude@cap', login: 'cap',
    team: parsePrd(team('cap: api, review', 'bob: web')).team,
    prs: [pr(17, { risk: 'high' })],
    ready: [{ number: 13, title: 'API', labels: [{ name: 'area:api' }, { name: 'tier:mid' }], assignees: [{ login: 'cap' }] }],
  };
  const r = next.run({}, deps);
  assert.equal(r.artifacts.kind, 'review');
  assert.equal(r.artifacts.pr, 17);
  assert.match(r.next_actions.join(' '), /crew pr review 17/);
  const w = next.run({ tasks_only: true }, deps);
  assert.equal(w.artifacts.kind, 'task');
  assert.equal(w.artifacts.issue, 13);
  assert.equal(w.artifacts.mine, true);
});
