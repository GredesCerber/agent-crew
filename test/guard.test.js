// crew guard: PR rules without manual approval. Pure functions, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateGuard,
  allowedAcceptanceChanges,
  fileViolations,
  reviewPolicy,
  reviewState,
  reviewMarker,
  authorAgent,
  linkedIssue,
  isProtected,
  isPureMove,
  taskMarkers,
  vendorOf,
} from '../src/core/guard.js';
import { parsePrd, renderTaskBody, lintPrd } from '../src/core/prd.js';
import { DEFAULT_CONFIG, agentId } from '../src/core/config.js';
import { commands, findCommand, agentCommands } from '../src/core/registry.js';

const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const body = (agent = 'claude/opus') => `Closes #12\n\n**Agent:** \`${agent}\`\n`;
const rev = (verdict, agent, sha = SHA.slice(0, 7), at = '2026-11-08T10:00:00Z') => ({ body: `${reviewMarker({ verdict, agent, sha })}\ntext`, createdAt: at });
const NOW = Date.parse('2026-11-08T10:10:00Z');
const CREATED = '2026-11-08T10:00:00Z';
const base = { body: body(), headSha: SHA, createdAt: CREATED, now: NOW, config: DEFAULT_CONFIG };

test('PR parsing: Closes #N and the author agent', () => {
  assert.equal(linkedIssue('Fixes #7'), 7);
  assert.equal(linkedIssue('closes #42 and more'), 42);
  assert.equal(linkedIssue('see #5'), null);
  assert.equal(authorAgent(body('codex/gpt')), 'codex/gpt');
  assert.equal(authorAgent('no agent'), null);
});

test('protected paths: agent rules and CI', () => {
  for (const p of ['crew.config.json', '.github/workflows/crew.yml', 'AGENTS.md', 'CLAUDE.md', 'agents/roles/builder.md', 'events/e.json', './AGENTS.md']) {
    assert.ok(isProtected(p), p);
  }
  for (const p of ['web/AGENTS.md', 'api/crew.config.json.bak', 'docs/x.md', 'github/x']) assert.ok(!isProtected(p), p);
});

test('a clean PR without a review -> pending (waits for an agent), not failure', () => {
  const r = evaluateGuard({ ...base, files: [{ filename: 'web/src/a.tsx', status: 'modified' }] });
  assert.equal(r.state, 'pending');
  assert.match(r.description, /waiting for review by .*: 0\/1/);
  assert.ok(r.description.length <= 140);
});

test('approval by an agent of another vendor on the current commit -> success', () => {
  const r = evaluateGuard({ ...base, files: [], comments: [rev('approve', 'codex/gpt')] });
  assert.equal(r.state, 'success', JSON.stringify(r));
});

test('self-approval and the same vendor do not count; after fallback_minutes another agent of the same vendor counts', () => {
  const comments = [rev('approve', 'claude/opus'), rev('approve', 'claude/sonnet')];
  assert.equal(evaluateGuard({ ...base, comments }).state, 'pending');
  const late = evaluateGuard({ ...base, comments, now: Date.parse('2026-11-08T10:31:00Z') });
  assert.equal(late.state, 'success');
  assert.deepEqual(late.review.approvals, ['claude/sonnet'], 'the author does not approve their own PR even after the fallback');
});

test('a team with Claude only (hosts: [claude]) -> other-agent right away', () => {
  const config = { ...DEFAULT_CONFIG, hosts: ['claude'] };
  assert.equal(reviewPolicy(config).require, 'other-agent');
  assert.equal(evaluateGuard({ ...base, config, comments: [rev('approve', 'claude/sonnet')] }).state, 'success');
  assert.equal(reviewPolicy({ ...config, review: { require: 'other-vendor' } }).require, 'other-vendor', 'an explicit setting wins');
});

test('approval of an old commit does not count (a new push -> a new review)', () => {
  const r = evaluateGuard({ ...base, comments: [rev('approve', 'codex/gpt', 'ffffff0')] });
  assert.equal(r.state, 'pending');
  assert.deepEqual(r.review.stale, ['codex/gpt']);
});

test('the last verdict of an agent is the main one; changes -> failure', () => {
  const changed = evaluateGuard({ ...base, comments: [rev('approve', 'codex/gpt'), rev('changes', 'codex/gpt')] });
  assert.equal(changed.state, 'failure');
  assert.equal(changed.problems[0].rule, 'changes_requested');
  const fixed = evaluateGuard({ ...base, comments: [rev('changes', 'codex/gpt'), rev('approve', 'codex/gpt')] });
  assert.equal(fixed.state, 'success');
});

test('risk:high: one approval by default (rehearsal: 2 stalled the queue), approvals_high: 2 - two different agents', () => {
  assert.equal(evaluateGuard({ ...base, risk: 'high', comments: [rev('approve', 'codex/gpt')] }).state, 'success');
  const strict = { ...base, config: { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, approvals_high: 2 } } };
  const one = evaluateGuard({ ...strict, risk: 'high', comments: [rev('approve', 'codex/gpt')] });
  assert.equal(one.state, 'pending');
  const two = evaluateGuard({ ...strict, risk: 'high', comments: [rev('approve', 'codex/gpt'), rev('approve', 'codex/security')] });
  assert.equal(two.state, 'success');
});

test('a PR touching agent rules or CI -> failure with no way to "approve" by a label', () => {
  const r = evaluateGuard({
    ...base,
    files: [{ filename: '.github/workflows/crew.yml', status: 'modified' }, { filename: 'crew.config.json', status: 'modified' }],
    comments: [rev('approve', 'codex/gpt')],
  });
  assert.equal(r.state, 'failure');
  assert.equal(r.problems[0].rule, 'protected_paths');
  assert.deepEqual(r.problems[0].files, ['.github/workflows/crew.yml', 'crew.config.json']);
  // a rename FROM a protected path is also caught
  assert.deepEqual(fileViolations([{ filename: 'x.md', status: 'renamed', previous_filename: 'AGENTS.md' }]).protectedHits, ['x.md']);
});

test('acceptance tests: new ones are allowed, existing ones only if the task allows', () => {
  const files = [
    { filename: 'tests/acceptance/test_12_new.py', status: 'added' },
    { filename: 'tests/acceptance/test_3_login.py', status: 'modified' },
    { filename: 'tests/acceptance/test_4_old.py', status: 'removed' },
    { filename: 'tests/e2e/x.spec.ts', status: 'modified' },
  ];
  const blocked = evaluateGuard({ ...base, files, comments: [rev('approve', 'codex/gpt')] });
  assert.equal(blocked.state, 'failure');
  assert.deepEqual(blocked.problems.find((p) => p.rule === 'acceptance_changed').files, ['tests/acceptance/test_3_login.py', 'tests/acceptance/test_4_old.py']);

  const issueBody = '### Goal\n\nx\n\n### Changes acceptance\n\n- `tests/acceptance/test_3_login.py`\n- tests/acceptance/test_4_old.py\n\n### Risk\n\nmed\n';
  const allowed = evaluateGuard({ ...base, files, issueBody, comments: [rev('approve', 'codex/gpt')] });
  assert.equal(allowed.state, 'success', JSON.stringify(allowed.problems));

  // renaming an existing test is a change of the old path
  const renamed = fileViolations([{ filename: 'tests/acceptance/b.py', status: 'renamed', previous_filename: 'tests/acceptance/a.py' }]);
  assert.deepEqual(renamed.acceptanceHits, ['tests/acceptance/a.py']);
});

test('"Changes acceptance": issue form and the body from crew kickoff, a folder via /**', () => {
  assert.deepEqual(allowedAcceptanceChanges('### Changes acceptance\n\ntests/acceptance/a.py\ntests/acceptance/auth/**\n'), ['tests/acceptance/a.py', 'tests/acceptance/auth/**']);
  assert.deepEqual(allowedAcceptanceChanges('### Changes acceptance\n\n_No response_\n'), []);
  assert.deepEqual(allowedAcceptanceChanges('### Goal\n\ntests/acceptance/a.py\n'), [], 'paths outside the section do not count');
  const ok = fileViolations([{ filename: 'tests/acceptance/auth/login.py', status: 'modified' }], { allowedAcceptance: ['tests/acceptance/auth/**'] });
  assert.deepEqual(ok.acceptanceHits, []);
});

test('no Closes #N -> failure', () => {
  const r = evaluateGuard({ ...base, body: '**Agent:** `claude/x`', comments: [rev('approve', 'codex/gpt')] });
  assert.equal(r.state, 'failure');
  assert.equal(r.problems[0].rule, 'closes');
});

test('reviewState ignores markers without agent/verdict/sha and short shas', () => {
  const s = reviewState([{ body: '<!-- crew:review verdict=approve -->' }, rev('approve', 'codex/gpt', 'a1b2')], {
    headSha: SHA,
    author: 'claude/opus',
    policy: reviewPolicy(DEFAULT_CONFIG),
  });
  assert.deepEqual(s.approvals, []);
});

test('PRD: changes_acceptance -> the "Changes acceptance" section that guard reads; lint checks paths', () => {
  const prd = [
    '```crew-task',
    'id: T1',
    'title: Skeleton',
    'area: web',
    'tier: high',
    'risk: high',
    'skeleton: true',
    'goal: skeleton',
    'acceptance:',
    '  - Given a When b Then c',
    '```',
    '```crew-task',
    'id: T2',
    'title: Login via feedback',
    'area: web',
    'tier: mid',
    'goal: login',
    'acceptance:',
    '  - Given a When b Then c',
    'changes_acceptance: [tests/acceptance/test_3_login.py, docs/x.md]',
    '```',
  ].join('\n');
  const parsed = parsePrd(prd);
  const lint = lintPrd(parsed, { areas: DEFAULT_CONFIG.areas });
  assert.ok(lint.errors.some((e) => e.rule === 'changes_acceptance_path' && e.message.includes('docs/x.md')), JSON.stringify(lint.errors));
  const t2 = parsed.tasks.find((t) => t.id === 'T2');
  const text = renderTaskBody(t2);
  assert.deepEqual(allowedAcceptanceChanges(text), ['tests/acceptance/test_3_login.py']);
});

// -- risk:high: tests are written by another agent (tests/pending -> tests/acceptance) --------------

const testsTaskBody = '### Goal\n\ntests\n<!-- crew:task id=T6 hash=x prd=docs/prd.md -->\n<!-- crew:tests-for task=T4 -->\n';
const codeTaskBody = '### Goal\n\nform\n<!-- crew:task id=T4 hash=y prd=docs/prd.md -->\n<!-- crew:after issues=10,13 -->\n<!-- crew:tests issue=13 task=T6 -->\n';
const ok = [rev('approve', 'codex/gpt')];

test('taskMarkers: task id, tests_for and the tests task number from the issue body', () => {
  assert.deepEqual(taskMarkers(testsTaskBody), { taskId: 'T6', testsFor: 'T4', testsIssue: null });
  assert.deepEqual(taskMarkers(codeTaskBody), { taskId: 'T4', testsFor: null, testsIssue: 13 });
  assert.deepEqual(taskMarkers(''), { taskId: null, testsFor: null, testsIssue: null });
});

test('a tests task touches only tests/pending/<T>/', () => {
  const good = evaluateGuard({ ...base, issueBody: testsTaskBody, comments: ok, files: [{ filename: 'tests/pending/T4/test_register.py', status: 'added' }] });
  assert.equal(good.state, 'success', JSON.stringify(good.problems));
  const bad = evaluateGuard({
    ...base,
    issueBody: testsTaskBody,
    comments: ok,
    files: [{ filename: 'tests/pending/T4/test_register.py', status: 'added' }, { filename: 'web/src/register.tsx', status: 'added' }],
  });
  assert.equal(bad.state, 'failure');
  assert.deepEqual(bad.problems.find((p) => p.rule === 'tests_task_scope').files, ['web/src/register.tsx']);
});

test('a code task moves the tests unchanged; an edit or a forgotten file -> failure', () => {
  const pendingFiles = ['tests/pending/T4/test_register.py', 'tests/pending/T4/test_taken.py'];
  const move = (name, changes = 0) => ({ filename: `tests/acceptance/${name}`, previous_filename: `tests/pending/T4/${name}`, status: 'renamed', additions: changes, deletions: 0, changes });
  const code = { filename: 'web/src/register.tsx', status: 'added', additions: 40, deletions: 0, changes: 40 };

  const good = evaluateGuard({ ...base, issueBody: codeTaskBody, comments: ok, pendingFiles, files: [move('test_register.py'), move('test_taken.py'), code] });
  assert.equal(good.state, 'success', JSON.stringify(good.problems));

  const edited = evaluateGuard({ ...base, issueBody: codeTaskBody, comments: ok, pendingFiles, files: [move('test_register.py', 3), move('test_taken.py'), code] });
  assert.equal(edited.state, 'failure');
  assert.ok(edited.problems.some((p) => p.rule === 'acceptance_changed'), 'a move with an edit = a change of someone else\'s tests');
  assert.ok(edited.problems.some((p) => p.rule === 'pending_tests_not_moved' && p.files.includes('tests/pending/T4/test_register.py')));

  const forgot = evaluateGuard({ ...base, issueBody: codeTaskBody, comments: ok, pendingFiles, files: [move('test_register.py'), code] });
  assert.equal(forgot.state, 'failure');
  assert.deepEqual(forgot.problems.find((p) => p.rule === 'pending_tests_not_moved').files, ['tests/pending/T4/test_taken.py']);
});

test('tests/pending are frozen: someone else\'s tests cannot be edited or deleted', () => {
  for (const f of [
    { filename: 'tests/pending/T4/test_register.py', status: 'modified', changes: 2 },
    { filename: 'tests/pending/T4/test_register.py', status: 'removed', changes: 10 },
  ]) {
    assert.deepEqual(fileViolations([f]).acceptanceHits, ['tests/pending/T4/test_register.py'], f.status);
  }
  assert.equal(isPureMove({ filename: 'tests/acceptance/a.py', previous_filename: 'tests/pending/T4/a.py', status: 'renamed' }), false, 'no change counters - we do not trust it');
  assert.equal(isPureMove({ filename: 'tests/e2e/a.py', previous_filename: 'tests/pending/T4/a.py', status: 'renamed', changes: 0 }), false, 'only into tests/acceptance/');
});

test('agent id: the machine is appended to CREW_AGENT, CREW_AGENT_ID wins; vendor - before / or @', () => {
  assert.match(agentId({ CREW_AGENT: 'claude' }), /^claude@[a-z0-9-]+$/);
  assert.match(agentId({}), /^human@/);
  assert.equal(agentId({ CREW_AGENT: 'claude@petya' }), 'claude@petya');
  assert.equal(agentId({ CREW_AGENT: 'claude', CREW_AGENT_ID: 'claude@petya-2' }), 'claude@petya-2');
  assert.equal(vendorOf('claude@petya'), 'claude');
  assert.equal(vendorOf('codex/gpt-x@masha'), 'codex');
  // two Claudes on different machines are different agents: a review by the other counts
  const r = evaluateGuard({ ...base, body: body('claude@petya'), config: { ...DEFAULT_CONFIG, hosts: ['claude'] }, comments: [rev('approve', 'claude@masha')] });
  assert.equal(r.state, 'success');
});

test('commands: crew guard and crew pr review exist in the CLI and MCP', () => {
  assert.equal(findCommand(['guard']).name, 'guard');
  assert.equal(findCommand(['pr', 'review', '5']).name, 'pr review');
  assert.equal(findCommand(['pr', 'open']).name, 'pr open');
  assert.ok(agentCommands.some((c) => c.name === 'pr review'));
  assert.equal(new Set(commands.map((c) => c.name)).size, commands.length, 'command names are unique');
});
