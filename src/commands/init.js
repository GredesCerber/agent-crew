// crew init <dir> [--stack web-fastapi] — create an empty product repo with all configs.
// Creates no product code: only rules, templates and checks (also compatible with event rules that forbid code written before the start).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ok, fail } from '../core/output.js';
import { git } from '../core/exec.js';
import { HARNESS_ROOT, DEFAULT_CONFIG } from '../core/config.js';
import { buildFiles } from './adapters.js';

export const STACKS_DIR = join(HARNESS_ROOT, 'templates', 'stacks');

export default {
  name: 'init',
  summary: 'Create a product repo: AGENTS.md, roles, skills, GitHub templates, CI, agent configs',
  agent: false,
  args: [
    { name: 'dir', type: 'string', positional: true, required: true, description: 'new project folder' },
    { name: 'stack', type: 'string', description: 'stack preset from templates/stacks (default web-fastapi)' },
    { name: 'hosts', type: 'string', description: 'hosts, comma-separated (default claude,codex)' },
    { name: 'force', type: 'boolean', description: 'write into a non-empty folder' },
    { name: 'solo', type: 'boolean', description: 'one person with one agent: no second-agent review, no discovery phase, one host (claude unless --hosts)' },
  ],
  async run({ dir, stack = 'web-fastapi', hosts, force, solo = false }) {
    const root = resolve(dir);
    if (existsSync(root) && readdirSync(root).length && !force) {
      return fail('dir_not_empty', `${root} is not empty`, { retry: `crew init ${dir} --force (if you really need to)` });
    }
    const stackPath = join(STACKS_DIR, `${stack}.json`);
    if (!existsSync(stackPath)) {
      const list = readdirSync(STACKS_DIR).map((f) => f.replace(/\.json$/, ''));
      return fail('unknown_stack', `No preset ${stack}`, { cause_hint: `available: ${list.join(', ')}`, retry: `crew init ${dir} --stack ${list[0]}` });
    }
    const preset = JSON.parse(readFileSync(stackPath, 'utf8'));
    mkdirSync(root, { recursive: true });

    // 1. Product template (AGENTS.md, .github, contracts/, events/, ...)
    // An existing README.md is the user's own: --force refreshes crew files, not their project description.
    const templateReadme = join(HARNESS_ROOT, 'templates', 'product', 'README.md');
    const keepReadme = existsSync(join(root, 'README.md'));
    cpSync(join(HARNESS_ROOT, 'templates', 'product'), root, { recursive: true, force: true, filter: (src) => !(keepReadme && resolve(src) === resolve(templateReadme)) });
    if (keepReadme) {
      // keep their text, add only the newcomer line (once) under the first heading
      const own = readFileSync(join(root, 'README.md'), 'utf8');
      const joinLine = readFileSync(templateReadme, 'utf8').split('\n').find((l) => l.startsWith('> **New on the team?**'));
      if (joinLine && !own.includes('**New on the team?**')) {
        const lines = own.split('\n');
        const at = lines[0]?.startsWith('#') ? 1 : 0;
        lines.splice(at, 0, ...(at ? ['', joinLine] : [joinLine, '']));
        writeFileSync(join(root, 'README.md'), lines.join('\n'));
      }
    }
    // 2. Vendor-neutral roles and skills → agents/ (source for adapters)
    cpSync(join(HARNESS_ROOT, 'roles'), join(root, 'agents', 'roles'), { recursive: true });
    cpSync(join(HARNESS_ROOT, 'skills'), join(root, 'agents', 'skills'), { recursive: true });
    // 3. Config
    const config = {
      ...DEFAULT_CONFIG,
      stack,
      areas: preset.areas ?? DEFAULT_CONFIG.areas,
      check: preset.check ?? [],
      scaffold: preset.scaffold ?? [],
      hosts: hosts ? hosts.split(',').map((h) => h.trim()) : solo ? ['claude'] : DEFAULT_CONFIG.hosts,
      // a new team project researches first: no product code until the plan (crew kickoff --apply switches to build).
      // Solo: one person decides alone, so no discovery gate and no second agent to review: CI checks and the
      // protected-file rules stay, a PR merges when they are green; risk:high still waits for the person to merge.
      phase: solo ? 'build' : 'discovery',
      ...(solo ? { solo: true, review: { ...DEFAULT_CONFIG.review, approvals: 0, approvals_high: 0 } } : {}),
      ecc: JSON.parse(readFileSync(join(HARNESS_ROOT, 'ecc', 'profile.json'), 'utf8')),
      mcp: JSON.parse(readFileSync(join(HARNESS_ROOT, 'templates', 'mcp.optional.json'), 'utf8')),
    };
    writeFileSync(join(root, 'crew.config.json'), JSON.stringify(config, null, 2) + '\n');
    // 4. Per-host configs; machine-specific ones go to .gitignore
    const { files } = await buildFiles(root, config);
    for (const f of files) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true });
      writeFileSync(join(root, f.path), f.content);
    }
    const local = [...new Set(files.filter((f) => !f.commit).map((f) => (f.path.includes('/skills/') ? f.path.split('/skills/')[0] + '/skills/' : f.path)))];
    const gi = ['# crew: local files', '.crew/', ...local, '', '# secrets', '.env', '.env.*', '!.env.example', '', 'node_modules/', '__pycache__/', '.venv/', 'dist/', ''];
    writeFileSync(join(root, '.gitignore'), gi.join('\n'));
    // 5. git
    if (!existsSync(join(root, '.git'))) git(['init', '-b', 'main'], { cwd: root });

    return ok(`Project created: ${root} (stack ${stack}, hosts ${config.hosts.join(', ')}${solo ? ', solo' : ''})`, {
      artifacts: { root, stack, hosts: config.hosts, files: files.length, solo, phase: config.phase },
      next_actions: solo ? [
        `cd ${dir}`,
        'git add -A && git commit -m "chore: crew init"',
        'gh repo create <you>/<name> --private --source . --push (or crew up for the whole setup)',
        'crew github setup --apply (main protection: CI must be green; no review by a second agent in solo)',
        'tasks: write issues with Given/When/Then criteria and crew task status <n> ready, or a PRD and crew kickoff; your agent: crew task next',
      ] : [
        `cd ${dir}`,
        'git add -A && git commit -m "chore: crew init"',
        'gh repo create <org>/<name> --private --source . --push',
        'crew github setup --apply (main protection, auto-merge, labels, CREW_HARNESS)',
        'optional event mode: fill in events/event.json (start time, team) and set "event" in crew.config.json',
        'paste the organizers brief into docs/brief.md as is → tell the agent: "analyze the brief with the crew-brief-analysis skill" → then crew-kickoff',
      ],
    });
  },
};
