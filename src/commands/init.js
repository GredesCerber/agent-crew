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
  ],
  async run({ dir, stack = 'web-fastapi', hosts, force }) {
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
    cpSync(join(HARNESS_ROOT, 'templates', 'product'), root, { recursive: true, force: true });
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
      hosts: hosts ? hosts.split(',').map((h) => h.trim()) : DEFAULT_CONFIG.hosts,
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

    return ok(`Project created: ${root} (stack ${stack}, hosts ${config.hosts.join(', ')})`, {
      artifacts: { root, stack, hosts: config.hosts, files: files.length },
      next_actions: [
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
