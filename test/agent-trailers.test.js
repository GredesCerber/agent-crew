// M4: the origin of every PR commit is mandatory; no network and no GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { evaluateGuard } from '../src/core/guard.js';
import { commits as complianceCommits, evaluate } from '../src/commands/compliance.js';
import { prCommits } from '../src/commands/guard.js';
import { git } from '../src/core/exec.js';

const base = {
  body: 'Closes #12\n\n**Agent:** `claude/test`',
  headSha: 'a'.repeat(40),
  config: { review: { approvals: 0 } },
};

test('M4: a commit without Agent blocks the PR even with a correct description and no event', () => {
  const missing = 'b'.repeat(40);
  const r = evaluateGuard({ ...base, commits: [{ sha: base.headSha, agent: 'claude/test' }, { sha: missing, agent: null }] });
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.problems.find((p) => p.rule === 'agent_trailer').commits, [missing]);
});

test('M4: an empty Agent blocks the PR; explicit human and different agents are allowed', () => {
  assert.equal(evaluateGuard({ ...base, commits: [{ sha: base.headSha, agent: '  ' }] }).state, 'failure');
  const commits = ['human', 'claude/test', 'codex/reviewer'].map((agent) => ({ sha: base.headSha, agent }));
  assert.equal(evaluateGuard({ ...base, commits }).state, 'success');
});

test('M4: compliance reports a violation instead of a warning; a separate before-start violation remains', () => {
  const event = { start: '2026-11-08T10:00:00Z', end: '2026-11-08T20:00:00Z', team_members: ['alice'] };
  const c = { sha: 'c'.repeat(40), date: event.start, agent: null };
  const r = evaluate(event, [c], ['alice']);
  assert.ok(r.problems.some((p) => p.includes('without the Agent trailer')));
  assert.deepEqual(r.warnings, []);
  const early = evaluate(event, [{ ...c, date: '2026-11-07T10:00:00Z' }], ['alice']);
  assert.equal(early.problems.length, 1);
  assert.match(early.problems[0], /before the start/);
  assert.deepEqual(evaluate(event, [{ ...c, agent: 'human' }], ['alice']).problems, []);
});

test('M4: commits are read with pagination; Agent in text and an empty trailer do not count', () => {
  const messages = [
    ['a', 'fix: valid\n\nAgent: claude/test\nIssue: #12\n', 'claude/test'],
    ['b', 'Agent: claude/test\n\nordinary description', null],
    ['c', 'fix: body\n\nAgent: claude/test\nThis is ordinary text, not a trailer.', null],
    ['d', 'fix: empty\n\nAgent: \nIssue: #12\n', null],
    ['e', 'fix: explicit human\n\nagent: human\n', 'human'],
  ];
  const fetch = (args, { cwd }) => {
    assert.ok(args.includes('--paginate'));
    assert.ok(args.includes('repos/{owner}/{repo}/pulls/12/commits'));
    assert.equal(cwd, import.meta.dirname);
    return { stdout: messages.map(([sha, message]) => JSON.stringify({ sha, message })).join('\n') + '\n' };
  };
  const commits = prCommits(12, import.meta.dirname, fetch);
  assert.deepEqual(commits, messages.map(([sha, , agent]) => ({ sha, agent })));
  assert.deepEqual(evaluateGuard({ ...base, commits }).problems.find((p) => p.rule === 'agent_trailer').commits, ['b', 'c', 'd']);
});

test('M4: an error reading commits does not turn into a green result', () => {
  assert.throws(() => prCommits(12, import.meta.dirname, () => { throw new Error('API unavailable'); }), /API unavailable/);
});

test('M4: a real merge without Agent does not break compliance on main and refs/pull/N/merge', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-merge-trailers-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const g = (...args) => git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: root });
  g('init', '-q', '-b', 'main');
  g('commit', '--allow-empty', '-m', 'chore: init', '--trailer', 'Agent: human');
  g('checkout', '-b', 'crew/12-feature');
  g('commit', '--allow-empty', '-m', 'feat: change', '--trailer', 'Agent: claude/test');
  const featureSha = g('rev-parse', 'HEAD').stdout;
  g('checkout', 'main');
  g('commit', '--allow-empty', '-m', 'fix: main change', '--trailer', 'Agent: human');
  g('merge', '--no-ff', 'crew/12-feature', '-m', 'Merge pull request #12 from team/crew/12-feature');
  const mergeSha = g('rev-parse', 'HEAD').stdout;
  assert.equal(g('rev-list', '--parents', '-n', '1', 'HEAD').stdout.split(' ').length, 3);
  const event = { start: '2000-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z', team_members: ['alice'] };
  const verify = () => {
    const list = complianceCommits(root);
    assert.ok(!list.some((c) => c.sha === mergeSha), 'merge commit is excluded by topology');
    assert.equal(list.length, 3);
    assert.ok(list.some((c) => c.sha === featureSha), 'the original branch commits are still checked');
    assert.deepEqual(evaluate(event, list, ['alice']).problems, []);
  };
  verify();
  g('update-ref', 'refs/pull/12/merge', mergeSha);
  g('checkout', '--detach', 'refs/pull/12/merge');
  verify();
  // A Merge title does not exempt an ordinary single-parent commit from the requirement.
  g('commit', '--allow-empty', '-m', 'Merge pull request #13 (ordinary commit)');
  const missing = g('rev-parse', 'HEAD').stdout;
  const list = complianceCommits(root);
  assert.ok(list.some((c) => c.sha === missing && c.agent === null));
  const r = evaluate(event, list, ['alice']);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /without the Agent trailer: 1/);
});

test('M4: Update branch and octopus merge without Agent do not break evaluateGuard, ordinary commits are checked', () => {
  const messages = [
    { sha: 'a', message: 'feat: change\n\nAgent: claude/test\n', parents: [{ sha: 'parent' }] },
    { sha: 'b', message: 'Merge main into crew/12-feature', parents: [{ sha: 'a' }, { sha: 'main' }] },
    { sha: 'c', message: 'Merge branches', parents: [{ sha: 'a' }, { sha: 'b' }, { sha: 'main' }] },
  ];
  const fetch = (args) => {
    assert.ok(args.includes('--paginate'));
    assert.match(args.at(-1), /\bparents\b/, 'the API must keep the parents of each commit');
    return { stdout: messages.map((c) => JSON.stringify(c)).join('\n') };
  };
  const good = prCommits(12, import.meta.dirname, fetch);
  assert.deepEqual(good, [{ sha: 'a', agent: 'claude/test' }]);
  assert.equal(evaluateGuard({ ...base, commits: good }).state, 'success');
  messages.push({ sha: 'd', message: 'Merge pull request #13 (ordinary commit)', parents: [{ sha: 'a' }] });
  messages.push({ sha: 'e', message: 'chore: root without trailer', parents: [] });
  const bad = evaluateGuard({ ...base, commits: prCommits(12, import.meta.dirname, fetch) });
  assert.equal(bad.state, 'failure');
  assert.deepEqual(bad.problems.find((p) => p.rule === 'agent_trailer').commits, ['d', 'e']);
});
