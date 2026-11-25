// Task folders on disk: named after the main project folder (also when claimed from inside another task's folder),
// gathered in one "<project>.worktrees" folder, cleaned up by themselves, and old logs pruned. Real git, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { prepareWorkspace, mainRepoRoot, taskFolder, autoCleanup, AUTO_CLEANUP_HOURS } from '../src/commands/task.js';
import { pruneLogs } from '../src/core/logs.js';

const g = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
function tempRepo() {
  const parent = mkdtempSync(join(tmpdir(), 'crew-wt-'));
  const root = join(parent, 'proj');
  g(parent, 'init', '-q', '-b', 'main', root);
  g(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  return root;
}
// Windows gives the temp folder in short (GREDES~1) and long form: compare real paths
const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
const same = (a, b) => real(a).toLowerCase().replace(/\\/g, '/') === real(b).toLowerCase().replace(/\\/g, '/');

test('task folders go into one <project>.worktrees folder, named after the main folder even from inside a task', () => {
  const root = tempRepo();
  const a = prepareWorkspace({ root, id: 13, title: 'evidence' });
  assert.ok(same(a.worktree, join(root, '..', 'proj.worktrees', '13')), a.worktree);
  // the agent stands in task 13's folder and claims task 19: no "proj-wt-13-wt-19"
  assert.ok(same(mainRepoRoot(a.worktree), root));
  const b = prepareWorkspace({ root: a.worktree, id: 19, title: 'classroom' });
  assert.ok(same(b.worktree, taskFolder(root, 19)), b.worktree);
  assert.deepEqual(readdirSync(join(root, '..')).sort(), ['proj', 'proj.worktrees'], 'nothing else next to the project');
  assert.deepEqual(readdirSync(join(root, '..', 'proj.worktrees')).sort(), ['13', '19']);
});

test('a folder an older crew made (<project>-wt-<id>) is still reused for its task', () => {
  const root = tempRepo();
  const old = join(root, '..', 'proj-wt-5');
  g(root, 'worktree', 'add', '-q', '-b', 'crew/5-login', old, 'HEAD');
  writeFileSync(join(old, 'wip.txt'), 'work in progress');
  const again = prepareWorkspace({ root, id: 5, title: 'login' });
  assert.equal(again.reused, true);
  assert.ok(same(again.worktree, old));
  assert.ok(existsSync(join(again.worktree, 'wip.txt')));
});

test('automatic cleanup runs at most every few hours and never stops task next', () => {
  const root = tempRepo();
  let runs = 0;
  const deps = (now) => ({ now, run: () => { runs++; return { artifacts: { removed: ['x'] } }; }, prune: () => ['old.txt'] });
  const t0 = Date.parse('2026-11-25T08:00:00Z');
  assert.deepEqual(autoCleanup(root, deps(t0)), { removed: ['x'], logs_removed: ['old.txt'] });
  assert.equal(autoCleanup(root, deps(t0 + 3600_000)), null, 'an hour later: not yet');
  assert.ok(autoCleanup(root, deps(t0 + AUTO_CLEANUP_HOURS * 3600_000 + 1)));
  assert.equal(runs, 2);
  assert.ok(existsSync(join(root, '.crew', 'last-cleanup')), 'the stamp lives in the main folder');
  assert.equal(autoCleanup(root, { now: t0 + 99 * 3600_000, run: () => { throw new Error('gh down'); }, prune: () => [] }), null, 'an error is swallowed');
});

test('old logs are pruned: the newest are kept, older ones only while recent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-logs-'));
  const now = Date.parse('2026-11-25T08:00:00Z');
  for (let i = 0; i < 6; i++) {
    const f = join(dir, `check-${i}.txt`);
    writeFileSync(f, 'log');
    const t = new Date(now - i * 10 * 86_400_000); // 0, 10, 20, ... days old
    utimesSync(f, t, t);
  }
  writeFileSync(join(dir, 'notes.md'), 'not a log');
  assert.deepEqual(pruneLogs(dir, { keep: 2, days: 14, now }).sort(), ['check-2.txt', 'check-3.txt', 'check-4.txt', 'check-5.txt']);
  assert.deepEqual(readdirSync(dir).sort(), ['check-0.txt', 'check-1.txt', 'notes.md']);
  assert.deepEqual(pruneLogs(join(dir, 'missing')), []);
  mkdirSync(join(dir, 'sub'));
  assert.deepEqual(pruneLogs(dir, { keep: 0, days: 0, now: now + 1 }).sort(), ['check-0.txt', 'check-1.txt']);
});
