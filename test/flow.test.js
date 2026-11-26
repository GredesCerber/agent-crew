// crew flow: time at each station from GitHub data (issues with claim markers, PRs), the bottleneck, WIP, PRs that
// went around crew. gh is stubbed; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { flow } from '../src/core/flow.js';
import flowCmd from '../src/commands/flow.js';
import { findCommand, agentCommands } from '../src/core/registry.js';

const H = 3_600_000;
const NOW = Date.parse('2026-11-27T12:00:00Z');
const at = (h) => new Date(NOW - h * H).toISOString();
const claim = (h) => ({ body: '<!-- crew:claim agent=claude@a -->', createdAt: at(h) });

const issues = [
  { number: 1, createdAt: at(30), closedAt: at(2), state: 'CLOSED', labels: [], comments: [claim(20)] },
  { number: 2, createdAt: at(50), closedAt: at(5), state: 'CLOSED', labels: [], comments: [claim(46)] },
  { number: 3, createdAt: at(10), closedAt: null, state: 'OPEN', labels: [{ name: 'status:ready' }], comments: [] },
  { number: 4, createdAt: at(10), closedAt: null, state: 'OPEN', labels: [{ name: 'status:claimed' }], comments: [claim(1)] },
];
const prs = [
  { number: 11, body: 'Closes #1', createdAt: at(18), mergedAt: at(2), state: 'MERGED' },
  { number: 12, body: 'Fixes #2', createdAt: at(40), mergedAt: at(5), state: 'MERGED' },
  { number: 13, body: 'tweak', createdAt: at(3), mergedAt: at(1), state: 'MERGED' },
  { number: 14, body: 'Closes #9', createdAt: at(800), mergedAt: at(700), state: 'MERGED' },
  { number: 15, body: 'Closes #4', createdAt: at(1), mergedAt: null, isDraft: true, state: 'OPEN' },
];

test('stations: queue, build, review medians; the bottleneck; WIP; PRs that closed no task', () => {
  const f = flow({ issues, prs, now: NOW, days: 14 });
  assert.equal(f.merged, 3, 'a PR merged before the window does not count');
  assert.deepEqual(f.bypassed, [13]);
  assert.deepEqual(f.items.map((i) => [i.issue, i.queue / H, i.build / H, i.review / H, i.lead / H]), [[1, 10, 2, 16, 28], [2, 4, 6, 35, 45]]);
  assert.deepEqual(Object.fromEntries(Object.entries(f.stations).map(([k, v]) => [k, v.median_ms / H])), { queue: 7, build: 4, review: 25.5 });
  assert.equal(f.bottleneck, 'review');
  assert.equal(f.lead_ms / H, 36.5);
  assert.equal(f.throughput_per_week, 1.5);
  assert.deepEqual(f.wip, { 'status:ready': 1, 'status:claimed': 1, 'pr:open': 0, 'pr:draft': 1 });
  assert.equal(flow({ now: NOW }).bottleneck, null, 'no data, no bottleneck');
});

test('crew flow: the summary, what to do about the bottleneck, and the work that went around crew', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-flow-'));
  writeFileSync(join(root, 'crew.config.json'), '{}');
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const j = (args) => (args[0] === 'pr' ? (args[3] === 'merged' ? prs.filter((p) => p.mergedAt) : prs.filter((p) => !p.mergedAt)) : args[3] === 'closed' ? issues.filter((i) => i.closedAt) : issues.filter((i) => !i.closedAt));
    const r = flowCmd.run({ days: 14 }, { j, now: NOW });
    assert.match(r.summary, /^3 merged in 14 days \(1\.5\/week\); lead time 36h 30m \(median\): queue 7h 0m → build 4h 0m → review 25h 30m; bottleneck: review$/);
    assert.match(r.next_actions[0], /PRs wait for review/);
    assert.match(r.next_actions[1], /1 merged PR\(s\) closed no task \(#13\)/);
    assert.equal(flowCmd.run({ days: 0 }, { j }).error.code, 'bad_input');
  } finally { process.chdir(cwd); }
  assert.equal(findCommand(['flow']).name, 'flow');
  assert.ok(agentCommands.some((c) => c.name === 'flow'), 'read-only: agents may look too');
});
