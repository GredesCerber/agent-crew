// crew kickoff / crew task lint / crew task promote with a fake gh: no network and no GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runKickoff, CREATE_DELAY_MS, RATE_LIMIT_BACKOFF_MS } from '../src/commands/kickoff.js';
import { decidePromotions, afterIssues } from '../src/commands/task.js';
import { STATUS } from '../src/core/issues.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { agentCommands, findCommand } from '../src/core/registry.js';
import { allLabels } from '../src/commands/labels.js';

const ROOT = join(import.meta.dirname, '..');
const CREW = join(ROOT, 'bin', 'crew.js');
const FORMAT = readFileSync(join(ROOT, 'skills', 'crew-kickoff', 'task-format.md'), 'utf8');
const APPROVED = '<!-- crew:prd status: approved by: alice at: 2026-11-08T10:00:00Z -->\n';
const crew = (args, cwd) => {
  const r = spawnSync(process.execPath, [CREW, ...args, '--json'], { cwd, encoding: 'utf8' });
  return { code: r.status, out: JSON.parse(r.stdout) };
};

function project(prdText) {
  const root = mkdtempSync(join(tmpdir(), 'crew-kick-'));
  writeFileSync(join(root, 'crew.config.json'), '{}');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'prd.md'), prdText);
  return root;
}

/** Fake gh: labels, issue list, create with numbers in order; failOn(args, n) -> a response instead of success. */
function fakeGh({ existing = [], labels = allLabels(DEFAULT_CONFIG).map((l) => l.name), failOn = () => null, firstNumber = 1, outsiders = [] } = {}) {
  const calls = [];
  let n = firstNumber;
  let creates = 0;
  const gh = (args, opts = {}) => {
    calls.push({ args, input: opts.input });
    if (args[0] === 'label' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(labels.map((name) => ({ name }))), stderr: '' };
    if (args[0] === 'issue' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(existing), stderr: '' };
    if (args[0] === 'api' && /\/collaborators\/[\w-]+$/.test(args[1])) return { code: outsiders.includes(args[1].split('/').pop()) ? 1 : 0, stdout: '', stderr: '' };
    if (args[0] === 'issue' && args[1] === 'create') {
      const forced = failOn(args, ++creates);
      if (forced) return forced;
      return { code: 0, stdout: `https://github.com/acme/app/issues/${n++}`, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return { gh, calls, creates: () => calls.filter((c) => c.args[1] === 'create') };
}
const sleeper = () => {
  const slept = [];
  return { slept, sleep: async (ms) => { slept.push(ms); } };
};
const deps = (root, extra) => ({ root, areas: DEFAULT_CONFIG.areas, ...extra });

test('kickoff dry-run: a plan without approval, creates nothing', async () => {
  const root = project(FORMAT);
  const f = fakeGh();
  const r = await runKickoff({}, deps(root, { gh: f.gh }));
  assert.equal(r.status, 'success', JSON.stringify(r));
  assert.equal(r.artifacts.apply, false);
  assert.equal(r.artifacts.approved, false);
  assert.deepEqual(r.artifacts.plan.map((o) => o.id), ['T1', 'T2', 'T3', 'T6', 'T4', 'T5', 'E1']);
  assert.equal(f.creates().length, 0);
  assert.ok(r.next_actions.some((a) => a.includes('status: approved')));
});

test('kickoff --apply without approval -> plan_not_approved before touching GitHub', async () => {
  const root = project(FORMAT);
  const f = fakeGh();
  const r = await runKickoff({ apply: true }, deps(root, { gh: f.gh }));
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'plan_not_approved');
  assert.ok(r.error.cause_hint && r.error.retry && r.error.stop_when);
  assert.match(r.error.stop_when, /auto-timeout/);
  assert.equal(f.calls.length, 0, 'gh was not called');
  const draft = await runKickoff({ apply: true }, deps(project(`<!-- crew:prd status: draft by: - at: - -->\n${FORMAT}`), { gh: f.gh }));
  assert.equal(draft.error.code, 'plan_not_approved');
  assert.match(draft.error.cause_hint, /draft/);
});

test('kickoff --apply: order, labels, bodies with "After #N", the epic last, a pause between creates', async () => {
  const root = project(APPROVED + FORMAT);
  const f = fakeGh({ firstNumber: 10 });
  const s = sleeper();
  const r = await runKickoff({ apply: true }, deps(root, { gh: f.gh, sleep: s.sleep }));
  assert.equal(r.status, 'success', JSON.stringify(r));
  assert.deepEqual(r.artifacts.map, { T1: 10, T2: 11, T3: 12, T6: 13, T4: 14, T5: 15, E1: 16 });
  const creates = f.creates();
  assert.equal(creates.length, 7);
  const label = (c) => c.args[c.args.indexOf('--label') + 1];
  assert.equal(label(creates[0]), 'status:ready,area:infra,tier:high,risk:high');
  assert.equal(label(creates[1]), 'status:waiting,area:contracts,tier:mid,risk:med');
  assert.equal(label(creates[3]), 'status:waiting,area:e2e,tier:mid,risk:med', 'the tests task T6');
  assert.equal(label(creates[5]), 'status:needs-spec,area:web,tier:low,risk:low');
  assert.equal(label(creates[6]), 'epic');
  assert.ok(creates.every((c) => c.args.includes('--body-file') && c.args.includes('-')), 'body via stdin');
  // the tests task: only tests/pending/T4/, T4 criteria, a marker for crew-guard
  assert.match(creates[3].input, /tests\/pending\/T4\//);
  assert.match(creates[3].input, /Given \/register is open/);
  assert.match(creates[3].input, /<!-- crew:tests-for task=T4 -->/);
  // T4 waits for its tests and knows where to get them
  assert.match(creates[4].input, /After #10, #11, #12, #13/);
  assert.match(creates[4].input, /<!-- crew:after issues=10,11,12,13 -->/);
  assert.match(creates[4].input, /<!-- crew:tests issue=13 task=T6 -->/);
  assert.match(creates[4].input, /git mv tests\/pending\/T4\/\*/);
  assert.match(creates[6].input, /- \[ \] #11 Sign-up contract in contracts\/api\.yaml/);
  assert.deepEqual(s.slept, Array(6).fill(CREATE_DELAY_MS), '~1 s between creates');
});

test('kickoff --apply is idempotent: a repeat by markers creates nothing', async () => {
  const root = project(APPROVED + FORMAT);
  const first = fakeGh();
  await runKickoff({ apply: true }, deps(root, { gh: first.gh, sleep: async () => {} }));
  const existing = first.creates().map((c, i) => ({ number: i + 1, title: c.args[3], body: c.input, labels: [], state: 'OPEN' }));
  const again = fakeGh({ existing });
  const r = await runKickoff({ apply: true }, deps(root, { gh: again.gh, sleep: async () => {} }));
  assert.equal(r.status, 'success', JSON.stringify(r));
  assert.equal(again.creates().length, 0);
  assert.deepEqual(r.artifacts.skipped, ['T1', 'T2', 'T3', 'T6', 'T4', 'T5', 'E1']);
});

test('kickoff --apply: a new block in the PRD - only it is created; changed/orphan - warnings', async () => {
  const root = project(APPROVED + FORMAT);
  const first = fakeGh();
  await runKickoff({ apply: true }, deps(root, { gh: first.gh, sleep: async () => {} }));
  const existing = first.creates().map((c, i) => ({ number: i + 1, title: c.args[3], body: c.input, labels: [], state: i === 0 ? 'CLOSED' : 'OPEN' }));
  existing.push({ number: 99, title: 'old', body: '<!-- crew:task id=T42 hash=x prd=docs/prd.md -->', labels: [], state: 'OPEN' });
  const extra = '\n```crew-task\nid: T8\ntitle: Profile\nepic: E1\narea: web\ntier: low\ngoal: the profile is visible\nacceptance:\n  - Given signed in When I open /me Then I see the email\n```\n';
  writeFileSync(join(root, 'docs', 'prd.md'), (APPROVED + FORMAT).replace('title: Dark theme', 'title: Dark theme v2') + extra);
  const again = fakeGh({ existing, firstNumber: 50 });
  const r = await runKickoff({ apply: true }, deps(root, { gh: again.gh, sleep: async () => {} }));
  assert.equal(r.status, 'warning', JSON.stringify(r));
  assert.deepEqual(r.artifacts.created, [{ id: 'T8', number: 50 }]);
  const c = again.creates()[0];
  assert.match(c.args[c.args.indexOf('--label') + 1], /^status:ready,/, 'the skeleton is already closed - nothing to wait for');
  assert.ok(r.artifacts.warnings.some((w) => w.includes('T5') && w.includes('changed')));
  assert.ok(r.artifacts.warnings.some((w) => w.includes('T42')));
  assert.ok(r.artifacts.warnings.some((w) => w.includes('E1')), 'a task was added to the epic - the epic is changed, not rebuilt');
});

test('kickoff --apply: no labels -> labels_missing, nothing created', async () => {
  const root = project(APPROVED + FORMAT);
  const f = fakeGh({ labels: ['status:ready'] });
  const r = await runKickoff({ apply: true }, deps(root, { gh: f.gh }));
  assert.equal(r.error.code, 'labels_missing');
  assert.ok(r.artifacts.missing.includes('status:waiting'));
  assert.match(r.error.retry, /crew labels sync/);
  assert.equal(f.creates().length, 0);
});

test('kickoff --apply: a failure midway -> kickoff_partial with created', async () => {
  const root = project(APPROVED + FORMAT);
  const f = fakeGh({ failOn: (_a, n) => (n === 3 ? { code: 1, stdout: '', stderr: 'could not add label: status:waiting not found' } : null) });
  const r = await runKickoff({ apply: true }, deps(root, { gh: f.gh, sleep: async () => {} }));
  assert.equal(r.error.code, 'kickoff_partial');
  assert.deepEqual(r.artifacts.created, [{ id: 'T1', number: 1 }, { id: 'T2', number: 2 }]);
  assert.equal(r.artifacts.failed, 'T3');
  assert.ok(r.error.stop_when);
  assert.equal(f.creates().length, 3, 'not a rate limit - no retries');
});

test('kickoff --apply: secondary rate limit - a retry with pauses 10/30/60 s', async () => {
  const root = project(APPROVED + FORMAT);
  const limited = { code: 1, stdout: '', stderr: 'HTTP 403: You have exceeded a secondary rate limit' };
  const ok2 = fakeGh({ failOn: (_a, n) => (n === 2 || n === 3 ? limited : null) });
  const s = sleeper();
  const r = await runKickoff({ apply: true }, deps(root, { gh: ok2.gh, sleep: s.sleep }));
  assert.equal(r.status, 'success', JSON.stringify(r));
  assert.deepEqual(s.slept.slice(0, 3), [CREATE_DELAY_MS, RATE_LIMIT_BACKOFF_MS[0], RATE_LIMIT_BACKOFF_MS[1]]);
  assert.deepEqual(RATE_LIMIT_BACKOFF_MS, [10_000, 30_000, 60_000]);

  const never = fakeGh({ failOn: (_a, n) => (n >= 2 ? { code: 1, stdout: '', stderr: 'was submitted too quickly: abuse detection' } : null) });
  const s2 = sleeper();
  const bad = await runKickoff({ apply: true }, deps(project(APPROVED + FORMAT), { gh: never.gh, sleep: s2.sleep }));
  assert.equal(bad.error.code, 'kickoff_partial');
  assert.equal(never.creates().length, 1 + 4, 'the first + 1 attempt and 3 retries');
  assert.deepEqual(s2.slept, [CREATE_DELAY_MS, 10_000, 30_000, 60_000]);
  assert.match(bad.error.retry, /wait/);
});

test('CLI: crew task lint and crew kickoff - exit codes and crew/v1 responses', () => {
  const good = project(FORMAT);
  const ok = crew(['task', 'lint'], good);
  assert.equal(ok.code, 0);
  assert.equal(ok.out.status, 'success', JSON.stringify(ok.out));
  assert.deepEqual(ok.out.artifacts.order, ['T1', 'T2', 'T3', 'T6', 'T4', 'T5']);

  const bad = project('```crew-task\nid: T1\ntitle: x\n```\n');
  const r = crew(['task', 'lint'], bad);
  assert.equal(r.code, 1);
  assert.equal(r.out.error.code, 'prd_invalid');
  assert.ok(r.out.artifacts.errors.length >= 2);
  assert.ok(r.out.artifacts.errors.every((e) => 'line' in e && 'rule' in e && 'message' in e && 'id' in e));

  const missing = crew(['task', 'lint', '--file', 'docs/nope.md'], good);
  assert.equal(missing.out.error.code, 'prd_missing');

  const gate = crew(['kickoff', '--apply'], good);
  assert.equal(gate.code, 1);
  assert.equal(gate.out.error.code, 'plan_not_approved');
});

test('registry: task lint and kickoff are available to agents, task promote is not', () => {
  assert.ok(agentCommands.some((c) => c.name === 'task lint'));
  assert.ok(agentCommands.some((c) => c.name === 'kickoff'));
  assert.equal(findCommand(['kickoff']).name, 'kickoff');
  assert.equal(findCommand(['task', 'promote']).agent, false);
  assert.ok(STATUS.includes('waiting'));
});

test('decidePromotions: waiting -> ready only when all crew:after are closed', () => {
  assert.deepEqual(afterIssues('text\n<!-- crew:after issues=12,13 -->'), [12, 13]);
  assert.equal(afterIssues('no marker'), null);
  const waiting = [
    { number: 20, body: '<!-- crew:after issues=12,13 -->' },
    { number: 21, body: '<!-- crew:after issues=12,14 -->' },
    { number: 22, body: '<!-- crew:after issues=99 -->' },
    { number: 23, body: 'by hand, no marker' },
  ];
  const states = new Map([[12, 'CLOSED'], [13, 'closed'], [14, 'OPEN']]);
  assert.deepEqual(decidePromotions(waiting, states), {
    promote: [{ number: 20, after: [12, 13] }],
    wait: [{ number: 21, pending: [14] }, { number: 22, pending: [99] }],
    no_marker: [23],
  });
});

test('labels.json: status:waiting, three risk levels, feedback; descriptions <= 100 characters', () => {
  const labels = JSON.parse(readFileSync(join(ROOT, 'templates', 'labels.json'), 'utf8'));
  const names = labels.map((l) => l.name);
  for (const n of ['status:waiting', 'risk:low', 'risk:med', 'risk:high', 'feedback']) assert.ok(names.includes(n), `missing ${n}`);
  assert.match(labels.find((l) => l.name === 'risk:high').description, /security/);
  for (const l of labels) assert.ok(l.description.length <= 100, l.name);
});

test('crew.yml: promote job on issue close, its own permissions; check/sweep do not run on issues', () => {
  const yml = readFileSync(join(ROOT, 'templates', 'product', '.github', 'workflows', 'crew.yml'), 'utf8');
  assert.match(yml, /\n {2}issues:\n {4}types: \[closed\]/);
  const top = yml.slice(yml.indexOf('\npermissions:'), yml.indexOf('\njobs:'));
  assert.match(top, /contents: read/);
  assert.doesNotMatch(top, /issues: write/, 'default permissions stay read-only');
  const job = (name) => {
    const start = yml.indexOf(`\n  ${name}:\n`);
    const rest = yml.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  };
  const promote = job('promote');
  assert.match(promote, /if: github\.event_name == 'issues'/);
  assert.match(promote, /issues: write/);
  assert.match(promote, /contents: read/);
  assert.match(promote, /crew task promote --json/);
  assert.match(job('check'), /if: github\.event_name != 'schedule' && github\.event_name != 'issues'/);
  assert.ok(!yml.includes('\n  pr-rules:\n'), 'pr-rules moved to crew-guard.yml');
  assert.match(job('sweep'), /if: github\.event_name == 'schedule'/);
});
