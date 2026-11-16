// What a first-time user hit in a smoke run: a typo, no GitHub remote yet, outside a project, a fresh project's
// check and adapters build. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { suggestCommand } from '../src/core/registry.js';
import { requireProject } from '../src/core/config.js';
import { run } from '../src/core/exec.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'crew.js');
const crew = (args, cwd) => JSON.parse(spawnSync(process.execPath, [BIN, ...args, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, CREW_AGENT_ID: 'test@ci' } }).stdout);

test('a typo gets "did you mean": letters missing, extra, swapped; the longer name wins a tie; nonsense gets nothing', () => {
  assert.equal(suggestCommand(['taks', 'next']), 'task next');
  assert.equal(suggestCommand(['tasks', 'lint']), 'task lint');
  assert.equal(suggestCommand(['pr', 'opne']), 'pr open');
  assert.equal(suggestCommand(['captian']), 'captain');
  assert.equal(suggestCommand(['ide', 'list']), 'idea list');
  assert.equal(suggestCommand(['foo', 'bar']), null);
  const r = crew(['taks', 'next']);
  assert.equal(r.error.code, 'unknown_command');
  assert.match(r.summary, /Did you mean "crew task next"\?/);
  assert.equal(r.artifacts.suggestion, 'task next');
});

test('outside a project: not_a_project instead of answers that pretend a project exists', () => {
  assert.equal(requireProject({ path: '/p/crew.config.json', root: '/p' }), null);
  assert.equal(requireProject({ path: null, root: '/tmp/x' }).error.code, 'not_a_project');
  const dir = mkdtempSync(join(tmpdir(), 'crew-noproj-'));
  for (const args of [['task', 'lint'], ['captain']]) assert.equal(crew(args, dir).error.code, 'not_a_project', args.join(' '));
});

test('gh without a GitHub remote: no_remote with how to connect, not a raw gh error', () => {
  const fakeGh = ['-e', "console.error('no git remotes found'); process.exit(1)"];
  assert.throws(() => run(process.execPath, fakeGh), (e) => e.code === 'no_remote' && /crew up/.test(e.retry ?? e.opts?.retry ?? JSON.stringify(e)));
});

test('a fresh project: check says nothing was verified (still allows pr open); adapters build says configs are up to date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-fresh-'));
  const proj = join(dir, 'proj');
  assert.equal(crew(['init', proj], dir).status, 'success');
  const a = crew(['adapters', 'build'], proj);
  assert.match(a.summary, /already up to date/);
  assert.match(a.summary, /local to this machine/);
  const c = crew(['check'], proj);
  assert.equal(c.status, 'warning');
  assert.match(c.summary, /^Nothing was verified/);
  assert.equal(c.artifacts.green, true);
  assert.equal(c.artifacts.verified, false);
});
