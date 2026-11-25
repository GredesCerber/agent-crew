// crew doctor — check that the machine is ready to work.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, fail } from '../core/output.js';
import { run } from '../core/exec.js';
import { loadConfig, agentId } from '../core/config.js';
import { LOCAL_VERSION, updateHint } from '../core/version.js';
import { loadAdapter } from './adapters.js';

const probe = (cmd, args) => {
  const r = run(cmd, args, { allowFail: true });
  return r.code === 0 ? (r.stdout || r.stderr).split('\n')[0] : null;
};

/**
 * Is the crew MCP server wired for each host in this project? Agents should call crew through MCP: host permission
 * checks pre-approve those tools, while shell calls with a full path or node get refused as "external writes".
 * -> list of problems (empty = fine).
 */
export function hostWiring(root, hosts = [], { exists = existsSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const problems = [];
  const has = (rel, re) => exists(join(root, rel)) && re.test(read(join(root, rel)));
  if (hosts.includes('claude')) {
    if (!has('.mcp.json', /"crew"\s*:/)) problems.push('claude: the crew MCP server is not in .mcp.json');
    if (!has('.claude/settings.json', /mcp__crew/)) problems.push('claude: .claude/settings.json does not pre-approve the crew tools');
  }
  if (hosts.includes('codex') && !has('.codex/config.toml', /\[mcp_servers\.crew\]/)) problems.push('codex: the crew MCP server is not in .codex/config.toml');
  if (hosts.includes('antigravity') && !has('.agents/plugins/crew/mcp_config.json', /"crew"\s*:/)) problems.push('antigravity: the crew MCP server is not in .agents/plugins/crew/mcp_config.json');
  return problems;
}

export default {
  name: 'doctor',
  summary: 'Check the environment: node, git, gh (auth), the agent hosts (claude, codex, antigravity), project config',
  args: [],
  async run() {
    const { config, path, root } = loadConfig();
    const winCmd = process.platform === 'win32';
    const tool = (name, args) => probe(name, args) ?? (winCmd ? probe('cmd', ['/c', name, ...args]) : null);
    const items = {
      node: process.version,
      git: tool('git', ['--version']),
      gh: tool('gh', ['--version']),
      gh_auth: run('gh', ['auth', 'status'], { allowFail: true }).code === 0 ? 'ok' : null,
      config: path ?? null,
      agent_id: agentId(),
    };
    // a host with a CLI answers --version; an app with no command on PATH (Antigravity) says itself whether it is installed
    for (const h of config.hosts ?? []) {
      const a = await loadAdapter(h);
      items[h] = a && typeof a.installed === 'function' ? (a.installed({ exists: existsSync }) ? 'installed' : null) : tool(h, ['--version']);
    }
    const required = ['git', 'gh', 'gh_auth'];
    const missing = required.filter((k) => !items[k]);
    const hostsMissing = (config.hosts ?? []).filter((h) => !items[h]);
    if (missing.length) {
      return fail('env_missing', `Missing: ${missing.join(', ')}`, {
        cause_hint: missing.includes('gh_auth') ? 'gh is not authenticated' : 'tool is not installed',
        retry: missing.includes('gh_auth') ? 'gh auth login' : 'install it and re-run crew doctor',
        artifacts: items,
      });
    }
    items.crew = LOCAL_VERSION;
    const hint = updateHint();
    const wiring = path ? hostWiring(root, config.hosts ?? []) : [];
    if (wiring.length) items.wiring = wiring;
    const notes = [...wiring.map((w) => `${w} (crew adapters build)`), hostsMissing.length ? `agents missing: ${hostsMissing.join(', ')}` : null, hint ? `crew is outdated (${LOCAL_VERSION})` : null].filter(Boolean);
    return ok(notes.length ? `Environment OK, but ${notes.join('; ')}` : 'Environment ready', {
      status: notes.length ? 'warning' : 'success',
      artifacts: items,
      next_actions: [...(hint ? [hint] : []), ...(path ? ['crew status'] : ['crew init <dir> — create a project'])],
    });
  },
};
