// The factory: stations and their skill kits (crew task next names them), the review station of crew worker, and
// crew factory's view of the line. Stubs only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stationOf, kitFor, defaultKits, withKit } from '../src/core/stations.js';
import { runWorker, reviewPrompt } from '../src/commands/worker.js';
import { factoryView, staffing } from '../src/commands/factory.js';
import { findCommand, agentCommands } from '../src/core/registry.js';
import { ok, warn } from '../src/core/output.js';

test('stations: which station a piece of work belongs to, and its kit of the skills the project has', () => {
  assert.equal(stationOf({ kind: 'task', area: 'web' }), 'build');
  assert.equal(stationOf({ kind: 'task', area: 'research' }), 'research');
  assert.equal(stationOf({ kind: 'fix' }), 'build');
  assert.equal(stationOf({ kind: 'review' }), 'review');
  assert.equal(stationOf({ kind: 'merge' }), null);
  assert.equal(stationOf(undefined), null);
  const kits = defaultKits({ common: ['search-first'], builder: ['tdd-workflow'], reviewer: ['security-review'], qa: [] });
  assert.deepEqual(kits.build, ['crew-workflow', 'tdd-workflow', 'search-first']);
  assert.deepEqual(kits.review, ['crew-review', 'security-review', 'search-first']);
  const present = new Set(['crew-review', 'security-review']);
  assert.deepEqual(kitFor('review', { present }).skills, ['crew-review', 'security-review']);
  assert.deepEqual(kitFor('review', { config: { stations: { review: { skills: ['mine', 'crew-review'] } } }, present }), { station: 'review', skills: ['crew-review'], missing: ['mine'] }, 'the project can set its own kit');

  const r = withKit(ok('Review first', { artifacts: { kind: 'review', pr: 4 }, next_actions: ['crew pr review 4'] }), { config: {}, present });
  assert.deepEqual(r.artifacts.kit, { station: 'review', skills: ['crew-review', 'security-review'] });
  assert.equal(r.next_actions.at(-1), 'station review: use the skills crew-review, security-review');
  const idle = warn('No free tasks', { artifacts: { idle: true } });
  assert.equal(withKit(idle, { config: {}, present }), idle, 'nothing handed out, nothing added');
});

function reviewBoard({ prs, verdicts }) {
  const calls = { next: [], spawn: [], logs: [] };
  const queue = [...prs];
  const deps = {
    next: (o) => {
      calls.next.push(o);
      const pr = queue.shift();
      return pr ? ok(`Review #${pr}`, { artifacts: { kind: 'review', pr } }) : warn('No PR waits for your review', { artifacts: { idle: true } });
    },
    claim: () => assert.fail('a review takes no task'),
    spawn: async (spec, o) => { calls.spawn.push({ spec, ...o }); return { code: 0 }; },
    reviewedBy: ({ pr }) => verdicts.includes(pr),
    adapters: { fake: { headless: ({ prompt, cwd }) => ({ cmd: 'fake-agent', args: [cwd], input: prompt, env: {} }) } },
    loadConfig: () => ({ config: { tiers: { high: { fake: 'big' } } }, root: '/repo' }),
    sleep: async () => {},
    log: (l) => calls.logs.push(l),
    now: () => 0,
    costOf: () => null,
  };
  return { deps, calls };
}

test('crew worker --station review: reviews only, in the main folder, counted when the verdict is on the PR', async () => {
  const { deps, calls } = reviewBoard({ prs: [7, 8], verdicts: [7] });
  const r = await runWorker({ host: 'fake', station: 'review' }, deps);
  assert.deepEqual(calls.next[0], { tier: 'high', reviews_only: true });
  assert.deepEqual(calls.spawn.map((s) => s.cwd), ['/repo', '/repo']);
  assert.match(calls.spawn[0].spec.input, /Review pull request #7 and nothing else/);
  assert.deepEqual([r.artifacts.done, r.artifacts.failed, r.artifacts.stopped_reason], [[7], [8], 'no_tasks']);
  assert.doesNotMatch(reviewPrompt({ pr: 3 }), /["&|<>^%]|\n/, 'one line without characters cmd /c breaks on');

  const dry = await runWorker({ host: 'fake', station: 'review', dry_run: true }, reviewBoard({ prs: [9], verdicts: [] }).deps);
  assert.match(dry.summary, /would review PR #9/);
  assert.equal((await runWorker({ host: 'fake', station: 'deploy' }, deps)).error.code, 'bad_input');
});

test('crew factory: the line, the bottleneck with the worker to start, Actions, reviews that are not reviews', () => {
  assert.deepEqual(staffing(['claude', 'codex']).review, 'crew worker --host codex --station review --wait', 'the reviewer is from the other vendor');
  assert.match(staffing(['claude']).review, /--host claude/);
  const flow = {
    wip: { 'status:ready': 4, 'status:waiting': 1, 'status:claimed': 2, 'status:review': 3 },
    stations: { queue: { median_ms: 5_000_000, n: 9 }, build: { median_ms: 600_000, n: 9 }, review: { median_ms: 11_000, n: 20 } },
    bottleneck: 'queue', bypassed: [5, 6], throughput_per_week: 12, lead_ms: 9_000_000,
  };
  const v = factoryView({ flow, config: { hosts: ['claude', 'codex'] }, present: new Set(['crew-workflow']), actions: { state: 'blocked', reason: 'billing' } });
  assert.deepEqual(v.stations.map((s) => [s.station, s.wip]), [['queue', 5], ['build', 2], ['review', 3]]);
  assert.deepEqual(v.stations[1].kit, ['crew-workflow']);
  assert.ok(v.stations[2].kit_missing.includes('crew-review'));
  assert.match(v.advice[0], /^bottleneck: queue\. crew worker --host claude --station build --wait/);
  assert.match(v.advice.join('\n'), /GitHub Actions do not run \(billing\)/);
  assert.match(v.advice.join('\n'), /2 merged PR\(s\) closed no task/);
  assert.match(v.advice.join('\n'), /review takes 11s at the median/);
  assert.match(v.advice.join('\n'), /no skills in the kit of: review/);
  assert.equal(factoryView({ flow: { wip: {}, stations: {} }, present: new Set(['crew-workflow', 'crew-review']) }).advice.length, 0, 'no data, no advice');
  assert.equal(findCommand(['factory']).name, 'factory');
  assert.ok(agentCommands.some((c) => c.name === 'factory'), 'read-only');
});
