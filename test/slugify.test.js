import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { slugify } from '../src/core/issues.js';
import { prepareWorkspace } from '../src/commands/task.js';
import { git } from '../src/core/exec.js';

test('L3: Russian titles turn into readable Latin slugs', () => {
  for (const [title, slug] of [
    ['Страница входа', 'stranitsa-vkhoda'],
    ['Ёж и чай', 'yozh-i-chay'],
    ['Щука, съёмка, подъём', 'shchuka-syomka-podyom'],
    ['Юла, якорь, эхо, мышь', 'yula-yakor-ekho-mysh'],
  ]) assert.equal(slugify(title), slug, title);
});

test('L3: Latin, numbers and mixed text are kept, separators are normalized', () => {
  assert.equal(slugify('Add Login Page!'), 'add-login-page');
  assert.equal(slugify('API: вход v2 / OAuth'), 'api-vkhod-v2-oauth');
  assert.equal(slugify('  Исправить___баг #42!  '), 'ispravit-bag-42');
});

test('L3: Unicode in NFC/NFD gives one slug; empty titles keep the fallback', () => {
  assert.equal(slugify('Ёж и чай'.normalize('NFD')), 'yozh-i-chay');
  for (const title of ['', '!!!', '💡', 'ъь', '中文']) assert.equal(slugify(title), 'task');
});

test('L3: the 40 character limit is applied after transliteration, with no edge hyphens', () => {
  for (const title of ['Щ'.repeat(50), 'а'.repeat(39) + ' б', 'Тест '.repeat(50)]) {
    const slug = slugify(title);
    assert.ok(slug.length <= 40);
    assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
});

test('L3: prepareWorkspace creates a valid branch from a Russian title (local git, no origin)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-slug-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  git(['init', '-q', '-b', 'main'], { cwd: root });
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'chore: fixture'], { cwd: root });
  assert.equal(git(['remote'], { cwd: root }).stdout, '');
  const ws = prepareWorkspace({ root, id: 42, title: 'Страница входа', no_worktree: true });
  assert.equal(ws.branch, 'crew/42-stranitsa-vkhoda');
  git(['check-ref-format', '--branch', ws.branch], { cwd: root });
  assert.equal(git(['branch', '--show-current'], { cwd: root }).stdout, ws.branch);
});
