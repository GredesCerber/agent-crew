// Core tests for crew without network or GitHub: response shape, argument parsing, task leases,
// rule compliance, adapters, MCP, init and check in a temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ok, fail, SCHEMA } from '../src/core/output.js';
import { commands, findCommand, parseArgs, validate, toolName, inputSchema } from '../src/core/registry.js';
import { currentOwner, marker, parseMarkers, tierAllows, slugify } from '../src/core/issues.js';
import { evaluate } from '../src/commands/compliance.js';
import { frontmatter } from '../src/commands/adapters.js';
import claude from '../adapters/claude/adapter.js';
import codex from '../adapters/codex/adapter.js';
import { handle } from '../src/mcp/server.js';

const CREW = join(import.meta.dirname, '..', 'bin', 'crew.js');
const crew = (args, cwd, env = {}) => {
  const r = spawnSync(process.execPath, [CREW, ...args, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: JSON.parse(r.stdout) };
};

test('a response always has one shape, an error has next_actions', () => {
  const s = ok('done', { artifacts: { a: 1 } });
  assert.equal(s.schema, SCHEMA);
  assert.equal(s.status, 'success');
  const e = fail('ci_red', 'red');
  assert.equal(e.status, 'error');
  assert.ok(e.next_actions.length > 0);
  assert.deepEqual(Object.keys(e.error), ['code', 'cause_hint', 'retry', 'stop_when']);
});

test('registry: the longest command match and argument parsing', () => {
  const c = findCommand(['task', 'claim', '42']);
  assert.equal(c.name, 'task claim');
  assert.deepEqual(parseArgs(c, ['42', '--no-worktree']), { id: 42, no_worktree: true });
  assert.equal(validate(c, {}), 'missing argument: id');
  assert.match(validate(findCommand(['task', 'status']), { id: 1, state: 'wrong' }), /one of/);
  assert.equal(toolName(c), 'crew_task_claim');
  assert.deepEqual(inputSchema(c).required, ['id']);
});

test('command names are unique', () => {
  const names = commands.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test('lease: the first claim after the last release wins', () => {
  const c = (body, t) => ({ body, createdAt: t });
  const comments = [
    c(marker('claim', { agent: 'claude', at: '1' }), '1'),
    c(marker('release', { agent: 'claude', at: '2' }), '2'),
    c(marker('claim', { agent: 'codex', at: '3' }), '3'),
    c(marker('claim', { agent: 'claude', at: '4' }), '4'),
  ];
  assert.equal(currentOwner(comments).agent, 'codex');
  assert.equal(parseMarkers(comments).length, 4);
});

test('model tiers and slug', () => {
  assert.ok(tierAllows('high', 'low'));
  assert.ok(!tierAllows('low', 'high'));
  assert.ok(tierAllows('mid', undefined)); // no label = mid
  assert.equal(slugify('Add Login Page!'), 'add-login-page');
  assert.equal(slugify('Страница входа'), 'stranitsa-vkhoda'); // Russian input on purpose: transliteration
});

test('compliance: commits before the start, outside PRs, AI ban', () => {
  const ev = { start: '2026-12-05T10:00:00Z', end: '2026-12-07T10:00:00Z', ai_allowed: false, team_members: ['alice'] };
  const list = [
    { sha: 'a'.repeat(40), date: '2026-12-05T12:00:00Z', agent: 'codex/x' },
    { sha: 'b'.repeat(40), date: '2026-12-01T12:00:00Z', agent: null },
  ];
  assert.equal(evaluate(ev, list, ['alice', 'mallory']).problems.length, 3);
  assert.equal(evaluate({ ...ev, ai_allowed: true }, [list[0]], ['Alice']).problems.length, 0);
});

test('adapters: Claude and Codex generate their own configs without secrets', () => {
  const config = {
    tiers: { mid: { claude: 'sonnet' } },
    mcp: { perplexity: { enabled: true, command: 'npx', args: ['-y', 'pkg'], env_from: ['PERPLEXITY_API_KEY'] } },
  };
  const roles = [{ name: 'builder', content: '---\ndescription: d\ntier: mid\n---\nbody\n' }];
  const skills = [{ name: 'crew-workflow', content: '---\nname: crew-workflow\n---\nx' }];
  const ctx = { config, roles, skills, frontmatter, platform: 'linux' };

  const cf = Object.fromEntries(claude.generate(ctx).map((f) => [f.path, f]));
  assert.equal(cf['CLAUDE.md'].content.split('\n')[0], '@AGENTS.md');
  assert.equal(JSON.parse(cf['.mcp.json'].content).mcpServers.perplexity.env.PERPLEXITY_API_KEY, '${PERPLEXITY_API_KEY}');
  assert.match(cf['.claude/agents/builder.md'].content, /model: sonnet/);
  assert.ok(JSON.parse(cf['.claude/settings.json'].content).enabledPlugins['ecc@ecc']);

  const xf = Object.fromEntries(codex.generate(ctx).map((f) => [f.path, f]));
  const toml = xf['.codex/config.toml'].content;
  assert.match(toml, /\[mcp_servers\.crew\]/);
  assert.match(toml, /env_vars = \["PERPLEXITY_API_KEY"\]/);
  assert.ok(xf['.agents/skills/role-builder/SKILL.md']);

  const win = claude.generate({ ...ctx, platform: 'win32' }).find((f) => f.path === '.mcp.json');
  assert.equal(JSON.parse(win.content).mcpServers.crew.command, 'cmd');
});

test('MCP: initialize, tools/list and an input error', async () => {
  const init = await handle({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  const names = (await handle({ id: 2, method: 'tools/list' })).tools.map((t) => t.name);
  assert.ok(names.includes('crew_task_next') && names.includes('crew_check'));
  assert.ok(!names.includes('crew_init'), 'init is for humans only');
  const bad = await handle({ id: 3, method: 'tools/call', params: { name: 'crew_task_claim', arguments: {} } });
  assert.equal(bad.isError, true);
  assert.equal(await handle({ method: 'notifications/initialized' }), undefined);
});

test('init -> adapters --check -> check -> commit (no GitHub)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-'));
  const proj = join(dir, 'demo');
  const init = crew(['init', proj], dir);
  assert.equal(init.out.status, 'success', JSON.stringify(init.out));
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'crew.config.json', '.mcp.json', '.codex/config.toml', '.claude/skills/crew-workflow/SKILL.md', '.agents/skills/crew-kickoff/SKILL.md', '.github/workflows/crew.yml']) {
    assert.ok(existsSync(join(proj, f)), `missing ${f}`);
  }
  assert.match(readFileSync(join(proj, '.gitignore'), 'utf8'), /\.mcp\.json/);
  assert.equal(crew(['adapters', 'build', '--check'], proj).out.status, 'success');

  // stack steps are skipped while web/ and api/ do not exist
  const skipped = crew(['check'], proj);
  // nothing ran: not a failure, but not "green" either (a new user must not read it as "the code passes")
  assert.equal(skipped.out.status, 'warning');
  assert.match(skipped.out.summary, /Nothing was verified.*skipped/);
  assert.equal(skipped.out.artifacts.verified, false);
  assert.equal(skipped.out.artifacts.green, true, 'crew pr open is still allowed on a fresh project');

  // a red step -> ci_red with a recovery contract
  const cfgPath = join(proj, 'crew.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.check = [{ name: 'fail', run: 'node -e "process.exit(3)"' }];
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const red = crew(['check'], proj);
  assert.equal(red.code, 1);
  assert.equal(red.out.error.code, 'ci_red');
  assert.ok(red.out.error.stop_when);

  // commit adds the Agent trailer
  spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: proj });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: proj });
  // crew commit does not commit on main (M3) - only on a task branch
  const onMain = crew(['commit', '-m', 'chore: init'], proj, { CREW_AGENT: 'codex/test' });
  assert.equal(onMain.out.error.code, 'not_task_branch');
  spawnSync('git', ['checkout', '-q', '-b', 'crew/1-init'], { cwd: proj });
  const c = crew(['commit', '-m', 'chore: init'], proj, { CREW_AGENT: 'codex/test' });
  // without GitHub the lease cannot be checked -> warning with a hint, but the commit is made
  assert.ok(['success', 'warning'].includes(c.out.status), JSON.stringify(c.out));
  assert.equal(c.out.artifacts.lease, 'unknown');
  const trailer = spawnSync('git', ['log', '-1', '--format=%(trailers:key=Agent,valueonly)'], { cwd: proj, encoding: 'utf8' }).stdout.trim();
  assert.match(trailer, /^codex\/test@[a-z0-9-]+$/, 'the machine name is appended to CREW_AGENT');
});

test('unknown command -> an error with a hint', () => {
  const r = crew(['fly'], tmpdir());
  assert.equal(r.code, 2);
  assert.equal(r.out.error.code, 'unknown_command');
});
