// crew doctor — check that the machine is ready to work.
import { ok, fail } from '../core/output.js';
import { run } from '../core/exec.js';
import { loadConfig, agentId } from '../core/config.js';
import { LOCAL_VERSION, updateHint } from '../core/version.js';

const probe = (cmd, args) => {
  const r = run(cmd, args, { allowFail: true });
  return r.code === 0 ? (r.stdout || r.stderr).split('\n')[0] : null;
};

export default {
  name: 'doctor',
  summary: 'Check the environment: node, git, gh (auth), claude, codex, project config',
  args: [],
  run() {
    const { config, path } = loadConfig();
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
    for (const h of config.hosts ?? []) items[h] = tool(h, ['--version']);
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
    const notes = [hostsMissing.length ? `agents missing: ${hostsMissing.join(', ')}` : null, hint ? `crew is outdated (${LOCAL_VERSION})` : null].filter(Boolean);
    return ok(notes.length ? `Environment OK, but ${notes.join('; ')}` : 'Environment ready', {
      status: notes.length ? 'warning' : 'success',
      artifacts: items,
      next_actions: [...(hint ? [hint] : []), ...(path ? ['crew status'] : ['crew init <dir> — create a project'])],
    });
  },
};
