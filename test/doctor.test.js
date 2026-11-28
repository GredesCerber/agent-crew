import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { agentRules } from '../src/commands/doctor.js';

const ROOT = '/repo';
const TEMPLATE = '/pkg/AGENTS.md';
const fsOf = (files) => ({
  exists: (p) => p in files,
  read: (p) => files[p],
  template: TEMPLATE,
});

test('agentRules: AGENTS.md as in the template and imported by CLAUDE.md -> no problems', () => {
  const files = {
    [TEMPLATE]: '# rules\nline\n',
    [join(ROOT, 'AGENTS.md')]: '# rules\r\nline\r\n', // a Windows checkout: line endings do not count
    [join(ROOT, 'CLAUDE.md')]: '@AGENTS.md\n\n<!-- generated -->\n',
  };
  assert.deepEqual(agentRules(ROOT, ['claude', 'codex'], fsOf(files)), []);
});

test('agentRules: a missing AGENTS.md and a CLAUDE.md that imports nothing are reported', () => {
  const files = { [TEMPLATE]: '# rules\n', [join(ROOT, 'CLAUDE.md')]: '# my own notes\n' };
  const problems = agentRules(ROOT, ['claude'], fsOf(files));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /AGENTS\.md is missing.*crew upgrade --apply/);
  assert.match(problems[1], /CLAUDE\.md does not import @AGENTS\.md/);
});

test('agentRules: an AGENTS.md that drifted from the package rules is reported; no CLAUDE.md check without claude', () => {
  const files = { [TEMPLATE]: '# rules v2\n', [join(ROOT, 'AGENTS.md')]: '# rules v1\n' };
  const problems = agentRules(ROOT, ['codex'], fsOf(files));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /differs from the crew .* rules \(crew upgrade/);
});

test('agentRules: the real template matches itself (the package ships one)', () => {
  assert.deepEqual(agentRules(join(import.meta.dirname, '..', 'templates', 'product'), []), []);
});

test('pathRisk: a long or non-ASCII task folder on Windows is reported with the fix; a short ASCII one or another OS is not', async () => {
  const { pathRisk } = await import('../src/commands/doctor.js');
  const env = {};
  const deep = 'C:\\Users\\Пользователь\\OneDrive\\Документы\\Проекты\\matstat-lab';
  const [p] = pathRisk(deep, { platform: 'win32', env, longPaths: () => false });
  assert.match(p, /non-ASCII.*long paths are off.*CREW_WORKTREES/);
  assert.deepEqual(pathRisk(deep, { platform: 'linux', env, longPaths: () => false }), []);
  assert.deepEqual(pathRisk(String.raw`C:\src\app`, { platform: 'win32', env, longPaths: () => false }), []);
  // the task folders moved to a short path: nothing to warn about
  assert.deepEqual(pathRisk(deep, { platform: 'win32', env: { CREW_WORKTREES: String.raw`C:\crew` }, longPaths: () => false }), []);
  // long but ASCII, with long paths on: fine
  assert.deepEqual(pathRisk('C:\\' + 'a'.repeat(120) + '\\app', { platform: 'win32', env, longPaths: () => true }), []);
});
