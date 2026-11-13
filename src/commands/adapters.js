// crew adapters build [--check] — generates configs for each host (Claude Code, Codex, ...)
// from vendor-neutral sources: AGENTS.md, agents/roles/*.md, agents/skills/*/SKILL.md, crew.config.json.
// A new host = a new file adapters/<host>/adapter.js. No need to touch the core.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ok, fail } from '../core/output.js';
import { loadConfig, HARNESS_ROOT } from '../core/config.js';

export async function loadAdapter(host) {
  const p = join(HARNESS_ROOT, 'adapters', host, 'adapter.js');
  if (!existsSync(p)) return null;
  return (await import(pathToFileURL(p).href)).default;
}

export function readSources(root) {
  const read = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
  const roles = read(join(root, 'agents', 'roles'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: f.replace(/\.md$/, ''), content: readFileSync(join(root, 'agents', 'roles', f), 'utf8') }));
  const skills = read(join(root, 'agents', 'skills'))
    .filter((d) => existsSync(join(root, 'agents', 'skills', d, 'SKILL.md')))
    .map((d) => ({ name: d, content: readFileSync(join(root, 'agents', 'skills', d, 'SKILL.md'), 'utf8') }));
  return { roles, skills };
}

/** Simple frontmatter parsing: --- key: value --- */
export function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta = Object.fromEntries(
    m[1].split(/\r?\n/).filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  );
  return { meta, body: m[2] };
}

export async function buildFiles(root, config) {
  const sources = readSources(root);
  const files = [];
  const missing = [];
  for (const host of config.hosts ?? []) {
    const adapter = await loadAdapter(host);
    if (!adapter) { missing.push(host); continue; }
    for (const f of adapter.generate({ root, config, ...sources, frontmatter, platform: process.platform })) {
      files.push({ ...f, host });
    }
  }
  return { files, missing };
}

export default {
  name: 'adapters build',
  summary: 'Generate configs for agent hosts (Claude Code, Codex) from AGENTS.md, roles and skills',
  agent: false,
  args: [{ name: 'check', type: 'boolean', description: 'only check that generated files are up to date (for CI)' }],
  // cwd — for calls from crew up (cloned project folder); not passed from the CLI.
  async run({ check, cwd }) {
    const { config, root, path } = loadConfig(cwd);
    if (!path) return fail('no_config', 'crew.config.json not found', { retry: 'crew init <dir> or run from the project root' });
    const { files, missing } = await buildFiles(root, config);
    if (missing.length) {
      return fail('unknown_host', `No adapter for: ${missing.join(', ')}`, {
        cause_hint: `available adapters are in ${join(HARNESS_ROOT, 'adapters')}`,
        retry: 'fix hosts in crew.config.json',
      });
    }
    const stale = files.filter((f) => !existsSync(join(root, f.path)) || readFileSync(join(root, f.path), 'utf8') !== f.content);
    if (check) {
      // Only committed files are checked: local (machine-specific) ones differ per machine.
      const staleCommitted = stale.filter((f) => f.commit);
      return staleCommitted.length
        ? fail('adapters_stale', `Out of date: ${staleCommitted.map((f) => f.path).join(', ')}`, { retry: 'crew adapters build' })
        : ok('Generated files are up to date');
    }
    for (const f of stale) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true });
      writeFileSync(join(root, f.path), f.content);
    }
    const local = files.filter((f) => !f.commit).map((f) => f.path);
    return ok(`Adapters: ${config.hosts.join(', ')} — files updated: ${stale.length} of ${files.length}`, {
      artifacts: { written: stale.map((f) => f.path), local_only: local },
      next_actions: ['restart agent sessions so they pick up the configs'],
    });
  },
};
