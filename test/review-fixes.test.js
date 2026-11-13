// Regression tests for the v1 review findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShell } from '../src/core/exec.js';
import { prepareWorkspace } from '../src/commands/task.js';
import { spawnSync } from 'node:child_process';
import { rmSync, readFileSync } from 'node:fs';
import { cwdScopeError } from '../src/core/registry.js';
import { recorded } from '../src/commands/worker.js';
import { mergePolicy } from '../src/commands/pr.js';
import { planSetup } from '../src/commands/github.js';

const g = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

function tempRepo() {
  const parent = mkdtempSync(join(tmpdir(), 'crew-ws-'));
  const root = join(parent, 'proj');
  g(parent, 'init', '-q', '-b', 'main', root);
  g(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  return root;
}

test('continuous merge: low/med - auto-merge without squash, high and draft - manual', () => {
  for (const r of ['low', 'med']) {
    const p = mergePolicy(r);
    assert.equal(p.auto, true);
    assert.ok(p.args.includes('--merge') && !p.args.includes('--squash'), 'squash would lose the Agent/Issue trailers');
  }
  assert.equal(mergePolicy('high').auto, false);
  assert.equal(mergePolicy(undefined).risk, 'med');
  assert.equal(mergePolicy('weird').risk, 'med');
  assert.equal(mergePolicy('low', { draft: true }).auto, false);
});

test('crew github setup: auto-merge is on; without an agent review main is not merged (crew-guard), manual approvals 0', () => {
  const plan = planSetup({ repo: 'o/r', labels: [] });
  const settings = plan.find((s) => s.id === 'repo-settings');
  assert.equal(settings.body.allow_auto_merge, true);
  assert.equal(settings.body.allow_merge_commit, true);
  assert.equal(settings.body.allow_squash_merge, false, 'squash loses the Agent and Closes trailers');
  assert.equal(settings.body.allow_rebase_merge, false);
  const prot = plan.find((s) => s.id.startsWith('branch-protection'));
  assert.equal(prot.body.required_pull_request_reviews.required_approving_review_count, 0);
  assert.ok(prot.body.required_status_checks.checks.some((c) => c.context === 'crew-guard'), 'the agent review is checked by the required crew-guard status');
});

test('#6 cwd is allowed only in its own project and its worktree', () => {
  const root = tempRepo();
  writeFileSync(join(root, 'crew.config.json'), '{}');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'cfg');
  const ws = prepareWorkspace({ root, id: 3, title: 'x' }); // a worktree of the same repo
  const other = tempRepo();
  writeFileSync(join(other, 'crew.config.json'), '{}'); // another crew project on the same machine
  const plain = mkdtempSync(join(tmpdir(), 'crew-plain-')); // not a project at all

  assert.equal(cwdScopeError(root, root), null);
  assert.equal(cwdScopeError(ws.worktree, root), null);
  assert.match(cwdScopeError(other, root), /outside the current project/);
  assert.match(cwdScopeError(plain, root), /not a crew project/);
  // crew is run outside a project: it is enough that cwd is a crew project
  assert.equal(cwdScopeError(other, plain), null);
});

test('#5 worker commands are written to the metrics with the agent id', async () => {
  const root = tempRepo();
  writeFileSync(join(root, 'crew.config.json'), '{}');
  const fake = { name: 'task claim', run: async () => ({ schema: 'crew/v1', status: 'success', summary: 'ok', next_actions: [], artifacts: { issue: 12 }, error: null }) };
  const prev = process.env.CREW_AGENT;
  process.env.CREW_AGENT = 'codex/test';
  try {
    await recorded(fake)({ id: 12, cwd: root });
  } finally {
    if (prev === undefined) delete process.env.CREW_AGENT; else process.env.CREW_AGENT = prev;
  }
  const ev = JSON.parse(readFileSync(join(root, '.crew', 'metrics.jsonl'), 'utf8').trim().split('\n').pop());
  assert.equal(ev.command, 'task claim');
  assert.match(ev.agent, /^codex\/test@/);
  assert.equal(ev.issue, 12);
  assert.equal(ev.status, 'success');
});

test('#2 a repeated claim reuses the branch and worktree instead of failing', () => {
  const root = tempRepo();
  const first = prepareWorkspace({ root, id: 5, title: 'Login form' });
  assert.equal(first.reused, false);
  assert.equal(first.branch, 'crew/5-login-form');
  writeFileSync(join(first.worktree, 'wip.txt'), 'previous attempt');

  const again = prepareWorkspace({ root, id: 5, title: 'Login form' });
  assert.equal(again.reused, true);
  assert.equal(again.branch, first.branch);
  assert.equal(again.worktree, first.worktree);
  assert.ok(existsSync(join(again.worktree, 'wip.txt')), 'the work of the previous attempt is preserved');

  // The task title was changed - the branch is still found by number.
  assert.equal(prepareWorkspace({ root, id: 5, title: 'Another title' }).branch, 'crew/5-login-form');
});

test('#2 the worktree folder was deleted by hand - claim recreates it on the old branch', () => {
  const root = tempRepo();
  const first = prepareWorkspace({ root, id: 7, title: 'api' });
  rmSync(first.worktree, { recursive: true, force: true });
  const again = prepareWorkspace({ root, id: 7, title: 'api' });
  assert.equal(again.reused, true);
  assert.equal(again.branch, 'crew/7-api');
  assert.ok(existsSync(again.worktree));
});

test('#2 no-worktree mode: a repeated claim switches to the existing branch', () => {
  const root = tempRepo();
  prepareWorkspace({ root, id: 9, title: 'x', no_worktree: true });
  g(root, 'checkout', '-q', 'main');
  const again = prepareWorkspace({ root, id: 9, title: 'x', no_worktree: true });
  assert.equal(again.reused, true);
  assert.equal(g(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim(), 'crew/9-x');
});

test('#1 the timeout kills the tree: a grandchild holding stdout does not hang crew check', () => {
  // The step starts a grandchild that holds the inherited stdout for 30 s. Before, spawnSync waited for all 30 s.
  const node = JSON.stringify(process.execPath);
  const grandchild = `require('child_process').spawn(${node},['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});setTimeout(()=>{},30000)`;
  const line = `${node} -e "${grandchild.replace(/"/g, '\\"')}"`;
  const t0 = Date.now();
  const r = runShell(line, { timeout_s: 1 });
  const ms = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.ok(ms < 15_000, `expected < 15 s, took ${ms} ms`);
});

test('#1 the timeout kills grandchildren: after 3 s the grandchild can no longer write a file', () => {
  // On Windows the old spawnSync returned on time, but the grandchild (dev server, agent) stayed alive.
  const dir = mkdtempSync(join(tmpdir(), 'crew-kill-'));
  const marker = join(dir, 'alive.txt');
  const gc = join(dir, 'grandchild.js');
  const parent = join(dir, 'parent.js');
  // Scripts in files - no nested quotes in cmd/sh.
  writeFileSync(gc, `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 3000);\n`);
  writeFileSync(parent, `require('child_process').spawn(process.execPath, [${JSON.stringify(gc)}], { stdio: 'inherit' });\nsetTimeout(() => {}, 30000);\n`);
  const r = runShell(`${JSON.stringify(process.execPath)} ${JSON.stringify(parent)}`, { timeout_s: 1 });
  assert.equal(r.timedOut, true);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4_000); // we wait longer than the grandchild sleeps
  assert.equal(existsSync(marker), false, 'the grandchild survived the timeout and wrote the file');
});

test('#1 a regular command: the exit code and output are preserved', () => {
  const r = runShell(`${JSON.stringify(process.execPath)} -e "console.log('hi');process.exit(3)"`, { timeout_s: 30 });
  assert.equal(r.timedOut, false);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /hi/);
});
