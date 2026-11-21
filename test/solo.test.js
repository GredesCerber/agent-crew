// Solo mode: one person with one agent, without the team machinery. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { evaluateGuard } from '../src/core/guard.js';
import { prQueue } from '../src/core/queue.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'crew.js');
const crew = (args, cwd) => JSON.parse(spawnSync(process.execPath, [BIN, ...args, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, CREW_AGENT_ID: 'test@ci' } }).stdout);
const SHA = 'abcdef1234567';

test('crew init --solo: build phase right away, one host, no second-agent review; a team project starts in discovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-solo-'));
  const r = crew(['init', join(dir, 'me'), '--solo'], dir);
  assert.equal(r.status, 'success');
  assert.match(r.summary, /solo/);
  const cfg = JSON.parse(readFileSync(join(dir, 'me', 'crew.config.json'), 'utf8'));
  assert.equal(cfg.solo, true);
  assert.equal(cfg.phase, 'build');
  assert.deepEqual(cfg.hosts, ['claude']);
  assert.equal(cfg.review.approvals, 0);
  assert.ok(r.next_actions.some((a) => /crew task status <n> ready/.test(a)));
  const team = crew(['init', join(dir, 'team')], dir);
  assert.equal(JSON.parse(readFileSync(join(dir, 'team', 'crew.config.json'), 'utf8')).phase, 'discovery');
  assert.equal(team.artifacts.solo, false);
});

test('solo: crew-guard passes a green PR without a review; protected files still fail; risk:high waits for the person', () => {
  const config = { hosts: ['claude'], solo: true, review: { approvals: 0, approvals_high: 0 } };
  const base = { body: 'Closes #1\n**Agent:** `claude@pc`', headSha: SHA, commits: [{ sha: SHA, agent: 'claude@pc' }], config };
  assert.equal(evaluateGuard({ ...base, files: [{ filename: 'web/a.ts', status: 'modified' }] }).state, 'success');
  assert.equal(evaluateGuard({ ...base, files: [{ filename: '.github/workflows/crew.yml', status: 'modified' }] }).state, 'failure');
  const green = [{ name: 'check', conclusion: 'SUCCESS' }, { context: 'crew-guard', state: 'SUCCESS' }];
  const pr = (risk) => ({ number: 1, title: 'x', body: base.body, headRefOid: SHA, createdAt: '2026-11-20T10:00:00Z', isDraft: false, author: { login: 'me' }, labels: [{ name: `risk:${risk}` }], comments: [], statusCheckRollup: green });
  const high = prQueue([pr('high')], { me: 'claude@pc', config })[0];
  assert.equal(high.kind, 'merge');
  assert.equal(high.human, true, 'risk:high in solo: the person merges it, not the agent or merge-ready');
  assert.equal(prQueue([pr('high')], { me: 'claude@pc', config: { review: { approvals: 0, approvals_high: 0 } } })[0].human, undefined, 'team repos keep the old behavior');
  assert.deepEqual(prQueue([pr('med')], { me: 'claude@pc', config }), [], 'med: auto-merge takes it');
});
