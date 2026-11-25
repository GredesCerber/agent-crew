// Issue #1: with core.autocrlf=true a fresh clone has CRLF in committed generated files; crew adapters build must not
// rewrite them with LF (the clone would look dirty right after crew up --join). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import adapters, { needsWrite } from '../src/commands/adapters.js';

test('adapters build does not rewrite a file that differs only in line endings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-crlf-'));
  writeFileSync(join(root, 'crew.config.json'), JSON.stringify({ hosts: ['claude'] }));
  const first = await adapters.run({ cwd: root });
  assert.equal(first.status, 'success', JSON.stringify(first));
  assert.ok(first.artifacts.written.includes('CLAUDE.md'));

  // what git checks out on Windows with core.autocrlf=true
  const claudeMd = join(root, 'CLAUDE.md');
  const crlf = readFileSync(claudeMd, 'utf8').replace(/\n/g, '\r\n');
  writeFileSync(claudeMd, crlf);
  assert.equal(needsWrite(root, { path: 'CLAUDE.md', content: crlf.replace(/\r\n/g, '\n') }), false);

  const again = await adapters.run({ cwd: root });
  assert.ok(!again.artifacts.written.includes('CLAUDE.md'), JSON.stringify(again.artifacts.written));
  assert.equal(readFileSync(claudeMd, 'utf8'), crlf, 'the checkout stays as git wrote it');
  assert.equal((await adapters.run({ cwd: root, check: true })).status, 'success', '--check agrees');

  // a real change is still written
  writeFileSync(claudeMd, 'something else\r\n');
  assert.ok((await adapters.run({ cwd: root })).artifacts.written.includes('CLAUDE.md'));
});
