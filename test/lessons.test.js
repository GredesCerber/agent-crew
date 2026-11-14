// Fixes from a teammate's hackathon export: host permissions, self-serve ready, resume after a dead session,
// running outside the repo, reading red CI logs. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostWiring } from '../src/commands/doctor.js';
import { readyProblems } from '../src/core/prd.js';
import taskCmds, { unfinishedWork } from '../src/commands/task.js';
import { run } from '../src/core/exec.js';
import prLogs, { failedChecks, errorExcerpt } from '../src/commands/pr-logs.js';
import claude from '../adapters/claude/adapter.js';
import { frontmatter } from '../src/commands/adapters.js';
import { findCommand } from '../src/core/registry.js';

const cmd = (name) => taskCmds.find((c) => c.name === name);

test('claude settings pre-approve crew.cmd and the crew MCP tools; doctor reports missing wiring', () => {
  const files = Object.fromEntries(claude.generate({ config: {}, roles: [], skills: [], frontmatter, platform: 'win32' }).map((f) => [f.path, f]));
  const allow = JSON.parse(files['.claude/settings.json'].content).permissions.allow;
  for (const r of ['Bash(crew:*)', 'Bash(crew.cmd:*)', 'mcp__crew']) assert.ok(allow.includes(r), r);
  const fs = { '/p/.mcp.json': files['.mcp.json'].content, '/p/.claude/settings.json': files['.claude/settings.json'].content };
  const io = { exists: (p) => p.replace(/\\/g, '/') in fs, read: (p) => fs[p.replace(/\\/g, '/')] };
  assert.deepEqual(hostWiring('/p', ['claude'], io), []);
  assert.equal(hostWiring('/p', ['claude', 'codex'], io).length, 1, 'codex config missing');
  assert.equal(hostWiring('/p', ['claude'], { exists: () => false, read: () => '' }).length, 2);
});

test('Definition of Ready: an area and a real Given/When/Then criterion; the template placeholder does not count', () => {
  const area = [{ name: 'area:web' }];
  assert.deepEqual(readyProblems({ labels: area, body: '## Acceptance criteria\n- [ ] Given a user When they submit Then a 201 is returned' }), []);
  assert.deepEqual(readyProblems({ labels: area, body: '- [ ] Дано форма Когда отправляю Тогда вижу номер' }), []);
  assert.equal(readyProblems({ labels: area, body: '- [ ] Given ... When ... Then ...' }).length, 1, 'placeholder');
  assert.equal(readyProblems({ labels: [], body: '- Given a When b Then c' }).length, 1, 'no area');
  assert.equal(readyProblems({ labels: [...area, { name: 'epic' }], body: '- Given a When b Then c' }).length, 1, 'epic');
});

test('crew task status ready: anyone may set it when the DoR holds, refused with the reasons otherwise', () => {
  const calls = [];
  const deps = (body) => ({
    viewIssue: () => ({ number: 7, labels: [{ name: 'area:api' }, { name: 'status:needs-spec' }], body, comments: [] }),
    setStatus: (...a) => calls.push(['status', ...a]),
    comment: (...a) => calls.push(['comment', a[0]]),
  });
  const bad = cmd('task status').run({ id: 7, state: 'ready' }, deps('no criteria yet'));
  assert.equal(bad.error.code, 'not_ready_spec');
  assert.equal(calls.length, 0);
  const good = cmd('task status').run({ id: 7, state: 'ready' }, deps('- [ ] Given a draft When I reload Then it is restored'));
  assert.equal(good.status, 'success');
  assert.equal(calls[0][2], 'ready');
  const forced = cmd('task status').run({ id: 7, state: 'ready', force: true }, deps('nothing'));
  assert.equal(forced.status, 'success', '--force is the human override');
});

test('unfinished work: my pinned worktree, still claimed by me, no PR yet -> resume first', () => {
  const porcelain = ['worktree /r', 'branch refs/heads/main', '', 'worktree /r-wt-5', 'branch refs/heads/crew/5-form', '', 'worktree /r-wt-6', 'branch refs/heads/crew/6-api', '', 'worktree /r-wt-8', 'branch refs/heads/crew/8-x'].join('\n');
  const claimedBy = (agent) => ({ state: 'OPEN', labels: [{ name: 'status:claimed' }], comments: [{ body: `<!-- crew:claim agent=${agent} at=2026-11-14T10:00:00Z -->` }] });
  const io = {
    list: () => porcelain,
    pin: (p) => ({ '/r-wt-5': 'claude@pc', '/r-wt-6': 'claude@pc', '/r-wt-8': 'codex@pc' })[p],
    issue: (id) => ({ 5: claimedBy('claude@pc'), 6: claimedBy('claude@pc') })[id],
    prHeads: () => ['crew/6-api'],
    ahead: () => 3,
  };
  assert.deepEqual(unfinishedWork('/r', 'claude@pc', io), [{ path: '/r-wt-5', branch: 'crew/5-form', id: 5, ahead: 3 }]);
  assert.deepEqual(unfinishedWork('/r', 'claude@pc', { ...io, issue: () => claimedBy('someone@else') }), [], 'lease lost');

  const r = cmd('task next').run({}, { config: {}, root: '/r', me: 'claude@pc', login: null, team: null, unfinished: () => [{ id: 5, path: '/r-wt-5', branch: 'crew/5-form', ahead: 3 }], updateHint: () => null, pauseGuard: () => null });
  assert.equal(r.artifacts.kind, 'resume');
  assert.ok(r.next_actions.some((a) => a.includes('crew pr open')));
});

test('git/gh outside the project folder -> not_a_repo with how to cd, not a raw git error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-norepo-'));
  assert.throws(() => run('git', ['status'], { cwd: dir }), (e) => e.code === 'not_a_repo' && /project folder/.test(e.message));
});

test('crew pr logs: failed checks, the failing step instead of post-job cleanup', () => {
  assert.deepEqual(failedChecks([
    { name: 'guard', bucket: 'fail', state: 'FAILURE', link: 'https://github.com/o/r/actions/runs/123/job/9' },
    { name: 'check', bucket: 'pass', state: 'SUCCESS', link: 'https://github.com/o/r/actions/runs/124/job/1' },
  ]), [{ name: 'guard', run: 123 }]);
  const log = ['##[group]Run actions/checkout@v4', 'ok', '##[group]Run crew guard --pr 5', 'rule closes failed', '##[error]Process completed with exit code 1.', 'Post job cleanup.', 'git config --unset'];
  assert.deepEqual(errorExcerpt(log), ['##[group]Run crew guard --pr 5', 'rule closes failed', '##[error]Process completed with exit code 1.']);
  assert.deepEqual(errorExcerpt(['a', 'b', 'Post job cleanup.', 'noise'], 80), ['a', 'b']);

  const gh = (args) => (args[0] === 'pr'
    ? { code: 0, stdout: JSON.stringify([{ name: 'check', bucket: 'fail', state: 'FAILURE', link: 'https://github.com/o/r/actions/runs/77/job/1' }]) }
    : { code: 0, stdout: log.map((l) => `check\tUNKNOWN STEP\t2026-11-14T10:00:00.0000000Z \u001b[36;1m${l}\u001b[0m`).join('\n') });
  const r = prLogs.run({ pr: 5 }, { gh, root: '.' });
  assert.equal(r.status, 'warning');
  assert.deepEqual(r.artifacts.logs[0].log, ['##[group]Run crew guard --pr 5', 'rule closes failed', '##[error]Process completed with exit code 1.']);
  assert.equal(findCommand(['pr', 'logs', '5']).name, 'pr logs');
  assert.equal(prLogs.run({ pr: 5 }, { gh: () => ({ code: 0, stdout: '[]' }), root: '.' }).artifacts.failed.length, 0);
});
