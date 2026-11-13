// Tests for crew eval without real agents: task validation, scoring (pure score), judges on a fixture,
// a run with fake adapters (a node one-liner instead of an agent), --dry-run via the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  validateTask, loadTasks, parseAgents, passAtK, score, extractCost, prepareRepo, runJudges, runEval, reportTable, globToRegExp,
} from '../src/commands/eval.js';

const ROOT = join(import.meta.dirname, '..');
const TASKS = join(ROOT, 'evals', 'tasks');
const CREW = join(ROOT, 'bin', 'crew.js');
const crew = (args, cwd = ROOT) => {
  const r = spawnSync(process.execPath, [CREW, ...args, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, CREW_METRICS: 'off' } });
  return { code: r.status, out: JSON.parse(r.stdout) };
};

/** Fake adapter: instead of an agent - node -e "<code>" in the working copy. Remembers where it was run. */
const fake = (key, code, seen = []) => ({
  key,
  adapter: {
    headless: ({ prompt, cwd }) => {
      assert.ok(prompt.length > 0);
      seen.push(cwd);
      return { cmd: process.execPath, args: ['-e', code], env: { CREW_AGENT: key } };
    },
  },
});

test('validateTask: required fields and judges', () => {
  const good = { name: 'x', prompt: 'p', repo: '.', judge: [{ type: 'command', command: 'node -v' }] };
  assert.deepEqual(validateTask(good), []);
  const errs = validateTask({ name: 'Bad Name', repo: 'no-such-folder', commit: 'zzz', judge: [{ type: 'llm' }, { type: 'grep', pattern: '(' }] });
  assert.ok(errs.some((e) => e.startsWith('name')));
  assert.ok(errs.some((e) => e.startsWith('prompt')));
  assert.ok(errs.some((e) => e.startsWith('repo')));
  assert.ok(errs.some((e) => e.startsWith('commit')));
  assert.ok(errs.some((e) => e.startsWith('judge[0].type')));
  assert.ok(errs.some((e) => e.startsWith('judge[1].pattern')));
  assert.ok(errs.some((e) => e.startsWith('judge[1].files')));
  assert.deepEqual(validateTask([]), ['a task must be a JSON object']);
  // compatibility with agent-eval: pytest = command
  assert.deepEqual(validateTask({ ...good, judge: [{ type: 'pytest', command: 'pytest -q' }] }), []);
});

test('grep judge: paths, globs and absent', () => {
  assert.ok(globToRegExp('src/**/*.js').test('src/a/b/c.js'));
  assert.ok(globToRegExp('src/**/*.js').test('src/c.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/c.js'));
  assert.ok(globToRegExp('test/?.test.js').test('test/a.test.js'));
  const dir = mkdtempSync(join(tmpdir(), 'crew-ev-g-'));
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'src', 'deep', 'x.js'), 'class RetryPolicy {}');
  const task = { dir, judge: [
    { type: 'grep', pattern: 'class.*Retry', files: 'src/**/*.js' },
    { type: 'grep', pattern: 'TODO', files: ['src/**/*.js'], absent: true },
    { type: 'grep', pattern: 'x', files: 'no/such-file.js' },
    { type: 'pytest', command: 'node -e "process.exit(0)"' },
  ] };
  assert.deepEqual(runJudges(task, dir).map((j) => j.pass), [true, true, false, true]);
});

test('loadTasks: examples in evals/tasks are valid, duplicates and broken JSON are errors', () => {
  const { tasks, errors } = loadTasks(TASKS);
  assert.deepEqual(errors, []);
  assert.ok(tasks.length >= 3 && tasks.length <= 5);
  for (const t of tasks) assert.ok(existsSync(t.repoPath), t.name);
  assert.deepEqual(loadTasks(TASKS, { only: ['fix-off-by-one'] }).tasks.map((t) => t.name), ['fix-off-by-one']);

  const dir = mkdtempSync(join(tmpdir(), 'crew-ev-'));
  const t = { name: 'dup', prompt: 'p', repo: '.', judge: [{ type: 'command', command: 'node -v' }] };
  writeFileSync(join(dir, 'a.json'), JSON.stringify(t));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(t));
  writeFileSync(join(dir, 'c.json'), '{ not json');
  const res = loadTasks(dir);
  assert.equal(res.tasks.length, 1);
  assert.equal(res.errors.length, 2);
});

test('parseAgents: hosts and models', () => {
  assert.deepEqual(parseAgents('claude, codex:gpt-5'), [
    { key: 'claude', host: 'claude', model: undefined },
    { key: 'codex:gpt-5', host: 'codex', model: 'gpt-5' },
  ]);
  assert.deepEqual(parseAgents(''), []);
});

test('passAtK and score: pass@1, pass@k, stability, time, cost', () => {
  assert.equal(passAtK(3, 0, 3), 0);
  assert.equal(passAtK(3, 1, 3), 1);
  assert.ok(Math.abs(passAtK(3, 1, 1) - 1 / 3) < 1e-9);
  assert.ok(Math.abs(passAtK(5, 2, 2) - 0.7) < 1e-9); // 1 - C(3,2)/C(5,2)
  const r = (agent, task, pass, ms, cost = null) => ({ agent, task, pass, duration_ms: ms, cost_usd: cost, error: null });
  const results = [
    r('claude', 'a', true, 1000, 0.1), r('claude', 'a', true, 2000, 0.3), r('claude', 'a', false, 3000, 0.2),
    r('claude', 'b', true, 1000), r('claude', 'b', true, 1000), r('claude', 'b', true, 1000),
    r('codex', 'a', false, 500), r('codex', 'a', false, 500), r('codex', 'a', false, 800),
  ];
  const s = score(results);
  const ca = s.by_task.find((t) => t.agent === 'claude' && t.task === 'a');
  assert.deepEqual(
    { runs: ca.runs, passes: ca.passes, k: ca.k, p1: ca.pass_at_1, pk: ca.pass_at_k, cons: ca.consistency, t: ca.avg_time_ms, c: ca.avg_cost_usd },
    { runs: 3, passes: 2, k: 3, p1: 0.67, pk: 1, cons: 0.67, t: 2000, c: 0.2 },
  );
  const xa = s.by_task.find((t) => t.agent === 'codex');
  assert.equal(xa.pass_at_k, 0);
  assert.equal(xa.consistency, 1); // fails consistently
  assert.equal(xa.avg_cost_usd, null);
  const claude = s.by_agent.find((a) => a.agent === 'claude');
  assert.deepEqual([claude.tasks, claude.runs, claude.pass_at_1, claude.pass_at_k, claude.total_cost_usd], [2, 6, 0.83, 1, 0.6]);
  assert.match(reportTable(s), /pass@3/);
  assert.deepEqual(score([]), { by_task: [], by_agent: [] });
});

test('extractCost: claude JSON, JSONL, text', () => {
  assert.equal(extractCost(JSON.stringify({ type: 'result', total_cost_usd: 0.0421, result: 'ok' })), 0.0421);
  assert.equal(extractCost('{"type":"start"}\n{"type":"done","usage":{"cost_usd":0.5}}\n'), 0.5);
  assert.equal(extractCost('plain text'), null);
  assert.equal(extractCost(''), null);
});

test('judges: on an untouched fixture all examples fail (tasks are not pre-solved)', () => {
  for (const task of loadTasks(TASKS).tasks) {
    const repo = prepareRepo(task);
    try {
      assert.ok(existsSync(join(repo.workdir, 'package.json')));
      assert.ok(!existsSync(join(repo.workdir, 'node_modules')));
      const judges = runJudges(task, repo.workdir);
      assert.equal(judges.length, task.judge.length);
      assert.ok(!judges.every((j) => j.pass), `${task.name}: the task is "solved" without an agent`);
      assert.ok(existsSync(join(repo.workdir, '.crew-eval')), 'hidden tests are copied after the agent worked');
    } finally {
      repo.cleanup();
    }
    assert.ok(!existsSync(repo.tmp), 'the temporary copy is removed');
  }
});

test('runEval: a fake agent solves the task, an empty one does not, a missing one is agent_failed', () => {
  const [task] = loadTasks(TASKS, { only: ['fix-off-by-one'] }).tasks;
  const solve = [
    "const fs=require('fs');",
    "fs.writeFileSync('src/pager.js',fs.readFileSync('src/pager.js','utf8').replace('page * size','(page - 1) * size'));",
    "fs.appendFileSync('test/pager.test.js','\\n// first page test\\n');",
    "console.log(JSON.stringify({type:'result',total_cost_usd:0.01}));",
  ].join('');
  const seen = [];
  const missing = { key: 'ghost', adapter: { headless: () => ({ cmd: 'crew-eval-no-such-binary-xyz', args: [] }) } };
  const logs = [];
  const results = runEval({
    tasks: [task],
    agents: [fake('solver', solve, seen), fake('noop', '0', seen), missing],
    runs: 2,
    log: (s) => logs.push(s),
  });
  assert.equal(results.length, 6);
  const of = (a) => results.filter((r) => r.agent === a);
  assert.ok(of('solver').every((r) => r.pass), JSON.stringify(of('solver')[0].judges));
  assert.ok(of('solver').every((r) => r.cost_usd === 0.01));
  assert.ok(of('noop').every((r) => !r.pass && r.cost_usd === null));
  assert.ok(of('noop')[0].judges.some((j) => !j.pass && j.type === 'command'));
  assert.ok(of('ghost').every((r) => !r.pass && r.error.startsWith('agent_failed')));
  assert.ok(of('ghost')[0].duration_ms !== null && of('ghost')[1].duration_ms === null, 'after the first failure the run is skipped');
  assert.equal(new Set(seen).size, 4, 'each run has its own fresh copy');
  for (const d of seen) assert.ok(!existsSync(d), `copy not removed: ${d}`);
  assert.ok(logs.length >= 4);

  const s = score(results);
  assert.deepEqual(s.by_agent.map((a) => [a.agent, a.pass_at_1, a.pass_at_k]), [['solver', 1, 1], ['noop', 0, 0], ['ghost', 0, 0]]);
});

test('runEval: agent timeout, --keep and pinned commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-ev-pin-'));
  const repo = join(dir, 'fx');
  mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(repo, 'v.txt'), 'old');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(repo, 'v.txt'), 'new');
  git('commit', '-q', '-am', 'two');
  const task = {
    name: 'pin', prompt: 'p', repo, repoPath: repo, dir, commit: sha,
    judge: [{ type: 'grep', pattern: '^old$', files: 'v.txt' }],
  };
  const [pinned] = runEval({ tasks: [task], agents: [fake('noop', '0')], runs: 1, keep: true });
  assert.equal(pinned.pass, true, 'the working copy is on the pinned commit');
  assert.equal(readFileSync(join(pinned.workdir, 'v.txt'), 'utf8'), 'old');
  assert.match(join(pinned.workdir, '..'), /crew-eval-pin-/); // workdir = <tmp>/repo; only <tmp> is removed
  rmSync(join(pinned.workdir, '..'), { recursive: true, force: true });

  const slow = { ...task, commit: undefined, timeout_s: 1 };
  const [timedOut] = runEval({ tasks: [slow], agents: [fake('sleepy', 'setTimeout(()=>{},5000)')], runs: 1 });
  assert.equal(timedOut.pass, false);
  assert.match(timedOut.error, /^timeout/);
});

test('CLI: crew eval --dry-run shows the plan, bad tasks -> bad_task, an agent without an adapter -> unknown_agent', () => {
  const plan = crew(['eval', '--dry-run', '--agents', 'claude,codex:gpt-5', '--runs', '2']);
  assert.equal(plan.out.status, 'success', JSON.stringify(plan.out));
  assert.equal(plan.out.artifacts.total, plan.out.artifacts.tasks.length * 2 * 2);
  assert.deepEqual(plan.out.artifacts.agents, ['claude', 'codex:gpt-5']);

  const dir = mkdtempSync(join(tmpdir(), 'crew-ev-bad-'));
  writeFileSync(join(dir, 'x.json'), JSON.stringify({ name: 'x' }));
  const bad = crew(['eval', '--dry-run', '--tasks', dir]);
  assert.equal(bad.code, 1);
  assert.equal(bad.out.error.code, 'bad_task');
  assert.ok(bad.out.error.cause_hint.includes('prompt'));

  assert.equal(crew(['eval', '--dry-run', '--agents', 'gemini']).out.error.code, 'unknown_agent');
  assert.equal(crew(['eval', '--dry-run', '--task', 'nope']).out.error.code, 'no_tasks');
  assert.equal(crew(['eval', '--dry-run', '--runs', '0']).out.error.code, 'bad_input');
});
