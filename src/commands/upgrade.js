// crew upgrade [--apply] — bring an existing project's crew files up to this version of agent-crew:
// AGENTS.md, roles, skills, GitHub workflows and templates, playbooks, generated agent configs, new config keys.
// Also migrates projects made by hackathon-harness (hk): hk.config.json, hk*.yml, hk-* skills, docs/tz*.md.
// Without --apply it only shows the plan. With --apply: branch crew/upgrade-<version>, one commit, a PR.
// The PR changes protected files (AGENTS.md, .github/, agents/), so crew-guard rejects it by design:
// a human (admin) reviews and merges it.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ok, fail } from '../core/output.js';
import { git, gh } from '../core/exec.js';
import { HARNESS_ROOT, DEFAULT_CONFIG } from '../core/config.js';
import { LOCAL_VERSION } from '../core/version.js';
import { buildFiles } from './adapters.js';

/** Files agent-crew owns in a product repo: [source in the package, destination in the repo]. */
export const OWNED = [
  ['templates/product/AGENTS.md', 'AGENTS.md'],
  ['templates/product/.github', '.github'],
  ['templates/product/docs/playbooks', 'docs/playbooks'],
  ['roles', 'agents/roles'],
  ['skills', 'agents/skills'],
];
const LEGACY_DELETE = ['.github/workflows/hk.yml', '.github/workflows/hk-guard.yml'];
/** Skills shipped by hackathon-harness; a project's own skills (even named hk-*) are never touched. */
const LEGACY_SKILLS = ['hk-kickoff', 'hk-review', 'hk-tz-analysis', 'hk-workflow'];
const LEGACY_RENAME = [['hk.config.json', 'crew.config.json'], ['docs/tz.md', 'docs/brief.md'], ['docs/tz-analysis.md', 'docs/brief-analysis.md']];

const walk = (abs, base = abs) => {
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [relative(base, abs).replace(/\\/g, '/')];
  return readdirSync(abs).flatMap((n) => walk(join(abs, n), base));
};
const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');

/** Package files to put into the repo: [{ path, content }]. */
export function ownedFiles(harnessRoot = HARNESS_ROOT) {
  const out = [];
  for (const [src, dest] of OWNED) {
    const abs = join(harnessRoot, src);
    if (statSync(abs).isFile()) out.push({ path: dest, content: readFileSync(abs, 'utf8') });
    else for (const f of walk(abs)) out.push({ path: `${dest}/${f}`, content: readFileSync(join(abs, f), 'utf8') });
  }
  return out;
}

/** Config after upgrade: user values kept; missing top-level keys and missing areas added. */
export function mergeConfig(cfg = {}, defaults = DEFAULT_CONFIG) {
  const out = { ...cfg };
  const added = [];
  for (const [k, v] of Object.entries(defaults)) if (!(k in out)) { out[k] = v; added.push(k); }
  if (defaults.areas && out.areas) {
    for (const [a, globs] of Object.entries(defaults.areas)) {
      if (!(a in out.areas)) { out.areas = { ...out.areas, [a]: globs }; added.push(`areas.${a}`); }
    }
  }
  return { config: out, added };
}

/** .gitignore: the legacy local-files section header and .hk/ become their crew names. */
export function migrateGitignore(text = '') {
  return norm(text)
    .replace(/^# hk: (локальные файлы|local files)$/m, '# crew: local files')
    .replace(/^\.hk\/$/m, '.crew/');
}

/**
 * The plan (pure): repo = { exists(p), read(p), list(dir) }. → { ops, legacy, config_added }
 * op: { op: 'rename', from, path } | { op: 'delete', path } | { op: 'write', path, content, kind: 'create'|'update' }
 */
export function planUpgrade(repo, { files = ownedFiles(), defaults = DEFAULT_CONFIG } = {}) {
  const ops = [];
  const legacy = repo.exists('hk.config.json') && !repo.exists('crew.config.json');
  const moved = new Map(); // destination path -> content (after legacy renames)
  for (const [from, to] of LEGACY_RENAME) {
    if (repo.exists(from) && !repo.exists(to)) { ops.push({ op: 'rename', from, path: to }); moved.set(to, repo.read(from)); }
  }
  for (const p of LEGACY_DELETE) if (repo.exists(p)) ops.push({ op: 'delete', path: p });
  for (const p of repo.list?.('agents/skills') ?? []) {
    if (LEGACY_SKILLS.some((s) => p.startsWith(`agents/skills/${s}/`))) ops.push({ op: 'delete', path: p });
  }
  for (const f of files) {
    const cur = repo.exists(f.path) ? repo.read(f.path) : null;
    if (cur === null) ops.push({ op: 'write', path: f.path, content: f.content, kind: 'create' });
    else if (norm(cur) !== norm(f.content)) ops.push({ op: 'write', path: f.path, content: f.content, kind: 'update' });
  }
  const cfgText = moved.get('crew.config.json') ?? (repo.exists('crew.config.json') ? repo.read('crew.config.json') : null);
  let config_added = [];
  if (cfgText !== null) {
    const { config, added } = mergeConfig(JSON.parse(cfgText), defaults);
    config_added = added;
    if (added.length) ops.push({ op: 'write', path: 'crew.config.json', content: JSON.stringify(config, null, 2) + '\n', kind: 'update' });
  }
  if (repo.exists('.gitignore')) {
    const gi = repo.read('.gitignore');
    const next = migrateGitignore(gi);
    if (next !== norm(gi)) ops.push({ op: 'write', path: '.gitignore', content: next, kind: 'update' });
  }
  return { ops, legacy, config_added };
}

const summarize = (ops) => ops.map((o) => (o.op === 'rename' ? `rename ${o.from} -> ${o.path}` : `${o.op === 'delete' ? 'delete' : o.kind} ${o.path}`));

export default {
  name: 'upgrade',
  summary: 'Update this project to the installed agent-crew: rules, skills, workflows, configs (and migrate from hk); --apply opens a PR',
  agent: false,
  args: [{ name: 'apply', type: 'boolean', description: 'create the branch, commit and open the PR (without it: only show the plan)' }],
  async run({ apply = false } = {}) {
    const top = git(['rev-parse', '--show-toplevel'], { allowFail: true });
    if (top.code !== 0) return fail('not_a_repo', 'Run crew upgrade inside the project repo', { retry: 'cd <project> && crew upgrade' });
    const root = top.stdout.trim();
    if (!existsSync(join(root, 'crew.config.json')) && !existsSync(join(root, 'hk.config.json'))) {
      return fail('not_a_crew_project', 'No crew.config.json (or legacy hk.config.json) here', { retry: 'crew init <dir> for a new project' });
    }
    const repo = {
      exists: (p) => existsSync(join(root, p)),
      read: (p) => readFileSync(join(root, p), 'utf8'),
      list: (p) => walk(join(root, p)).map((f) => `${p}/${f}`),
    };
    const plan = planUpgrade(repo);
    const branch = `crew/upgrade-${LOCAL_VERSION}`;
    const lines = summarize(plan.ops);
    if (!apply) {
      return ok(plan.ops.length ? `crew upgrade to ${LOCAL_VERSION}: ${plan.ops.length} changes (dry run)${plan.legacy ? ', migrating from hk' : ''}` : `Already up to date with agent-crew ${LOCAL_VERSION}`, {
        artifacts: { version: LOCAL_VERSION, legacy: plan.legacy, changes: lines, config_added: plan.config_added },
        next_actions: plan.ops.length ? ['crew upgrade --apply (creates a branch and a PR; agent configs are regenerated too)'] : ['nothing to do'],
      });
    }
    if (!plan.ops.length) return ok(`Already up to date with agent-crew ${LOCAL_VERSION}`);
    if (git(['status', '--porcelain'], { cwd: root }).stdout.trim()) {
      return fail('dirty_tree', 'Uncommitted changes in the project', { retry: 'commit or stash them, then crew upgrade --apply' });
    }
    git(['fetch', '--quiet', 'origin'], { cwd: root, allowFail: true });
    const base = (gh(['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { cwd: root, allowFail: true }).stdout || '').trim() || 'main';
    const sw = git(['switch', '-c', branch, `origin/${base}`], { cwd: root, allowFail: true });
    if (sw.code !== 0) return fail('branch_exists', `Could not create ${branch}`, { cause_hint: (sw.stderr || sw.stdout).split('\n')[0], retry: `git branch -D ${branch} (if it is a leftover), then crew upgrade --apply` });
    for (const o of plan.ops) {
      if (o.op === 'rename') git(['mv', o.from, o.path], { cwd: root });
      else if (o.op === 'delete') rmSync(join(root, o.path), { force: true });
    }
    for (const o of plan.ops.filter((x) => x.op === 'write')) {
      mkdirSync(dirname(join(root, o.path)), { recursive: true });
      writeFileSync(join(root, o.path), o.content);
    }
    // Generated agent configs from the new rules (same as crew adapters build), committed ones only.
    const config = JSON.parse(readFileSync(join(root, 'crew.config.json'), 'utf8'));
    const { files } = await buildFiles(root, config);
    for (const f of files.filter((x) => x.commit)) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true });
      writeFileSync(join(root, f.path), f.content);
    }
    git(['add', '-A'], { cwd: root });
    git(['commit', '-q', '-m', `chore: upgrade to agent-crew ${LOCAL_VERSION}`, '-m', 'Agent: crew-upgrade'], { cwd: root });
    const push = git(['push', '-u', 'origin', branch], { cwd: root, allowFail: true });
    if (push.code !== 0) return fail('push_failed', `Committed on ${branch}, push failed`, { cause_hint: (push.stderr || push.stdout).split('\n')[0], retry: `git push -u origin ${branch}` });
    const body = [
      `Upgrade to agent-crew ${LOCAL_VERSION}${plan.legacy ? ' (migration from hackathon-harness / hk)' : ''}.`,
      '',
      'Changes:',
      ...lines.map((l) => `- ${l}`),
      '- regenerated agent configs (crew adapters build)',
      '',
      'This PR changes protected files (AGENTS.md, .github/, agents/), so crew-guard fails it on purpose: a human reviews and merges it.',
      'Check the diff of updated and deleted files: local customizations of AGENTS.md, workflows or roles are replaced by the package versions — re-apply the ones you need.',
      'After merging: `crew github setup --apply` (labels, CREW_HARNESS variable)' + (plan.legacy ? '; delete the old variable: `gh variable delete HK_HARNESS`.' : '.'),
    ].join('\n');
    const pr = gh(['pr', 'create', '--base', base, '--head', branch, '--title', `chore: upgrade to agent-crew ${LOCAL_VERSION}`, '--body', body], { cwd: root, allowFail: true });
    return ok(`Upgrade PR: ${(pr.stdout || '').split('\n').pop() || '(gh pr create failed — open it by hand)'}`, {
      status: pr.code === 0 ? 'success' : 'warning',
      artifacts: { branch, version: LOCAL_VERSION, legacy: plan.legacy, changes: lines },
      next_actions: [
        'human: review and merge the PR (crew-guard rejects protected-file changes by design)',
        'after merge: crew github setup --apply' + (plan.legacy ? ' and gh variable delete HK_HARNESS' : ''),
        'everyone: update the local crew (npm i -g @gredescerber/agent-crew) and restart agent sessions',
      ],
    });
  },
};
