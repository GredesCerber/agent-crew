// Fixes from the 0.9.0 review: discovery reads main, solo risk:high, init keeps README, renames, crew/v1 fields. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { phaseProblems, exitCriteria } from '../src/core/discovery.js';
import { mainPhase } from '../src/commands/kickoff.js';
import discoverCmds from '../src/commands/discover.js';
import init from '../src/commands/init.js';

const PRD = '# PRD\n```crew-task\nid: T1\n```\n';
const READY = { discoveryText: '## Exit criteria\n- [x] done\n', decisionsText: '## 2026-11-20 — chosen\n', prdOnMain: PRD };

test('F2: the local PRD must be the reviewed one on main', () => {
  assert.equal(exitCriteria({ ...READY, prdLocal: PRD }).ready, true);
  assert.equal(exitCriteria({ ...READY, prdLocal: PRD.replace(/\n/g, '\r\n') }).ready, true, 'line endings do not matter');
  const rewritten = exitCriteria({ ...READY, prdLocal: PRD + '```crew-task\nid: T2\n```\n' });
  assert.equal(rewritten.ready, false);
  assert.match(rewritten.missing.join('\n'), /differs from the PRD on main/);
});

test('F1: the phase comes from main, not from a local file left by a failed publish', () => {
  const base = mkdtempSync(join(tmpdir(), 'crew-phase-'));
  const origin = join(base, 'origin.git');
  const work = join(base, 'work');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'crew.config.json'), JSON.stringify({ phase: 'discovery' }));
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  writeFileSync(join(work, 'crew.config.json'), JSON.stringify({ phase: 'build' }));
  assert.equal(mainPhase(work, { phase: 'build' }), 'discovery');
  const lone = mkdtempSync(join(tmpdir(), 'crew-phase-lone-'));
  assert.equal(mainPhase(lone, { phase: 'build' }), 'build', 'no remote: the local config is all there is');
});

test('F5: renames count on both ends', () => {
  const discovery = { phase: 'discovery' };
  assert.equal(phaseProblems([{ filename: 'docs/app.js', previous_filename: 'src/app.js', status: 'renamed' }], discovery)[0]?.rule, 'discovery_phase');
  assert.deepEqual(phaseProblems([{ filename: 'docs/a.md', previous_filename: 'docs/b.md', status: 'renamed' }], discovery), []);
  const build = { phase: 'build' };
  assert.equal(phaseProblems([{ filename: 'src/client.js', previous_filename: 'spikes/x/client.js', status: 'renamed' }], build)[0]?.rule, 'spike_in_build');
  assert.deepEqual(phaseProblems([{ filename: 'spikes/x/client.js', status: 'removed' }], build), []);
});

test('F4: crew init --force keeps an existing README and adds the newcomer line once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-readme-'));
  writeFileSync(join(dir, 'README.md'), '# My app\n\nOur own words.\n');
  await init.run({ dir, force: true });
  const once = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.match(once, /Our own words\./);
  assert.match(once, /New on the team\?/);
  assert.ok(once.startsWith('# My app\n'));
  await init.run({ dir, force: true });
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), once, 'not added twice');
});

test('F7: discover errors carry cause_hint, retry and stop_when', () => {
  const plan = discoverCmds.find((c) => c.name === 'discover plan');
  const filled = (r) => ['cause_hint', 'retry', 'stop_when'].every((k) => typeof r.error?.[k] === 'string' && r.error[k].length > 0);
  const deps = { config: { captain: 'boss', areas: ['web'] }, root: mkdtempSync(join(tmpdir(), 'crew-disc-')) };
  assert.ok(filled(plan.run({}, { ...deps, text: '' })), 'no_discovery_doc');
  assert.ok(filled(plan.run({}, { ...deps, text: '```crew-research\nid: R1\n```\n' })), 'bad_discovery_doc');
  const good = '```crew-research\nid: R1\nquestion: q?\narea: web\nowner: me\nbudget_hours: 2\n```\n';
  assert.ok(filled(plan.run({ apply: true }, { ...deps, text: good, existing: [], login: 'someone', acting: null })), 'not_captain');
});
