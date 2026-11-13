import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import command, { scanStaged } from '../src/commands/commit.js';
import { git } from '../src/core/exec.js';

const token = 'ghp_' + 'A'.repeat(40); // synthetic; never a usable credential
for (const suffix of ['example', 'sample', 'template']) {
  test(`.env.${suffix} allows placeholders but rejects tokens (LF and CRLF)`, () => {
    const file = `api/.env.${suffix}`;
    for (const eol of ['\n', '\r\n']) {
      const diff = (line) => [`+++ b/${file}`, `+${line}`, ''].join(eol);
      assert.deepEqual(scanStaged([file], diff('GH_TOKEN=')), []);
      const hits = scanStaged([file], diff(`GH_TOKEN=${token}`));
      assert.deepEqual(hits, [{ file, reason: 'GitHub token' }]);
      assert.ok(!JSON.stringify(hits).includes(token));
    }
  });
}

test('Removing a token from a template is permitted', () => {
  assert.deepEqual(scanStaged(['.env.example'], `+++ b/.env.example\n-GH_TOKEN=${token}\n+GH_TOKEN=\n`), []);
});

test('crew commit refuses a token in .env.example without committing or exposing it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-env-secret-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...args) => git(args, { cwd: root }).stdout;
  g('init', '-q', '-b', 'crew/17-secret-scan');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'Test');
  writeFileSync(join(root, 'crew.config.json'), '{}');
  g('add', 'crew.config.json');
  g('commit', '-qm', 'chore: fixture');
  const before = g('rev-parse', 'HEAD');
  const file = join(root, '.env.example');
  writeFileSync(file, `GH_TOKEN=${token}\r\n`);
  const result = command.run({ m: 'chore: example', cwd: root }, { checkLease: () => ({ state: 'owned' }) });
  assert.equal(result.error?.code, 'secret_suspected');
  assert.equal(g('rev-parse', 'HEAD'), before);
  assert.equal(g('diff', '--cached', '--name-only'), '');
  assert.ok(readFileSync(file, 'utf8').includes(token), 'working copy is preserved');
  assert.ok(!JSON.stringify(result).includes(token), 'result contains only filename and reason');
});
