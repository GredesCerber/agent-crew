// Antigravity host: a workspace plugin with the crew MCP server, skills where Codex puts them, local files ignored,
// the MCP server finding its project (CREW_PROJECT_DIR, MCP roots). No network; the app itself is not needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import antigravity from '../adapters/antigravity/adapter.js';
import codex from '../adapters/codex/adapter.js';
import { frontmatter, ignoreEntries, ensureIgnored, buildFiles } from '../src/commands/adapters.js';
import { localAgentFiles } from '../src/commands/task.js';
import { hostWiring } from '../src/commands/doctor.js';
import { hostList } from '../src/commands/up.js';
import { projectFromRoots, projectRoots } from '../src/mcp/server.js';

const skills = [{ name: 'crew-workflow', content: '---\nname: crew-workflow\ndescription: the loop\n---\nDo it.' }];
const roles = [{ name: 'reviewer', content: '---\ndescription: reviews PRs\n---\nReview.' }];
const gen = (platform, root = 'C:\\proj', config = {}) => antigravity.generate({ root, config, roles, skills, frontmatter, platform });

test('antigravity: a workspace plugin with the crew MCP server that knows its project', () => {
  const files = gen('win32');
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.ok(files.every((f) => f.commit === false), 'the plugin holds this machine\'s path: never committed');
  assert.deepEqual(JSON.parse(byPath['.agents/plugins/crew/plugin.json'].content).name, 'crew');
  const mcp = JSON.parse(byPath['.agents/plugins/crew/mcp_config.json'].content).mcpServers.crew;
  assert.deepEqual(mcp, { command: 'cmd', args: ['/c', 'crew', 'mcp'], env: { CREW_AGENT: 'gemini', CREW_PROJECT_DIR: 'C:\\proj' } });
  assert.deepEqual(JSON.parse(gen('linux', '/p').find((f) => f.path.endsWith('mcp_config.json')).content).mcpServers.crew.command, 'crew');
  assert.match(byPath['.agents/plugins/crew/rules/AGENTS.md'].content, /\$env:CREW_AGENT='gemini'/);
  // optional MCP servers from crew.config.json come along
  const more = JSON.parse(gen('linux', '/p', { mcp: { docs: { enabled: true, command: 'npx', args: ['docs-mcp'] }, off: { enabled: false, command: 'x' } } }).find((f) => f.path.endsWith('mcp_config.json')).content).mcpServers;
  assert.deepEqual(Object.keys(more), ['crew', 'docs']);
});

test('antigravity and codex write the same skills to .agents/skills: both hosts can be on', () => {
  const a = gen('linux').filter((f) => f.path.startsWith('.agents/skills/'));
  const c = codex.generate({ config: {}, roles, skills, frontmatter, platform: 'linux' }).filter((f) => f.path.startsWith('.agents/skills/'));
  assert.deepEqual(a.map((f) => [f.path, f.content]), c.map((f) => [f.path, f.content]));
  assert.deepEqual(a.map((f) => f.path), ['.agents/skills/crew-workflow/SKILL.md', '.agents/skills/role-reviewer/SKILL.md']);
});

test('local files of a host added later go to .git/info/exclude, and crew task claim copies them to worktrees', () => {
  assert.deepEqual(ignoreEntries(gen('linux', '/p')), ['.agents/plugins/crew/', '.agents/skills/']);
  const root = mkdtempSync(join(tmpdir(), 'crew-ag-'));
  mkdirSync(join(root, '.git', 'info'), { recursive: true });
  const committed = '# crew: local files\r\n.crew/\r\n.mcp.json\r\n\r\nnode_modules/\r\n';
  writeFileSync(join(root, '.gitignore'), committed);
  assert.deepEqual(ensureIgnored(root, gen('linux', root)), ['.agents/plugins/crew/', '.agents/skills/']);
  assert.deepEqual(ensureIgnored(root, gen('linux', root)), [], 'added once');
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), committed, 'the tracked .gitignore is untouched: the clone stays clean');
  assert.equal(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), '# crew: local files\n.agents/plugins/crew/\n.agents/skills/\n');
  // what crew task claim copies into a task worktree: both lists, from one section each
  assert.deepEqual(localAgentFiles(root), ['.mcp.json', '.agents/plugins/crew', '.agents/skills']);
  // an existing exclude keeps its own lines and line endings; new entries join the crew section
  writeFileSync(join(root, '.git', 'info', 'exclude'), '# mine\r\n*.log\r\n\r\n# crew: local files\r\n.agents/skills/\r\n');
  ensureIgnored(root, gen('linux', root));
  assert.equal(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), '# mine\r\n*.log\r\n\r\n# crew: local files\r\n.agents/skills/\r\n.agents/plugins/crew/\r\n');
  // a folder git does not know yet: a .gitignore is created, so nothing with this machine's path gets committed later
  const bare = mkdtempSync(join(tmpdir(), 'crew-bare-'));
  ensureIgnored(bare, gen('linux', bare));
  assert.equal(readFileSync(join(bare, '.gitignore'), 'utf8'), '# crew: local files\n.agents/plugins/crew/\n.agents/skills/\n');
});

test('a host pair that shares a file writes it once; disagreeing adapters are a bug', async () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-dup-'));
  mkdirSync(join(root, 'agents', 'skills', 'crew-workflow'), { recursive: true });
  writeFileSync(join(root, 'agents', 'skills', 'crew-workflow', 'SKILL.md'), skills[0].content);
  const { files } = await buildFiles(root, { hosts: ['codex', 'antigravity'] });
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes('.agents/skills/crew-workflow/SKILL.md'));
  assert.equal(paths.length, new Set(paths).size, 'each path once');
});

test('the real MCP server survives a roots answer that points at a broken crew.config.json', async () => {
  const bad = mkdtempSync(join(tmpdir(), 'crew-bad-'));
  writeFileSync(join(bad, 'crew.config.json'), '{bad');
  const away = mkdtempSync(join(tmpdir(), 'crew-away-'));
  const bin = join(import.meta.dirname, '..', 'bin', 'crew.js');
  const env = { ...process.env, CREW_AGENT: 'gemini', CREW_AGENT_ID: 'gemini@test', CREW_METRICS: 'off' };
  delete env.CREW_PROJECT_DIR;
  const child = spawn(process.execPath, [bin, 'mcp'], { cwd: away, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const line = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  line({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: {} } } });
  line({ jsonrpc: '2.0', method: 'notifications/initialized' });
  line({ jsonrpc: '2.0', id: 'crew-roots', result: { roots: [{ uri: pathToFileURL(bad).href }] } });
  line({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const deadline = Date.now() + 10000;
  while (!/"id":2/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const alive = child.exitCode === null;
  child.kill();
  assert.ok(alive, 'the server is still running');
  assert.match(out, /"id":2,"result":\{"tools"/);
});

test('roots: a broken crew.config.json in one root skips it; the server keeps its tools', async () => {
  const bad = mkdtempSync(join(tmpdir(), 'crew-bad-'));
  writeFileSync(join(bad, 'crew.config.json'), '{bad');
  const good = mkdtempSync(join(tmpdir(), 'crew-good-'));
  writeFileSync(join(good, 'crew.config.json'), '{}');
  assert.equal(projectFromRoots([{ uri: pathToFileURL(bad).href }, { uri: pathToFileURL(good).href }]), good);
  const sent = [];
  const r = projectRoots({ send: (m) => sent.push(m), chdir: () => { throw new Error('chdir failed'); } });
  r.onMessage({ method: 'initialize', params: { capabilities: { roots: {} } } });
  r.onMessage({ method: 'notifications/initialized' });
  const waiting = r.ready();
  assert.throws(() => r.onMessage({ id: sent[0].id, result: { roots: [{ uri: pathToFileURL(good).href }] } }), /chdir failed/);
  await waiting; // settled anyway: a tool call waiting for roots goes on
});

test('crew up and doctor know antigravity: a host with no CLI, found as an installed app', () => {
  assert.ok(hostList('claude,antigravity').hosts.includes('antigravity'));
  assert.equal(antigravity.installed({ env: { LOCALAPPDATA: 'C:\\L' }, exists: (p) => p === 'C:\\L\\Programs\\antigravity\\Antigravity.exe' }), true);
  assert.equal(antigravity.installed({ env: {}, exists: () => false }), false);
  assert.deepEqual(hostWiring('/r', ['antigravity'], { exists: () => false, read: () => '' }), ['antigravity: the crew MCP server is not in .agents/plugins/crew/mcp_config.json']);
  assert.deepEqual(hostWiring('/r', ['antigravity'], { exists: () => true, read: () => '{"mcpServers":{"crew":{}}}' }), []);
});

test('MCP roots: a client that lists its folders gets the crew project among them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-roots-'));
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'crew.config.json'), '{}');
  const other = mkdtempSync(join(tmpdir(), 'crew-none-'));
  assert.equal(projectFromRoots([{ uri: pathToFileURL(other).href }, { uri: pathToFileURL(join(root, 'web')).href }]), root);
  assert.equal(projectFromRoots([{ uri: 'not a uri' }]), null);

  const sent = [];
  let cwd = null;
  const r = projectRoots({ send: (m) => sent.push(m), chdir: (d) => { cwd = d; } });
  assert.equal(r.onMessage({ method: 'initialize', params: { capabilities: { roots: { listChanged: true } } } }), false);
  r.onMessage({ method: 'notifications/initialized' });
  assert.equal(sent[0].method, 'roots/list');
  const waiting = r.ready();
  assert.equal(r.onMessage({ id: sent[0].id, result: { roots: [{ uri: pathToFileURL(root).href }] } }), true, 'our own answer is not handled as a request');
  await waiting;
  assert.equal(cwd, root);
  // no roots capability (Antigravity today), or a project fixed by CREW_PROJECT_DIR: nothing is asked
  for (const [caps, fixed] of [[{}, false], [{ roots: {} }, true]]) {
    const s = [];
    const q = projectRoots({ send: (m) => s.push(m), fixed });
    q.onMessage({ method: 'initialize', params: { capabilities: caps } });
    q.onMessage({ method: 'notifications/initialized' });
    assert.equal(s.length, 0);
    await q.ready();
  }
});
