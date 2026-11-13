// Regression tests for roadmap v1 (steps 1-4): cwd for MCP tools, lease by commits,
// emergency stop crew:pause, timeouts of crew check steps. No network and no GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { callTool, handle } from '../src/mcp/server.js';
import { findCommand, validate } from '../src/core/registry.js';
import { claimNextActions, lastBranchCommitAt, pauseGuard } from '../src/commands/task.js';
import { isStale, isPaused } from '../src/core/issues.js';
import { DEFAULT_TIMEOUT_S } from '../src/commands/check.js';

const CREW = join(import.meta.dirname, '..', 'bin', 'crew.js');
const crew = (args, cwd, env = {}) => {
  const r = spawnSync(process.execPath, [CREW, ...args, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: JSON.parse(r.stdout) };
};
const gitIn = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A temporary project after crew init with a first commit. */
function initProject() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-fix-'));
  const proj = join(dir, 'demo');
  const init = crew(['init', proj], dir);
  assert.equal(init.out.status, 'success', JSON.stringify(init.out));
  gitIn(proj, 'config', 'user.email', 't@example.com');
  gitIn(proj, 'config', 'user.name', 'T');
  gitIn(proj, 'config', 'core.longpaths', 'true');
  gitIn(proj, 'add', '-A');
  gitIn(proj, 'commit', '-q', '-m', 'chore: init');
  return { dir, proj };
}

test('step 1: MCP tools with cwd get the argument in the schema and validate the path', async () => {
  const { tools } = await handle({ id: 1, method: 'tools/list' });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ['crew_check', 'crew_commit', 'crew_pr_open', 'crew_task_claim', 'crew_compliance_check']) {
    assert.equal(byName[n].inputSchema.properties.cwd?.type, 'string', `${n} has no cwd`);
  }
  assert.equal(byName.crew_task_next.inputSchema.properties.cwd, undefined, 'task next does not touch the working copy');
  const commit = findCommand(['commit']);
  assert.match(validate(commit, { m: 'x', cwd: 'relative/path' }), /absolute/);
  assert.match(validate(commit, { m: 'x', cwd: join(tmpdir(), 'crew-no-such-dir-' + Date.now()) }), /does not exist/);
  const acts = claimNextActions(7, 'C:\\work\\demo-wt-7');
  assert.ok(acts.some((a) => a.includes('cwd') && a.includes(JSON.stringify('C:\\work\\demo-wt-7'))));
});

test('step 1: crew_commit via MCP with cwd commits to the task branch in the worktree, not the root', async () => {
  const { dir, proj } = initProject();
  const wt = join(dir, 'demo-wt-7');
  gitIn(proj, 'worktree', 'add', '-q', '-b', 'crew/7-x', wt);
  const rootHead = gitIn(proj, 'rev-parse', 'HEAD');
  const rootBranch = gitIn(proj, 'symbolic-ref', '--short', 'HEAD');
  writeFileSync(join(wt, 'feature.txt'), 'hello\n');
  writeFileSync(join(proj, 'root-only.txt'), 'must not end up in the commit\n');

  // The MCP server is started in the project root, like in Claude Code / Codex.
  const prev = process.cwd();
  process.chdir(proj);
  let res;
  try {
    res = await callTool('crew_commit', { m: 'feat: x', cwd: wt });
  } finally {
    process.chdir(prev);
  }
  assert.ok(['success', 'warning'].includes(res.status), JSON.stringify(res)); // warning: the lease cannot be checked without GitHub
  assert.equal(res.artifacts.issue, 7);
  assert.equal(gitIn(wt, 'log', '-1', '--format=%s', 'crew/7-x'), 'feat: x');
  assert.equal(gitIn(wt, 'log', '-1', '--format=%(trailers:key=Issue,valueonly)', 'crew/7-x'), '#7');
  assert.equal(gitIn(wt, 'show', '--name-only', '--format=', 'crew/7-x'), 'feature.txt');
  // the root is untouched: same branch, same HEAD, its file is not committed
  assert.equal(gitIn(proj, 'symbolic-ref', '--short', 'HEAD'), rootBranch);
  assert.equal(gitIn(proj, 'rev-parse', 'HEAD'), rootHead);
  assert.match(gitIn(proj, 'status', '--porcelain'), /root-only\.txt/);
});

test('step 2: the lease is extended by commits to the task branch', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const base = { now, leaseMinutes: 45 };
  // marker and issue are old, but the commit is 10 minutes ago -> a live agent
  assert.equal(isStale({ ...base, lastMarkerAt: ago(60), issueUpdatedAt: ago(60), lastCommitAt: ago(10) }), false);
  // everything is older than the lease -> expired
  assert.equal(isStale({ ...base, lastMarkerAt: ago(60), issueUpdatedAt: ago(60), lastCommitAt: ago(60) }), true);
  // no branch yet - the marker decides, and without a marker - updatedAt
  assert.equal(isStale({ ...base, lastMarkerAt: ago(5), issueUpdatedAt: ago(60), lastCommitAt: null }), false);
  assert.equal(isStale({ ...base, issueUpdatedAt: ago(60) }), true);
  // no data at all - do not take it away
  assert.equal(isStale({ ...base }), false);
});

test('step 2: date of the last commit of branch origin/crew/<id>-* without the network', () => {
  const { proj } = initProject();
  gitIn(proj, 'update-ref', 'refs/remotes/origin/crew/7-x', 'HEAD');
  gitIn(proj, 'update-ref', 'refs/remotes/origin/crew/70-other', 'HEAD');
  const at = lastBranchCommitAt(7, proj);
  assert.ok(at && Math.abs(Date.now() - Date.parse(at)) < 10 * 60_000, `date: ${at}`);
  assert.equal(lastBranchCommitAt(8, proj), null);
  assert.equal(lastBranchCommitAt(70, proj) !== null, true);
});

test('step 3: crew:pause stops task next / task claim', () => {
  const pause = { number: 99, title: 'STOP', labels: [{ name: 'crew:pause' }] };
  const other = { number: 5, title: 'x', labels: [{ name: 'status:ready' }] };
  assert.equal(isPaused([]), false);
  assert.equal(isPaused([other]), false);
  assert.equal(isPaused([other, pause]), true);
  assert.equal(isPaused([{ ...pause, state: 'CLOSED' }]), false, 'a closed issue lifts the pause');
  assert.equal(pauseGuard([other]), null);
  const r = pauseGuard([pause]);
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'paused');
  assert.equal(r.error.stop_when, 'always — wait until a human closes the crew:pause issue');
  assert.ok(r.error.cause_hint && r.error.retry && r.next_actions.length);
  assert.deepEqual(r.artifacts.pause_issues, [99]);
});

test('step 4: a hanging crew check step is stopped by timeout_s -> ci_red', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-timeout-'));
  writeFileSync(
    join(dir, 'crew.config.json'),
    JSON.stringify({ check: [{ name: 'hang', run: 'node -e "setTimeout(()=>{},5000)"', timeout_s: 1 }] }),
  );
  const t0 = Date.now();
  const res = await callTool('crew_check', { cwd: dir });
  const took = Date.now() - t0;
  assert.equal(res.status, 'error', JSON.stringify(res));
  assert.equal(res.error.code, 'ci_red');
  assert.match(res.error.cause_hint, /timeout/);
  assert.match(res.error.cause_hint, /hang/);
  assert.deepEqual(res.artifacts.timed_out, ['hang']);
  assert.ok(took < 4500, `step was not killed by the timeout: ${took} ms`);
  assert.equal(DEFAULT_TIMEOUT_S, 600);
});
