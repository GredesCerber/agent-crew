// Pre-hackathon blockers (issues #12, #13 H5, #16 H10/H11, #19 M9). No network and no GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import codex from '../adapters/codex/adapter.js';
import claude, { windowsCommand as claudeWin, HEADLESS_TOOLS } from '../adapters/claude/adapter.js';
import check from '../src/commands/check.js';
import { git } from '../src/core/exec.js';

const ROOT = join(import.meta.dirname, '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const frontmatter = (md) => ({ meta: {}, body: md });

test('H10: the product CI installs web/ and api/ dependencies before crew check', () => {
  const yml = read('templates', 'product', '.github', 'workflows', 'crew.yml');
  const deps = yml.indexOf('Product dependencies');
  assert.ok(deps > 0, 'no dependency install step');
  assert.ok(deps < yml.indexOf('run: crew check --json'), 'dependencies are installed after crew check');
  assert.match(yml, /npm --prefix "\$d" ci/);
});

test('H11: tsc checks the web/ and api/ project, not the root (npm --prefix exec runs in the root)', () => {
  for (const stack of ['web-node', 'web-fastapi']) {
    const p = JSON.parse(read('templates', 'stacks', `${stack}.json`));
    for (const s of p.check.filter((x) => /tsc/.test(x.run))) {
      assert.ok(!/-p \./.test(s.run), `${stack}/${s.name}: -p . checks the root`);
      const dir = s.when_exists.split('/')[0];
      assert.match(s.run, new RegExp(`tsc -b ${dir} --noEmit`), `${stack}/${s.name}`);
    }
  }
});

test('#12: Codex - crew tools without confirmation (codex exec with approval never), other MCPs as before', () => {
  const config = { hosts: ['codex'], mcp: { other: { enabled: true, command: 'npx', args: ['x'] } } };
  const toml = codex.generate({ config, roles: [], skills: [], frontmatter, platform: 'linux' }).find((f) => f.path === '.codex/config.toml').content;
  const crew = toml.slice(toml.indexOf('[mcp_servers.crew]'), toml.indexOf('[mcp_servers.other]'));
  const other = toml.slice(toml.indexOf('[mcp_servers.other]'));
  assert.match(crew, /^default_tools_approval_mode = "approve"$/m);
  assert.ok(!other.includes('approval'), 'we do not disable confirmations for a foreign MCP server');
});

test('M9: Claude headless - edits without questions, only the needed tools', () => {
  const s = claude.headless({ prompt: 'P', platform: 'linux' });
  assert.equal(s.args[s.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(!s.args.includes('--dangerously-skip-permissions'));
  assert.ok(!s.args.includes('bypassPermissions'));
  assert.ok(HEADLESS_TOOLS.includes('Edit') && HEADLESS_TOOLS.includes('mcp__crew'));
  assert.ok(!HEADLESS_TOOLS.some((t) => /git (push|commit|reset)|gh pr merge|^Bash$|Bash\(\*\)/.test(t)));
});

test('M9/#19: Claude on Windows - without cmd /c: claude.exe or the npm package cli.js via node', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-claude-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const native = join(root, 'native & %PATH%');
  mkdirSync(native);
  writeFileSync(join(native, 'claude.exe'), 'fixture');
  assert.deepEqual(claudeWin(native), { cmd: join(native, 'claude.exe'), args: [] });

  const npmDir = join(root, 'npm');
  const pkg = join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(npmDir, 'claude.cmd'), '@echo CMD_SHIM_MUST_NOT_RUN');
  writeFileSync(join(pkg, 'cli.js'), '');
  assert.deepEqual(claudeWin(`${join(root, 'empty')};${npmDir}`), { cmd: process.execPath, args: [join(pkg, 'cli.js')] });

  const spec = claude.headless({ prompt: 'a & b', platform: 'win32', searchPath: npmDir });
  assert.equal(spec.cmd, process.execPath);
  assert.deepEqual(spec.args.slice(0, 3), [join(pkg, 'cli.js'), '-p', 'a & b']);
  assert.equal(claudeWin('').cmd, 'claude.exe');
});

test('H5: crew check extends the lease before the steps, not only after', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-lease-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...a) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'crew.config.json'), JSON.stringify({ check: [{ name: 'mark', run: 'node -e "require(\'fs\').writeFileSync(\'ran\',\'1\')"' }] }));
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  g('checkout', '-q', '-b', 'crew/7-task');
  const calls = [];
  const r = check.run({ cwd: root }, { checkLease: ({ id }) => { calls.push({ id, stepRan: existsSync(join(root, 'ran')) }); return { state: 'ok' }; } });
  assert.equal(r.status, 'success', JSON.stringify(r));
  assert.deepEqual(calls, [{ id: 7, stepRan: false }, { id: 7, stepRan: true }]);
});
