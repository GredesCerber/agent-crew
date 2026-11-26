// crew skills — the project's skill set, kept small on purpose. Agents read every skill's description each session, so
// each extra skill costs context and attention: crew counts them against a budget (skills.max in crew.config.json).
//   crew skills                         what is in agents/skills (crew's own and added), the ECC plugin, the budget
//   crew skills add <source> [--only a,b] [--preset role]
//                                       copy skills from a folder or a git repo; `ecc` is ECC's repo, and --preset takes
//                                       ECC's picks for a role from ecc/profile.json instead of the whole plugin
//   crew skills remove <name,...>       remove added skills (crew's own stay)
//   crew skills ecc --on|--off          the whole ECC plugin for Claude Code (hundreds of skills) on or off
// Added skills live in agents/skills/<name>/ and are committed: everyone's agents get the same set, through a PR.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ok, warn, fail } from '../core/output.js';
import { run } from '../core/exec.js';
import { loadConfig, requireProject, HARNESS_ROOT } from '../core/config.js';

export const DEFAULT_MAX = 20;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OWN = new Set(readdirSync(join(HARNESS_ROOT, 'skills')));
const eccProfile = () => JSON.parse(readFileSync(join(HARNESS_ROOT, 'ecc', 'profile.json'), 'utf8'));

/** name and description from a SKILL.md front matter. */
export function skillMeta(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const field = (k) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return { name: field('name'), description: field('description') };
}

/** Skill folders in a source tree: skills/*, .claude/skills/*, .agents/skills/*, agents/skills/*, * — or the folder itself. */
export function findSkills(src) {
  const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  const has = (d) => existsSync(join(d, 'SKILL.md'));
  if (has(src)) return [{ name: basename(resolve(src)), dir: src }];
  const found = new Map();
  for (const base of ['skills', join('.claude', 'skills'), join('.agents', 'skills'), join('agents', 'skills'), '.']) {
    const root = join(src, base);
    if (!isDir(root)) continue;
    for (const d of readdirSync(root)) {
      const dir = join(root, d);
      if (d !== '.git' && isDir(dir) && has(dir) && !found.has(d)) found.set(d, { name: d, dir });
    }
  }
  return [...found.values()];
}

/** Does a name match a pattern from the profile ("multi-*")? */
const matches = (name, pat) => (pat.endsWith('*') ? name.startsWith(pat.slice(0, -1)) : name === pat);

/** The skills in agents/skills, crew's own marked. → [{ name, own, description, chars }] */
export function projectSkills(root) {
  const dir = join(root, 'agents', 'skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, 'SKILL.md'))).map((d) => {
    const { description } = skillMeta(readFileSync(join(dir, d, 'SKILL.md'), 'utf8'));
    return { name: d, own: OWN.has(d), description, chars: description.length };
  });
}

/** crew.config.json, edited in place (other keys and their order stay as they are). */
function editConfig(root, fn) {
  const path = join(root, 'crew.config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  fn(cfg);
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}

const budgetOf = (config) => (Number(config.skills?.max) > 0 ? Number(config.skills.max) : DEFAULT_MAX);
const AFTER = ['crew adapters build — the agent hosts get the new set', 'commit agents/skills and crew.config.json through a PR, so the whole team gets the same skills'];

/** The project, or { error } (a crew envelope) when this is not one. */
function project(cwd) {
  const loaded = loadConfig(cwd);
  return { ...loaded, error: requireProject(loaded) };
}

const list = {
  name: 'skills',
  summary: 'The project skill set: crew\'s own and added skills, the ECC plugin, and the skill budget',
  agent: false,
  run({ cwd } = {}) {
    const { error, config, root } = project(cwd);
    if (error) return error;
    const skills = projectSkills(root);
    const max = budgetOf(config);
    const ecc = config.ecc?.enabled !== false;
    const over = skills.length > max;
    const added = skills.filter((s) => !s.own);
    const summary = `${skills.length} skill(s) in agents/skills (${skills.length - added.length} crew, ${added.length} added; budget ${max})${ecc ? '; the ECC plugin is on in Claude Code (all of its skills)' : ''}`;
    const opts = {
      artifacts: { skills, max, ecc, sources: config.skills?.added ?? [] },
      next_actions: [
        ...(over ? [`over the budget by ${skills.length - max}: crew skills remove <name> for the ones no role needs`] : []),
        ...(ecc ? ['the ECC plugin loads every ECC skill into each Claude session: crew skills ecc --off, then crew skills add ecc --preset <role> for just the ones a role uses'] : []),
        'crew skills add <folder | git URL | ecc> [--only a,b] [--preset role]',
      ],
    };
    return over ? warn(summary, opts) : ok(summary, opts);
  },
};

const add = {
  name: 'skills add',
  summary: 'Copy skills into agents/skills from a folder, a git repo, or ECC (--preset role takes ECC\'s picks for that role)',
  agent: false,
  args: [
    { name: 'source', type: 'string', positional: true, required: true, description: 'a folder, a git URL (https://...), or ecc' },
    { name: 'only', type: 'string', description: 'comma-separated skill names to take (default: all found, or the preset)' },
    { name: 'preset', type: 'string', description: `with ecc: a role from ecc/profile.json (${Object.keys(eccProfile().roles).join(', ')}); the common picks come along` },
    { name: 'force', type: 'boolean', description: 'replace added skills that exist, and go over the skill budget' },
  ],
  run({ source, only, preset, force = false, cwd }, deps = {}) {
    const { error, config, root } = project(cwd);
    if (error) return error;
    const profile = eccProfile();
    const isEcc = source === 'ecc';
    const url = isEcc ? (config.ecc?.marketplace ?? profile.marketplace) : String(source);
    if (preset && !isEcc) return fail('bad_input', '--preset works with ecc only', { retry: 'crew skills add ecc --preset reviewer' });
    if (preset && !profile.roles[preset]) return fail('bad_input', `ECC has no preset "${preset}"`, { retry: `one of: ${Object.keys(profile.roles).join(', ')}` });
    let wanted = only ? String(only).split(',').map((s) => s.trim()).filter(Boolean) : null;
    if (preset) wanted = [...new Set([...(profile.roles.common ?? []), ...profile.roles[preset], ...(wanted ?? [])])];

    // a git URL is cloned shallow into a temp folder; a folder is read as it is
    const remote = /^(https:\/\/|git@|ssh:\/\/)/.test(url);
    let src = url;
    let tmp = null;
    if (remote) {
      tmp = mkdtempSync(join(tmpdir(), 'crew-skills-'));
      const clone = (deps.clone ?? ((u, d) => run('git', ['clone', '--depth', '1', '--quiet', u, d], { allowFail: true })))(url, tmp);
      if (clone.code !== 0) {
        rmSync(tmp, { recursive: true, force: true });
        return fail('clone_failed', `Could not clone ${url}`, { cause_hint: String(clone.stderr ?? '').split('\n')[0], retry: 'check the URL and your network, then run it again', stop_when: 'a private repo you have no access to' });
      }
      src = tmp;
    } else if (!existsSync(src)) {
      return fail('bad_input', `No folder ${src}`, { retry: 'crew skills add <folder | git URL | ecc>' });
    }
    try {
      const found = findSkills(src);
      const avoid = isEcc ? profile.avoid ?? [] : [];
      const missing = (wanted ?? []).filter((n) => !found.some((f) => f.name === n));
      const pick = found.filter((f) => (wanted ? wanted.includes(f.name) : true) && !avoid.some((p) => matches(f.name, p)) && NAME_RE.test(f.name));
      if (!pick.length) {
        return fail('no_skills', `No skills to add from ${url}${wanted ? ` (wanted: ${wanted.join(', ')})` : ''}`, {
          cause_hint: found.length ? `found ${found.length}, none matched` : 'no <name>/SKILL.md under skills/, .claude/skills/, .agents/skills/ or the top folder',
          retry: found.length ? `crew skills add ${source} --only ${found.slice(0, 3).map((f) => f.name).join(',')}` : 'point it at a folder that has <name>/SKILL.md',
        });
      }
      const have = new Set(projectSkills(root).map((s) => s.name));
      const ownClash = pick.filter((f) => OWN.has(f.name));
      if (ownClash.length) return fail('skill_own', `${ownClash.map((f) => f.name).join(', ')} is crew's own skill and is not replaced`, { retry: 'take the others with --only' });
      const clash = pick.filter((f) => have.has(f.name));
      if (clash.length && !force) return fail('skill_exists', `Already in agents/skills: ${clash.map((f) => f.name).join(', ')}`, { retry: `crew skills add ${source} --force to replace them, or --only for the rest` });
      const total = have.size + pick.filter((f) => !have.has(f.name)).length;
      const max = budgetOf(config);
      if (total > max && !force) {
        return fail('skill_budget', `${total} skills would be over the budget of ${max}: agents read every skill's description in each session`, {
          cause_hint: `adding ${pick.length}: ${pick.map((f) => f.name).join(', ')}`,
          retry: 'take fewer (--only), remove some (crew skills remove <name>), or raise skills.max in crew.config.json; --force goes over it once',
        });
      }
      const dest = join(root, 'agents', 'skills');
      for (const f of pick) {
        rmSync(join(dest, f.name), { recursive: true, force: true });
        cpSync(f.dir, join(dest, f.name), { recursive: true, filter: (p) => basename(p) !== '.git' });
      }
      const ref = remote ? (deps.head ?? ((d) => run('git', ['rev-parse', 'HEAD'], { cwd: d, allowFail: true }).stdout))(src) || null : null;
      editConfig(root, (cfg) => {
        cfg.skills = cfg.skills ?? {};
        const rest = (cfg.skills.added ?? []).filter((a) => !pick.some((f) => f.name === a.name));
        cfg.skills.added = [...rest, ...pick.map((f) => ({ name: f.name, source: isEcc ? 'ecc' : url, ...(ref ? { ref } : {}), ...(preset ? { preset } : {}) }))];
      });
      return (missing.length ? warn : ok)(`Added ${pick.length} skill(s) to agents/skills: ${pick.map((f) => f.name).join(', ')} (${total}/${max})`, {
        artifacts: { added: pick.map((f) => f.name), missing, total, max, source: url, ...(ref ? { ref } : {}) },
        next_actions: [
          ...(missing.length ? [`not found in ${url}: ${missing.join(', ')}`] : []),
          ...(isEcc && config.ecc?.enabled !== false ? ['the whole ECC plugin is still on: crew skills ecc --off, so only these ECC skills load'] : []),
          'read them before the PR: a skill is an instruction your agents follow',
          ...AFTER,
        ],
      });
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  },
};

const remove = {
  name: 'skills remove',
  summary: 'Remove added skills from agents/skills (crew\'s own skills stay)',
  agent: false,
  args: [{ name: 'names', type: 'string', positional: true, required: true, description: 'comma-separated skill names' }],
  run({ names, cwd }) {
    const { error, root } = project(cwd);
    if (error) return error;
    const want = String(names).split(',').map((s) => s.trim()).filter(Boolean);
    const own = want.filter((n) => OWN.has(n));
    if (own.length) return fail('skill_own', `${own.join(', ')} is crew's own: agents need it to work through crew`, { retry: 'remove only skills you added (crew skills shows which)' });
    const have = new Set(projectSkills(root).map((s) => s.name));
    const gone = want.filter((n) => have.has(n));
    for (const n of gone) rmSync(join(root, 'agents', 'skills', n), { recursive: true, force: true });
    editConfig(root, (cfg) => { if (cfg.skills?.added) cfg.skills.added = cfg.skills.added.filter((a) => !gone.includes(a.name)); });
    const unknown = want.filter((n) => !have.has(n));
    return (unknown.length ? warn : ok)(`Removed ${gone.length} skill(s)${gone.length ? `: ${gone.join(', ')}` : ''}`, {
      artifacts: { removed: gone, unknown },
      next_actions: [...(unknown.length ? [`not in agents/skills: ${unknown.join(', ')}`] : []), ...AFTER],
    });
  },
};

const ecc = {
  name: 'skills ecc',
  summary: 'Turn the whole ECC plugin for Claude Code on or off (crew skills add ecc --preset <role> takes only a role\'s picks)',
  agent: false,
  args: [
    { name: 'on', type: 'boolean', description: 'turn the plugin on' },
    { name: 'off', type: 'boolean', description: 'turn the plugin off' },
  ],
  run({ on, off, cwd }) {
    const { error, root } = project(cwd);
    if (error) return error;
    if (!!on === !!off) return fail('bad_input', 'Say --on or --off', { retry: 'crew skills ecc --off' });
    editConfig(root, (cfg) => { cfg.ecc = { ...(cfg.ecc ?? {}), enabled: !!on }; });
    return ok(`The ECC plugin is ${on ? 'on' : 'off'} for Claude Code in this project`, {
      artifacts: { ecc: !!on },
      next_actions: [...(off ? ['crew skills add ecc --preset <role> — keep just the ECC skills a role uses'] : []), ...AFTER],
    });
  },
};

export default [list, add, remove, ecc];
