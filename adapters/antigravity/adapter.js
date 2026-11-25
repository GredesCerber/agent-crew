// Google Antigravity adapter (the desktop app and its agent; verified against Antigravity 44.9 on Windows).
// Antigravity reads AGENTS.md from the repo itself (rules: GEMINI.md / AGENTS.md, walking up to the repo root), and
// skills from .agents/skills/<name>/SKILL.md, the same folder the Codex adapter writes.
// MCP servers come only from ~/.gemini/config/mcp_config.json (all projects) or from a plugin. To keep crew per
// project, this adapter writes a workspace plugin: .agents/plugins/crew/ with plugin.json, mcp_config.json (the crew
// server) and rules/AGENTS.md (how this agent names itself in the terminal). The plugin holds this machine's project
// path, so it is local and not committed.
const IDENTITY = 'gemini'; // the vendor of the model behind Antigravity by default: what cross-vendor review compares

const mcpEntry = (srv, platform) => {
  // Antigravity spawns stdio servers without a shell; npm's .cmd shims need cmd /c on Windows
  const winWrap = platform === 'win32' && ['npx', 'crew', 'npm'].includes(srv.command);
  const entry = { command: winWrap ? 'cmd' : srv.command, args: winWrap ? ['/c', srv.command, ...(srv.args ?? [])] : srv.args ?? [] };
  if (srv.env && Object.keys(srv.env).length) entry.env = srv.env;
  return entry;
};

const RULE = (agent) => `# crew: who you are

You are an agent of an agent-crew project. Follow the AGENTS.md of this repo and the crew-workflow skill.

- Use the **crew** MCP tools (crew_task_next, crew_task_claim, crew_commit, crew_pr_open, crew_pr_review, ...) for crew
  steps: they already know your agent name (${agent}@<this machine>).
- If you run \`crew ...\` in a terminal instead, set the name first in that terminal, or crew records the step as
  "human":
  - PowerShell: \`$env:CREW_AGENT='${agent}'\`
  - bash/zsh: \`export CREW_AGENT=${agent}\`
- Check it with the crew_status tool or \`crew status\`: the agent shown must be ${agent}@..., not human@....
`;

export default {
  id: 'antigravity',
  // Antigravity puts no command on PATH; crew up looks for the app instead (installed).
  binary: null,

  /** Is the app installed on this machine? (a host with no CLI on PATH) */
  installed({ env = process.env, exists } = {}) {
    const local = env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\antigravity\\Antigravity.exe` : null;
    const home = env.USERPROFILE ?? env.HOME;
    const candidates = [local, '/Applications/Antigravity.app', home ? `${home}/.gemini/antigravity` : null].filter(Boolean);
    return candidates.some((p) => exists(p));
  },

  generate({ root, config, roles, skills, frontmatter, platform }) {
    const files = [];
    const servers = {
      crew: mcpEntry({ command: 'crew', args: ['mcp'], env: { CREW_AGENT: IDENTITY, ...(root ? { CREW_PROJECT_DIR: root } : {}) } }, platform),
    };
    // optional MCP servers from crew.config.json. Secrets (env_from: GH_TOKEN, API keys) are never written here: a
    // stdio server inherits the environment of Antigravity itself, so set them in the user environment and restart it
    for (const [name, srv] of Object.entries(config.mcp ?? {})) if (srv.enabled) servers[name] = mcpEntry(srv, platform);
    const dir = '.agents/plugins/crew';
    files.push({ path: `${dir}/plugin.json`, commit: false, content: JSON.stringify({ name: 'crew', homepage: 'https://github.com/GredesCerber/agent-crew' }, null, 2) + '\n' });
    files.push({ path: `${dir}/mcp_config.json`, commit: false, content: JSON.stringify({ mcpServers: servers }, null, 2) + '\n' });
    files.push({ path: `${dir}/rules/AGENTS.md`, commit: false, content: RULE(IDENTITY) });

    // skills and roles exactly as the Codex adapter writes them (same folder, same content): both hosts can be on
    for (const s of skills) files.push({ path: `.agents/skills/${s.name}/SKILL.md`, commit: false, content: s.content });
    for (const r of roles) {
      const { meta, body } = frontmatter(r.content);
      files.push({ path: `.agents/skills/role-${r.name}/SKILL.md`, commit: false, content: `---\nname: role-${r.name}\ndescription: ${meta.description ?? r.name}\n---\n${body}` });
    }
    return files;
  },
};
