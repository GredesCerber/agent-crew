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

/**
 * .gitignore lines for the files that stay on this machine: a skills folder or a plugin folder as a whole, other
 * files one by one. Some hold this machine's paths, so they must never be committed.
 */
export function ignoreEntries(files) {
  const entry = (p) => {
    if (p.includes('/skills/')) return p.split('/skills/')[0] + '/skills/';
    const plugin = /^(.*\/plugins\/[^/]+\/)/.exec(p);
    return plugin ? plugin[1] : p;
  };
  return [...new Set(files.filter((f) => !f.commit).map((f) => entry(f.path)))];
}

/** Add the missing local entries to an existing .gitignore (a host added to a project later). → the lines added. */
export function ensureIgnored(root, files) {
  const p = join(root, '.gitignore');
  if (!existsSync(p)) return [];
  const text = readFileSync(p, 'utf8');
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const add = ignoreEntries(files).filter((e) => !have.has(e));
  if (add.length) writeFileSync(p, `${text}${text.endsWith('\n') || !text ? '' : '\n'}# crew: local agent configs\n${add.join('\n')}\n`);
  return add;
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
  summary: 'Generate configs for agent hosts (Claude Code, Codex, Antigravity) from AGENTS.md, roles and skills',
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
    const ignored = ensureIgnored(root, files);
    const local = files.filter((f) => !f.commit).map((f) => f.path);
    // "0 of 26" read like a failure: say plainly that nothing needed changing, and that some files stay on this machine.
    const what = stale.length ? `${stale.length} of ${files.length} files updated` : `all ${files.length} files already up to date`;
    return ok(`Agent configs for ${config.hosts.join(', ')}: ${what} (${local.length} of them are local to this machine, not committed)`, {
      artifacts: { written: stale.map((f) => f.path), local_only: local, gitignore_added: ignored },
      next_actions: ['restart agent sessions so they pick up the configs'],
    });
  },
};
