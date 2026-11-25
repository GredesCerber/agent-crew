// Tests of crew worker on fakes: no network, no GitHub, no real agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runWorker, taskPrompt, costFromLog } from '../src/commands/worker.js';
import { fail, warn, ok } from '../src/core/output.js';
import { findCommand, parseArgs, agentCommands } from '../src/core/registry.js';
import claude from '../adapters/claude/adapter.js';
import codex from '../adapters/codex/adapter.js';

/**
 * Fake board: a queue of ready tasks + what the agent "does" with a task (outcome -> new status).
 * outcome: 'review' | 'blocked' | 'claimed' (the agent handed in nothing) | 'timeout' | 'spawn_error'
 */
function fakeBoard({ queue, outcome = () => 'review', nextError = null } = {}) {
  const status = Object.fromEntries(queue.map((id) => [id, 'ready']));
  const calls = { next: 0, claim: [], release: [], spawn: [], logs: [] };
  const fakeAdapter = {
    headless: ({ prompt, model, cwd, writableDirs }) => ({ cmd: 'fake-agent', args: [cwd], input: prompt, model, writableDirs, env: { CREW_AGENT: `fake/${model}` } }),
  };
  const deps = {
    next: () => {
      calls.next++;
      if (nextError) return nextError(calls.next);
      const id = queue.find((n) => status[n] === 'ready');
      return id ? ok(`#${id}`, { artifacts: { issue: id } }) : warn('No free tasks');
    },
    claim: ({ id }) => {
      calls.claim.push({ id, agent: process.env.CREW_AGENT });
      status[id] = 'claimed';
      return ok(`Took #${id}`, { artifacts: { issue: id, branch: `crew/${id}-x`, worktree: `/wt/${id}` } });
    },
    release: ({ id, note }) => {
      calls.release.push({ id, note });
      status[id] = 'released';
      return ok('released');
    },
    viewIssue: (id) => ({ number: id, state: 'OPEN', labels: [{ name: `status:${status[id]}` }] }),
    spawn: async (spec, o) => {
      calls.spawn.push({ spec, ...o });
      const id = Number(spec.args[0].split('/').pop());
      const out = outcome(id);
      if (out === 'spawn_error') return { code: -1, error: 'ENOENT' };
      if (out === 'timeout') return { code: null, timedOut: true };
      status[id] = out;
      return { code: 0, timedOut: false };
    },
    adapters: { fake: fakeAdapter },
    loadConfig: () => ({ config: { tiers: { high: { fake: 'big' } } }, root: '/repo' }),
    gitCommonDir: () => '/repo/.git',
    sleep: async () => {},
    log: (l) => calls.logs.push(l),
    now: () => 0,
  };
  return { deps, calls, status };
}

test('worker: the happy path - handed in all tasks, the queue is empty', async () => {
  const { deps, calls } = fakeBoard({ queue: [1, 2] });
  const r = await runWorker({ host: 'fake' }, deps);
  assert.equal(r.status, 'success');
  assert.deepEqual(r.artifacts.done, [1, 2]);
  assert.deepEqual(r.artifacts.failed, []);
  assert.equal(r.artifacts.stopped_reason, 'no_tasks');
  assert.equal(r.artifacts.agent, 'fake/big'); // the model from tiers.high
  // claim on behalf of the same agent as the child process
  assert.ok(calls.claim.every((c) => c.agent === 'fake/big'));
  const s = calls.spawn[0];
  assert.equal(s.cwd, '/wt/1');
  assert.equal(s.env.CREW_AGENT, 'fake/big');
  assert.equal(s.timeoutMs, 60 * 60_000);
  assert.deepEqual(s.spec.writableDirs, ['/repo/.git']);
  assert.match(s.spec.input, /issue #1/);
  assert.equal(calls.release.length, 0);
  assert.equal(calls.logs.length, 4); // start + result for each task
});

test('worker: pause from task next - an immediate stop, takes nothing', async () => {
  const paused = () => fail('paused', 'The crew:pause issue is open', { stop_when: 'the pause is lifted' });
  const { deps, calls } = fakeBoard({ queue: [1], nextError: paused });
  const r = await runWorker({ host: 'fake' }, deps);
  assert.equal(r.status, 'success');
  assert.equal(r.artifacts.stopped_reason, 'paused');
  assert.equal(calls.claim.length, 0);
  assert.equal(calls.spawn.length, 0);
});

test('worker: pause from task claim - also a stop', async () => {
  const { deps, calls } = fakeBoard({ queue: [1] });
  deps.claim = () => fail('paused', 'The crew:pause issue is open');
  const r = await runWorker({ host: 'fake' }, deps);
  assert.equal(r.artifacts.stopped_reason, 'paused');
  assert.equal(calls.spawn.length, 0);
});

test('worker: 3 failures in a row - a release with a note and a stop', async () => {
  const { deps, calls } = fakeBoard({ queue: [1, 2, 3, 4, 5], outcome: (id) => (id === 2 ? 'timeout' : 'claimed') });
  const r = await runWorker({ host: 'fake', max_tasks: 10 }, deps);
  assert.equal(r.status, 'warning');
  assert.equal(r.artifacts.stopped_reason, 'max_failures');
  assert.deepEqual(r.artifacts.failed, [1, 2, 3]);
  assert.deepEqual(calls.release.map((c) => c.id), [1, 2, 3]);
  assert.match(calls.release[1].note, /timeout 60 min/);
  assert.match(calls.release[0].note, /\.crew[\\/]logs[\\/]worker-1-/);
  assert.equal(calls.spawn.length, 3);
});

test('worker: a success resets the failure counter, blocked is not a failure', async () => {
  const plan = { 1: 'claimed', 2: 'claimed', 3: 'review', 4: 'blocked', 5: 'claimed', 6: 'claimed' };
  const { deps } = fakeBoard({ queue: [1, 2, 3, 4, 5, 6], outcome: (id) => plan[id] });
  const r = await runWorker({ host: 'fake', max_tasks: 10, max_failures: 3 }, deps);
  assert.equal(r.artifacts.stopped_reason, 'no_tasks');
  assert.deepEqual(r.artifacts.done, [3]);
  assert.deepEqual(r.artifacts.blocked, [{ issue: 4, status: 'blocked' }]);
  assert.deepEqual(r.artifacts.failed, [1, 2, 5, 6]);
});

test('worker: the task limit', async () => {
  const { deps, calls } = fakeBoard({ queue: [1, 2, 3, 4] });
  const r = await runWorker({ host: 'fake', max_tasks: 2 }, deps);
  assert.equal(r.artifacts.stopped_reason, 'max_tasks');
  assert.deepEqual(r.artifacts.done, [1, 2]);
  assert.equal(calls.claim.length, 2);
});

test('worker: the agent does not start - the task is returned, a tool_missing error', async () => {
  const { deps, calls } = fakeBoard({ queue: [1, 2], outcome: () => 'spawn_error' });
  const r = await runWorker({ host: 'fake' }, deps);
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'tool_missing');
  assert.ok(r.error.retry && r.error.stop_when);
  assert.deepEqual(calls.release.map((c) => c.id), [1]);
  assert.equal(calls.spawn.length, 1);
});

test('worker: claim_conflict - takes the next one, 3 in a row - a stop', async () => {
  const { deps, calls } = fakeBoard({ queue: [1] });
  deps.claim = () => fail('claim_conflict', 'already taken by another');
  const r = await runWorker({ host: 'fake' }, deps);
  assert.equal(r.status, 'warning');
  assert.equal(r.artifacts.stopped_reason, 'claim_conflicts');
  assert.equal(calls.next, 3);
});

test('worker: --dry-run takes nothing; an unknown host and a next error - fail with the contract', async () => {
  const { deps, calls } = fakeBoard({ queue: [7] });
  const dry = await runWorker({ host: 'fake', dry_run: true }, deps);
  assert.equal(dry.status, 'success');
  assert.equal(dry.artifacts.issue, 7);
  assert.equal(calls.claim.length, 0);

  const nohost = await runWorker({ host: 'nope' }, deps);
  assert.equal(nohost.error.code, 'unknown_host');

  const { deps: d2 } = fakeBoard({ queue: [1], nextError: () => { throw new Error('gh crashed'); } });
  const r = await runWorker({ host: 'fake' }, d2);
  assert.equal(r.status, 'error');
  assert.equal(r.artifacts.stopped_reason, 'next_failed');
});

test('worker: --wait waits for new tasks instead of exiting', async () => {
  const { deps, calls, status } = fakeBoard({ queue: [1, 2] });
  status[2] = 'later';
  let slept = 0;
  deps.sleep = async () => { slept++; status[2] = 'ready'; };
  const r = await runWorker({ host: 'fake', wait: true, max_tasks: 2 }, deps);
  assert.equal(slept, 1);
  assert.deepEqual(r.artifacts.done, [1, 2]);
  assert.equal(calls.spawn.length, 2);
});

test('worker: CREW_AGENT is restored after the work', async () => {
  const before = process.env.CREW_AGENT;
  const { deps } = fakeBoard({ queue: [1] });
  await runWorker({ host: 'fake' }, deps);
  assert.equal(process.env.CREW_AGENT, before);
});

test('worker: the command is for humans only, arguments are parsed', () => {
  const c = findCommand(['worker']);
  assert.equal(c.agent, false);
  assert.ok(!agentCommands.includes(c));
  assert.deepEqual(parseArgs(c, ['--host', 'codex', '--max-tasks', '2', '--task-timeout-min', '30', '--dry-run']), {
    host: 'codex', max_tasks: 2, task_timeout_min: 30, dry_run: true,
  });
});

test('task prompt: one line, no characters dangerous for cmd /c', () => {
  const p = taskPrompt({ id: 12, branch: 'crew/12-login' });
  assert.ok(!/[\r\n"&|<>^%]/.test(p));
  assert.match(p, /#12/);
  assert.match(p, /crew-workflow/);
  assert.match(p, /crew pr open/);
});

test('headless: codex - worktree, workspace-write, network, JSON, the prompt via stdin', () => {
  const s = codex.headless({ prompt: 'P', model: 'gpt-x', cwd: '/wt/1', writableDirs: ['/repo/.git'], platform: 'linux' });
  assert.equal(s.cmd, 'codex');
  assert.equal(s.args[0], 'exec');
  for (const f of ['--json', '-C', '/wt/1', '-s', 'workspace-write', '--add-dir', '/repo/.git', '--model', 'gpt-x']) assert.ok(s.args.includes(f), f);
  assert.ok(s.args.includes('sandbox_workspace_write.network_access=true'));
  assert.equal(s.args.at(-1), '-');
  assert.equal(s.input, 'P');
  assert.equal(s.env.CREW_AGENT, 'codex/gpt-x');
  const w = codex.headless({ prompt: 'P', platform: 'win32', searchPath: '' });
  assert.deepEqual([w.cmd, w.args[0]], ['codex.exe', 'exec']);
  assert.equal(w.env.CREW_AGENT, 'codex/default');
});

test('headless: claude - -p and JSON, edits without questions, an explicit tool list, on Windows without cmd /c', () => {
  const s = claude.headless({ prompt: 'P', model: 'opus', platform: 'linux' });
  assert.deepEqual([s.cmd, ...s.args.slice(0, 8)], ['claude', '-p', 'P', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--model', 'opus']);
  const tools = s.args.slice(s.args.indexOf('--allowedTools') + 1);
  for (const t of ['Edit', 'Write', 'mcp__crew', 'Bash(crew:*)', 'Bash(npm:*)', 'Bash(git diff:*)']) assert.ok(tools.includes(t), t);
  for (const t of tools) assert.ok(!/^Bash\((git push|git commit|git reset|gh pr merge|rm)/.test(t) && t !== 'Bash', `extra permission: ${t}`);
  assert.equal(s.env.CREW_AGENT, 'claude/opus');
  const w = claude.headless({ prompt: 'P', platform: 'win32', searchPath: '' });
  assert.notEqual(w.cmd, 'cmd');
  assert.ok(!w.args.includes('/c'));
});

test('spawnAgent: the prompt in stdin, output to a log, a kill on timeout', async () => {
  const { spawnAgent } = await import('../src/commands/worker.js');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'crew-worker-'));
  const echo = { cmd: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], input: 'привет агент' }; // Russian on purpose: UTF-8 through stdin and the log
  const r = await spawnAgent(echo, { cwd: dir, env: { CREW_AGENT: 'x/y' }, timeoutMs: 30_000, logFile: join(dir, 'logs', 'a.log') });
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.equal(readFileSync(join(dir, 'logs', 'a.log'), 'utf8'), 'привет агент');

  const hang = { cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] };
  const t = await spawnAgent(hang, { cwd: dir, env: {}, timeoutMs: 300 });
  assert.equal(t.timedOut, true);

  const missing = await spawnAgent({ cmd: 'crew-no-such-binary-xyz', args: [] }, { cwd: dir, env: {}, timeoutMs: 1000 });
  assert.ok(missing.error);
});

test('worker budget: no new task after the time budget, and a task gets at most what is left', async () => {
  const { deps, calls } = fakeBoard({ queue: [1, 2, 3] });
  let clock = 0;
  deps.now = () => clock;
  const spawn = deps.spawn;
  deps.spawn = async (spec, o) => { const r = await spawn(spec, o); clock += 25 * 60_000; return r; }; // each task takes 25 min
  const r = await runWorker({ host: 'fake', budget_min: 60 }, deps);
  assert.equal(r.artifacts.stopped_reason, 'budget_time');
  assert.deepEqual(r.artifacts.done, [1, 2, 3], 'the third task started with 10 min left');
  assert.equal(calls.spawn[0].timeoutMs, 60 * 60_000);
  assert.equal(calls.spawn[2].timeoutMs, 10 * 60_000, 'capped by the remaining budget, not the 60 min task timeout');
  assert.equal(r.artifacts.elapsed_min, 75);
  assert.match(r.summary, /time budget of 60 min/);
});

test('worker budget: stop once the reported cost reaches the dollar budget; unknown cost stays null', async () => {
  const { deps } = fakeBoard({ queue: [1, 2, 3, 4] });
  deps.costOf = () => 0.6;
  const r = await runWorker({ host: 'fake', budget_usd: 1 }, deps);
  assert.equal(r.artifacts.stopped_reason, 'budget_cost');
  assert.deepEqual(r.artifacts.done, [1, 2]);
  assert.equal(r.artifacts.cost_usd, 1.2);
  const plain = fakeBoard({ queue: [1] });
  plain.deps.costOf = () => null;
  assert.equal((await runWorker({ host: 'fake' }, plain.deps)).artifacts.cost_usd, null, 'Codex reports no cost');
  assert.equal(costFromLog('{"type":"result","total_cost_usd":0.0421}\n'), 0.0421);
  assert.equal(costFromLog('{"type":"turn.completed","usage":{"input_tokens":10}}'), null);
});
