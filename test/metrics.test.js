// Tests of the metrics log: aggregation (a pure function), writing without exceptions,
// a shared log for worktrees, the hook in bin/crew.js and the crew metrics command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { aggregate, recordEvent, readEvents, metricsRoot, branchIssue, parseSince, filterEvents, eventFromResult, humanMs } from '../src/core/metrics.js';
import { ok, fail } from '../src/core/output.js';

const CREW = join(import.meta.dirname, '..', 'bin', 'crew.js');
const crew = (args, cwd, env = {}) => {
  const r = spawnSync(process.execPath, [CREW, ...args, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, CREW_METRICS: '', ...env } });
  return { code: r.status, out: JSON.parse(r.stdout) };
};
const git = (args, cwd) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' });

const ev = (command, agent, at, extra = {}) => ({ command, agent, at: `2026-12-05T${at}:00.000Z`, status: 'success', error_code: null, duration_ms: 10, issue: null, ...extra });

test('aggregate: completion rate, checks per task, median claim->PR, top errors', () => {
  const events = [
    ev('task claim', 'codex/x', '10:00', { issue: 1 }),
    ev('check', 'codex/x', '10:10', { issue: 1, status: 'error', error_code: 'ci_red' }),
    ev('check', 'codex/x', '10:20', { issue: 1 }),
    ev('pr open', 'codex/x', '10:30', { issue: 1 }),
    ev('task claim', 'codex/x', '11:00', { issue: 2 }),
    ev('check', 'codex/x', '11:05', { issue: 2, status: 'error', error_code: 'ci_red' }),
    ev('task claim', 'claude/opus', '10:00', { issue: 3 }),
    ev('check', 'claude/opus', '10:05', { issue: 3 }),
    ev('pr open', 'claude/opus', '10:10', { issue: 3 }),
    ev('task claim', 'claude/opus', '10:15', { issue: 4, status: 'error', error_code: 'claim_conflict' }),
    ev('task claim', 'claude/opus', '10:20', { issue: 5 }),
    ev('pr open', 'claude/opus', '10:40', { issue: 5 }),
    ev('pr open', 'claude/opus', '10:50', { issue: 5 }), // a repeat - does not affect the time
  ];
  const agg = aggregate(events);
  assert.equal(agg.total, events.length);
  const codex = agg.agents.find((a) => a.agent === 'codex/x');
  const claude = agg.agents.find((a) => a.agent === 'claude/opus');
  assert.equal(codex.claims, 2);
  assert.equal(codex.prs, 1);
  assert.equal(codex.completion_rate, 0.5);
  assert.equal(codex.retries_per_task, 1.5); // 2 checks for #1, 1 for #2
  assert.equal(codex.median_claim_to_pr_ms, 30 * 60_000);
  assert.equal(codex.check_failures, 2);
  assert.equal(claude.claims, 2); // a failed claim does not count
  assert.equal(claude.median_claim_to_pr_ms, 15 * 60_000); // median of 10 and 20 minutes
  assert.deepEqual(agg.top_errors, [{ code: 'ci_red', count: 2 }, { code: 'claim_conflict', count: 1 }]);
});

test('aggregate: an empty log and the top-5 errors', () => {
  assert.deepEqual(aggregate([]), { total: 0, agents: [], top_errors: [] });
  const many = 'abcdefg'.split('').flatMap((c, i) => Array.from({ length: i + 1 }, () => ev('check', 'a', '10:00', { status: 'error', error_code: c })));
  const top = aggregate(many).top_errors;
  assert.equal(top.length, 5);
  assert.equal(top[0].code, 'g');
  assert.equal(aggregate(many).agents[0].completion_rate, null); // there were no claims
});

test('filters: --since and --agent', () => {
  const now = Date.parse('2026-12-05T12:00:00Z');
  assert.equal(parseSince('2h', now), now - 2 * 3_600_000);
  assert.equal(parseSince('2026-12-05', now), Date.parse('2026-12-05'));
  assert.equal(parseSince('yesterday', now), null);
  assert.equal(parseSince(undefined, now), null);
  const events = [ev('check', 'codex/a', '09:00'), ev('check', 'codex/b', '11:30'), ev('check', 'claude/opus', '11:30'), ev('check', 'codexy', '11:30')];
  assert.equal(filterEvents(events, { agent: 'codex' }).length, 2);
  assert.equal(filterEvents(events, { agent: 'codex/a' }).length, 1);
  assert.equal(filterEvents(events, { sinceMs: parseSince('1h', now) }).length, 3);
  assert.equal(humanMs(95_000), '1m 35s');
  assert.equal(humanMs(null), '-');
});

test('eventFromResult: the task from arguments, artifacts or the branch', () => {
  const e = eventFromResult({ command: 'task claim', opts: { id: 7 }, result: ok('x'), agent: 'a', started: Date.now() - 5 });
  assert.equal(e.issue, 7);
  assert.equal(e.status, 'success');
  assert.ok(e.duration_ms >= 0);
  const f = eventFromResult({ command: 'commit', result: fail('nothing_to_commit', 'x', { artifacts: { issue: 9 } }), agent: 'a' });
  assert.equal(f.issue, 9);
  assert.equal(f.error_code, 'nothing_to_commit');
  assert.equal(f.duration_ms, null);
});

test('recordEvent never throws and skips broken lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-m-'));
  const file = join(dir, 'not-a-dir');
  writeFileSync(file, 'x');
  assert.equal(recordEvent(file, { command: 'check' }), false); // .crew cannot be created inside a file
  assert.equal(recordEvent(null, { command: 'check' }), false);
  assert.equal(recordEvent(dir, { command: 'check', status: 'success' }), true);
  writeFileSync(join(dir, '.crew', 'metrics.jsonl'), readFileSync(join(dir, '.crew', 'metrics.jsonl'), 'utf8') + '{"broken\n');
  assert.equal(recordEvent(dir, { command: 'pr open', status: 'success' }), true);
  const events = readEvents(dir);
  assert.deepEqual(events.map((e) => e.command), ['check', 'pr open']);
  assert.deepEqual(Object.keys(events[0]), ['command', 'issue', 'agent', 'status', 'error_code', 'duration_ms', 'at']);
});

test('a worktree writes to the shared log of the main repo; the task is taken from the branch', () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'crew-wt-'))); // Windows: short 8.3 names
  const main = join(dir, 'app');
  mkdirSync(main);
  git(['init', '-q', '-b', 'main'], main);
  writeFileSync(join(main, 'crew.config.json'), '{}');
  git(['add', '-A'], main);
  git(['commit', '-q', '-m', 'init'], main);
  const wt = join(dir, 'app-wt-12');
  assert.equal(git(['worktree', 'add', '-q', '-b', 'crew/12-login', wt], main).status, 0);
  assert.equal(metricsRoot(wt), main);
  assert.equal(metricsRoot(main), main);
  assert.equal(branchIssue(wt), 12);
  assert.equal(branchIssue(main), null);

  // the hook in bin/crew.js: a command in a worktree -> an event in the main repo log with the task number from the branch
  const r = crew(['check'], wt, { CREW_AGENT: 'codex/test' });
  assert.equal(r.out.error.code, 'no_checks');
  assert.ok(existsSync(join(main, '.crew', 'metrics.jsonl')));
  assert.ok(!existsSync(join(wt, '.crew', 'metrics.jsonl')));
  const [e] = readEvents(main);
  assert.equal(e.command, 'check');
  assert.equal(e.issue, 12);
  assert.match(e.agent, /^codex\/test@/);
  assert.equal(e.error_code, 'no_checks');
  assert.ok(e.duration_ms >= 0);

  // crew metrics sees the event; CREW_METRICS=off disables writing
  const m = crew(['metrics', '--agent', 'codex'], main, { CREW_AGENT: 'human' });
  assert.equal(m.out.status, 'success', JSON.stringify(m.out));
  assert.match(m.out.artifacts.agents[0].agent, /^codex\/test@/);
  assert.deepEqual(m.out.artifacts.top_errors, [{ code: 'no_checks', count: 1 }]);
  const before = readEvents(main).length;
  crew(['check'], wt, { CREW_METRICS: 'off' });
  assert.equal(readEvents(main).length, before);
});

test('crew metrics: an empty log -> warning, a bad --since -> bad_input; outside a project it does not write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-m2-'));
  writeFileSync(join(dir, 'crew.config.json'), '{}');
  const empty = crew(['metrics', '--agent', 'nobody'], dir);
  assert.equal(empty.out.status, 'warning');
  assert.equal(crew(['metrics', '--since', 'sometime'], dir).out.error.code, 'bad_input');
  const bare = mkdtempSync(join(tmpdir(), 'crew-m3-'));
  crew(['metrics'], bare);
  assert.ok(!existsSync(join(bare, '.crew')));
});
