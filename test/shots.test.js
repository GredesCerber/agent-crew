// Before/after screenshots for UI tasks (src/core/shots.js). No network, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isUiFile, uiFiles, safeUrl, NAME_RE, shotPath, captureCommand, listShots, shotsSection } from '../src/core/shots.js';

test('UI files: web/, design/, styles and components count; tests and backend do not', () => {
  assert.ok(isUiFile('web/src/App.tsx'));
  assert.ok(isUiFile('design/tokens.md'));
  assert.ok(isUiFile('src/components/Card.vue'));
  assert.ok(isUiFile('web\\src\\styles\\main.css'), 'Windows separators');
  assert.ok(!isUiFile('api/src/server.ts'));
  assert.ok(!isUiFile('web/src/App.test.tsx'));
  assert.ok(!isUiFile('tests/e2e/demo.spec.ts'));
  assert.deepEqual(uiFiles(['api/x.ts', 'web/a.css']), ['web/a.css']);
});

test('safeUrl: only http(s), nothing a shell could interpret', () => {
  assert.equal(safeUrl('http://localhost:5173/items?id=1'), 'http://localhost:5173/items?id=1');
  assert.equal(safeUrl('file:///etc/passwd'), null);
  assert.equal(safeUrl('http://x/"; rm -rf /'), null);
  assert.equal(safeUrl('http://x/$(whoami)'), null);
  assert.equal(safeUrl('not a url'), null);
});

test('names and paths', () => {
  assert.ok(NAME_RE.test('main'));
  assert.ok(NAME_RE.test('item-card-2'));
  assert.ok(!NAME_RE.test('../etc'));
  assert.ok(!NAME_RE.test('Main Screen'));
  assert.equal(shotPath(12, 'main', 'before'), '.crew/shots/12/main-before.png');
  assert.match(captureCommand({ url: 'http://localhost:5173/', file: '.crew/shots/12/main-after.png' }),
    /^npx --yes playwright screenshot --full-page --viewport-size=1280,800 "http:\/\/localhost:5173\/" "\.crew\/shots\/12\/main-after\.png"$/);
});

test('listShots + shotsSection: before/after pairs pinned to the head commit; missing side is visible', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-shots-'));
  const dir = join(root, '.crew', 'shots', '12');
  mkdirSync(dir, { recursive: true });
  for (const f of ['main-before.png', 'main-after.png', 'cart-after.png', 'notes.txt']) writeFileSync(join(dir, f), 'x');
  const shots = listShots(root, 12);
  assert.deepEqual(shots, {
    main: { before: '.crew/shots/12/main-before.png', after: '.crew/shots/12/main-after.png' },
    cart: { before: null, after: '.crew/shots/12/cart-after.png' },
  });
  const md = shotsSection({ repo: 'acme/app', sha: 'abc123', shots });
  assert.match(md, /^## Before \/ After/);
  assert.match(md, /\| main \| !\[\]\(https:\/\/github\.com\/acme\/app\/blob\/abc123\/\.crew\/shots\/12\/main-before\.png\?raw=true\)/);
  assert.match(md, /\| cart \| _missing_ \|/);
  assert.equal(shotsSection({ repo: 'a/b', sha: 'x', shots: {} }), '');
  assert.deepEqual(listShots(root, 99), {});
});

test('crew shots: only in a task branch; bad URL/name refused before running anything; saves .crew/shots/<id>/<name>-<phase>.png', async () => {
  const { default: shots } = await import('../src/commands/shots.js');
  const { git } = await import('../src/core/exec.js');
  const root = mkdtempSync(join(tmpdir(), 'crew-shots-cmd-'));
  const g = (...a) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'crew.config.json'), '{}');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const calls = [];
  const deps = { runShell: (line) => (calls.push(line), { code: 0, stdout: '', stderr: '' }), exists: () => true };
  assert.equal(shots.run({ phase: 'before', url: 'http://localhost:5173/', cwd: root }, deps).error.code, 'not_task_branch');
  g('checkout', '-q', '-b', 'crew/12-cart');
  assert.equal(shots.run({ phase: 'before', url: 'http://x/$(id)', cwd: root }, deps).error.code, 'bad_input');
  assert.equal(shots.run({ phase: 'before', url: 'http://localhost:5173/', name: '../x', cwd: root }, deps).error.code, 'bad_input');
  assert.equal(calls.length, 0, 'nothing ran for bad input');
  const r = shots.run({ phase: 'after', url: 'http://localhost:5173/cart', name: 'cart', width: 390, cwd: root }, deps);
  assert.equal(r.status, 'success', JSON.stringify(r));
  assert.equal(r.artifacts.path, '.crew/shots/12/cart-after.png');
  assert.match(calls[0], /--viewport-size=390,800 "http:\/\/localhost:5173\/cart"/);
  const failed = shots.run({ phase: 'after', url: 'http://localhost:5173/', cwd: root }, { runShell: () => ({ code: 1, stdout: '', stderr: 'net::ERR_CONNECTION_REFUSED' }), exists: () => false });
  assert.equal(failed.error.code, 'shot_failed');
  assert.match(failed.error.cause_hint, /CONNECTION_REFUSED/);
});

test('crew commit takes .crew/shots although .crew/ is gitignored (otherwise the PR table links 404)', async () => {
  const { default: commit } = await import('../src/commands/commit.js');
  const { git } = await import('../src/core/exec.js');
  const root = mkdtempSync(join(tmpdir(), 'crew-shots-commit-'));
  const g = (...a) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 't');
  g('config', 'user.email', 't@t');
  writeFileSync(join(root, 'crew.config.json'), '{}');
  writeFileSync(join(root, '.gitignore'), '.crew/\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  g('checkout', '-q', '-b', 'crew/12-cart');
  mkdirSync(join(root, '.crew', 'shots', '12'), { recursive: true });
  writeFileSync(join(root, '.crew', 'shots', '12', 'main-after.png'), 'png');
  writeFileSync(join(root, '.crew', 'last-check.json'), '{}');
  writeFileSync(join(root, 'page.html'), '<p>new</p>');
  const r = commit.run({ m: 'feat: page', cwd: root }, { checkLease: () => ({ state: 'ok' }) });
  assert.equal(r.status, 'success', JSON.stringify(r));
  const files = g('show', '--name-only', '--format=', 'HEAD').stdout.split('\n');
  assert.ok(files.includes('.crew/shots/12/main-after.png'), files.join(','));
  assert.ok(!files.includes('.crew/last-check.json'), 'other local state stays out');
});
