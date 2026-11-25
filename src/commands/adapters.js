// crew adapters build [--check] — generates configs for each host (Claude Code, Codex, ...)
// from vendor-neutral sources: AGENTS.md, agents/roles/*.md, agents/skills/*/SKILL.md, crew.config.json.
// A new host = a new file adapters/<host>/adapter.js. No need to touch the core.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

/** The section, in .gitignore or .git/info/exclude, that lists the files crew task claim copies into worktrees. */
export const LOCAL_SECTION = '# crew: local files';

/** Lines of the "# crew: local files" section of one ignore file (stops at a blank line or another comment). */
export function sectionEntries(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === LOCAL_SECTION);
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    const t = l.trim();
    if (!t || t.startsWith('#')) break;
    out.push(t);
  }
  return out;
}

/** Put entries into the section of an ignore file's text (creating it), in the file's own line endings. */
export function addToSection(text, entries) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  const start = lines.findIndex((l) => l.trim() === LOCAL_SECTION);
  if (start < 0) {
    while (lines.length && lines.at(-1) === '') lines.pop();
    return [...lines, ...(lines.length ? [''] : []), LOCAL_SECTION, ...entries, ''].join(eol);
  }
  let end = start + 1;
  while (end < lines.length && lines[end].trim() && !lines[end].trim().startsWith('#')) end++;
  lines.splice(end, 0, ...entries);
  return lines.join(eol);
}

/**
 * Keep this machine's agent configs out of git (some hold this machine's paths) without touching tracked files:
 * missing entries go to .git/info/exclude, which is per clone and never makes the tree dirty (a .gitignore edit
 * would, right after crew up --join). They go into its "# crew: local files" section, which crew task claim reads
 * to copy the configs into task worktrees. → the entries added.
 */
export function ensureIgnored(root, files) {
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const gitDir = join(root, '.git');
  const ignore = read(join(root, '.gitignore'));
  const exclude = join(gitDir, 'info', 'exclude');
  const listed = new Set([...sectionEntries(ignore), ...sectionEntries(read(exclude))]);
  const add = ignoreEntries(files).filter((e) => !listed.has(e));
  if (!add.length) return [];
  if (existsSync(gitDir) && statSync(gitDir).isDirectory()) {
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(exclude, addToSection(read(exclude), add));
  } else {
    // no repository yet (crew init writes .gitignore itself; this is a folder git does not know): .gitignore it is
    writeFileSync(join(root, '.gitignore'), addToSection(ignore, add));
  }
  return add;
}

const lf = (s) => s.replace(/\r\n/g, '\n');
/**
 * Does the generated file need writing? Line endings do not count: with core.autocrlf=true git checks committed files
 * out with CRLF, and rewriting them with LF would leave a fresh clone dirty for no change at all (issue #1).
 */
export function needsWrite(root, f) {
  const p = join(root, f.path);
  return !existsSync(p) || lf(readFileSync(p, 'utf8')) !== lf(f.content);
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
  // two hosts may share a file (Codex and Antigravity both read .agents/skills/): write it once; if they disagree
  // on its content, that is a bug in an adapter, not something to resolve by write order
  const byPath = new Map();
  for (const f of files) {
    const seen = byPath.get(f.path);
    if (!seen) byPath.set(f.path, f);
    else if (seen.content !== f.content) throw new Error(`adapters ${seen.host} and ${f.host} generate different ${f.path}`);
  }
  return { files: [...byPath.values()], missing };
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
    const stale = files.filter((f) => needsWrite(root, f));
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
      artifacts: { written: stale.map((f) => f.path), local_only: local, git_exclude_added: ignored },
      next_actions: ['restart agent sessions so they pick up the configs'],
    });
  },
};
