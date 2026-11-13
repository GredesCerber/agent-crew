// Hackathon lessons: an outdated crew on members' machines, piles of worktrees, a clone without git identity (a real project).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compareVersions, latestVersion, updateHint } from '../src/core/version.js';
import { taskWorktrees, planCleanup } from '../src/commands/task.js';
import task from '../src/commands/task.js';

test('versions are compared as numbers: 0.2.10 is newer than 0.2.9; garbage is null', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('v0.2.9', '0.2.10'), -1);
  assert.equal(compareVersions('0.3.0', 'v0.3.0'), 0);
  assert.equal(compareVersions('latest', '0.1.0'), null);
});

test('latest tag: the maximum is taken, cached for an hour; no access gives null without an error', () => {
  const cache = join(mkdtempSync(join(tmpdir(), 'crew-ver-')), 'latest.json');
  let calls = 0;
  const fetch = () => (calls++, { code: 0, stdout: 'v0.2.9\nv0.2.11\nv0.2.10\nnot-a-tag\n', stderr: '' });
  assert.equal(latestVersion({ now: 1000, fetch, cache }), '0.2.11');
  assert.equal(latestVersion({ now: 1000 + 30 * 60_000, fetch, cache }), '0.2.11');
  assert.equal(calls, 1, 'the second time comes from the cache');
  assert.equal(latestVersion({ now: 1000 + 61 * 60_000, fetch: () => ({ code: 1, stdout: '', stderr: 'HTTP 404' }), cache }), null);
  const broken = join(mkdtempSync(join(tmpdir(), 'crew-ver-')), 'latest.json');
  writeFileSync(broken, '{oops');
  assert.equal(latestVersion({ now: 1, fetch, cache: broken }), '0.2.11', 'a broken cache does not get in the way');
});

test('update hint only if the local crew is older', () => {
  assert.match(updateHint({ local: '0.2.9', latest: '0.2.11' }), /checkout v0\.2\.11/);
  assert.equal(updateHint({ local: '0.2.11', latest: '0.2.11' }), null);
  assert.equal(updateHint({ local: '0.3.0', latest: '0.2.11' }), null);
  assert.equal(updateHint({ local: '0.2.9', latest: null }), null, 'no network - stay silent');
});

test('crew task next: outdated crew - a hint for the human at the end of next_actions, work is not blocked', () => {
  const next = task.find((c) => c.name === 'task next');
  const deps = { pauseGuard: () => null, config: {}, root: '.', me: 'claude@x', login: 'x', team: null, prs: [], ready: [], updateHint: () => 'crew 0.2.9 is outdated, 0.3.0 is available' };
  const r = next.run({}, deps);
  assert.equal(r.artifacts.idle, true);
  assert.match(r.next_actions.at(-1), /^tell the human: crew 0\.2\.9 is outdated/);
});

test('task cleanup: only crew/<id>-* task folders; closed, clean and saved ones are removed', () => {
  const porcelain = [
    'worktree C:/p/app\nHEAD 1\nbranch refs/heads/main',
    'worktree C:/p/app-wt-7\nHEAD 2\nbranch refs/heads/crew/7-persony',
    'worktree C:/p/app-wt-8\nHEAD 3\nbranch refs/heads/crew/8-open',
    'worktree C:/p/app-wt-9\nHEAD 4\nbranch refs/heads/crew/9-dirty',
    'worktree C:/p/app-wt-10\nHEAD 5\nbranch refs/heads/crew/10-unpushed',
    'worktree C:/p/detached\nHEAD 6\ndetached',
  ].join('\n\n');
  const wts = taskWorktrees(porcelain);
  assert.deepEqual(wts.map((w) => w.id), [7, 8, 9, 10]);
  const plan = planCleanup(wts, {
    issueState: (id) => (id === 8 ? 'OPEN' : 'CLOSED'),
    dirty: (w) => w.id === 9,
    unsaved: (w) => w.id === 10,
  });
  assert.deepEqual(plan.filter((p) => p.remove).map((p) => p.id), [7]);
  assert.match(plan.find((p) => p.id === 8).why, /still open/);
  assert.match(plan.find((p) => p.id === 9).why, /uncommitted/);
  assert.match(plan.find((p) => p.id === 10).why, /neither in main nor on GitHub/);
  assert.ok(task.some((c) => c.name === 'task cleanup'));
});
