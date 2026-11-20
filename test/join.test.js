// Joining with one message: the product repo tells the agent how, Codex gets its name, the captain sees newcomers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import codex from '../adapters/codex/adapter.js';
import { frontmatter } from '../src/commands/adapters.js';
import { digestModel } from '../src/core/digest.js';

const TPL = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'product');

test('the product repo tells a newcomer what to say and the agent what to do', () => {
  const readme = readFileSync(join(TPL, 'README.md'), 'utf8');
  assert.match(readme, /Join the development of \{\{repo\}\}/, 'crew up fills {{repo}} in');
  assert.match(readme, /JOIN\.md/);
  const howTo = readFileSync(join(TPL, 'JOIN.md'), 'utf8');
  for (const step of [/gh auth login/, /gh variable get CREW_HARNESS/, /crew up --join/, /No restart is needed/, /never type passwords/i]) assert.match(howTo, step);
});

test('Codex terminal commands get CREW_AGENT=codex from the project config', () => {
  const files = codex.generate({ config: {}, roles: [], skills: [], frontmatter, platform: 'linux' });
  const toml = files.find((f) => f.path === '.codex/config.toml').content;
  assert.match(toml, /\[shell_environment_policy\]\nset = \{ CREW_AGENT = "codex" \}/);
});

test('the digest names people with access but no area in crew-team (bots and team members excluded)', () => {
  const team = { members: [{ login: 'Cap', areas: ['api'] }] };
  const m = digestModel({ team, collaborators: ['cap', 'newbie', 'dependabot[bot]'], now: Date.parse('2026-11-20T10:00:00Z') });
  assert.deepEqual(m.sections.find((s) => s.key === 'newcomers').lines.map((l) => l.split(':')[0]), ['@newbie']);
  assert.equal(m.counts.newcomers, 1);
  assert.equal(digestModel({ collaborators: ['x'] }).counts.newcomers, 0, 'no PRD team yet: nothing to compare with');
});
