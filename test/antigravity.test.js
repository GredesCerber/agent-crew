// Antigravity host: a workspace plugin with the crew MCP server, skills where Codex puts them, local files ignored,
// the MCP server finding its project (CREW_PROJECT_DIR, MCP roots). No network; the app itself is not needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import antigravity from '../adapters/antigravity/adapter.js';
import codex from '../adapters/codex/adapter.js';
import { frontmatter, ignoreEntries, ensureIgnored } from '../src/commands/adapters.js';
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

test('local files are git-ignored, also when a host is added to an existing project', () => {
  assert.deepEqual(ignoreEntries(gen('linux', '/p')), ['.agents/plugins/crew/', '.agents/skills/']);
  const root = mkdtempSync(join(tmpdir(), 'crew-ag-'));
  writeFileSync(join(root, '.gitignore'), 'node_modules/');
  assert.deepEqual(ensureIgnored(root, gen('linux', root)), ['.agents/plugins/crew/', '.agents/skills/']);
  assert.deepEqual(ensureIgnored(root, gen('linux', root)), [], 'added once');
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^node_modules\/\n# crew: local agent configs\n\.agents\/plugins\/crew\/\n\.agents\/skills\/\n$/);
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
