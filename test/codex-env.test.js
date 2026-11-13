import test from 'node:test';
import assert from 'node:assert/strict';
import codex from '../adapters/codex/adapter.js';

const generate = (platform) => codex.generate({
  config: { mcp: { optional: { enabled: true, command: 'node', env_from: ['OPTIONAL_KEY'] } } },
  roles: [], skills: [], platform,
}).find((f) => f.path === '.codex/config.toml').content;

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`Codex MCP keeps worker identity and GitHub auth by variable name (${platform})`, () => {
    const content = generate(platform);
    const crew = content.split('[mcp_servers.crew]')[1].split('[mcp_servers.optional]')[0];
    const forwarded = JSON.parse(crew.match(/^env_vars = (.+)$/m)?.[1] ?? '[]');
    for (const key of ['CREW_AGENT_ID', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      assert.ok(forwarded.includes(key), `${key} must reach the MCP child`);
    }
    assert.match(crew, /CREW_AGENT = "codex"/); // interactive sessions without a worker still have a host
    assert.match(content, /env_vars = \["OPTIONAL_KEY"\]/);
    assert.ok(!forwarded.includes('OPTIONAL_KEY'), 'optional server secrets are not copied into crew');
  });
}

test('Codex generation never serializes identity or token values', (t) => {
  const values = { CREW_AGENT_ID: 'codex/test@worker-42', GH_TOKEN: 'fake-github-token', GITHUB_TOKEN: 'fake-actions-token' };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    process.env[key] = value;
  }
  const content = generate('linux');
  for (const value of Object.values(values)) assert.ok(!content.includes(value));
});
