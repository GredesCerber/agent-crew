// crew shots before|after --url <page> [--name main] — screenshot for a task that changes how the product looks.
// "before" at the start of the task (base code running), "after" when done. crew pr open embeds both into the PR.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ok, fail } from '../core/output.js';
import { runShell, currentBranch } from '../core/exec.js';
import { loadConfig } from '../core/config.js';
import { issueFromBranch } from './pr.js';
import { PHASES, NAME_RE, safeUrl, shotPath, captureCommand } from '../core/shots.js';

export default {
  name: 'shots',
  summary: 'Take a before/after screenshot of a page for a task that changes the UI (Playwright); crew pr open shows them in the PR',
  usesCwd: true,
  args: [
    { name: 'phase', type: 'string', positional: true, required: true, enum: PHASES, description: 'before (at the start of the task) or after (when done)' },
    { name: 'url', type: 'string', required: true, description: 'page of the running app, e.g. http://localhost:5173/items' },
    { name: 'name', type: 'string', description: 'screen name: a-z, 0-9, dash (default main); one before/after pair per screen' },
    { name: 'width', type: 'number', description: 'viewport width (default 1280; use 390 for a phone)' },
    { name: 'height', type: 'number', description: 'viewport height (default 800)' },
  ],
  run({ phase, url, name = 'main', width = 1280, height = 800, cwd }, deps = {}) {
    const { root } = loadConfig(cwd);
    const id = issueFromBranch(currentBranch(root));
    if (!id) {
      return fail('not_task_branch', 'Screenshots belong to a task: run this in the task worktree (branch crew/<id>-...)', {
        retry: 'crew task claim <id>, then crew shots in the worktree',
      });
    }
    const safe = safeUrl(url);
    if (!safe) return fail('bad_input', `Not a plain http(s) URL: ${url}`, { retry: 'crew shots after --url http://localhost:5173/' });
    if (!NAME_RE.test(name)) return fail('bad_input', `Bad screen name "${name}": a-z, 0-9, dash`, { retry: 'crew shots after --name main --url ...' });
    const rel = shotPath(id, name, phase);
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const r = (deps.runShell ?? runShell)(captureCommand({ url: safe, file: rel, width, height }), { cwd: root, timeout_s: 180 });
    if (r.code !== 0 || !(deps.exists ?? existsSync)(abs)) {
      return fail('shot_failed', `Screenshot ${phase} of ${safe} failed`, {
        cause_hint: r.timedOut ? 'timed out after 180 s' : (r.stderr || r.stdout || '').split('\n').slice(-3).join(' | '),
        retry: 'start the app first (the page must open in a browser); first run downloads Playwright: npx playwright install chromium',
        stop_when: 'the app cannot run in this environment — say so in the PR instead of screenshots',
      });
    }
    return ok(`Screenshot saved: ${rel}`, {
      artifacts: { path: rel, phase, name, url: safe, issue: id },
      next_actions: phase === 'before'
        ? ['make the change, then: crew shots after --url ... --name ' + name]
        : ['crew commit -m "..." → crew check → crew pr open (the PR shows Before / After)'],
    });
  },
};
