// crew github setup [--repo owner/name] [--apply] — configure the product repo on GitHub with one command:
// main protection (PRs only + green check and crew-guard), auto-merge, the CREW_HARNESS variable, labels.
// There is no manual PR approval: an agent does the review (crew pr review) and crew-guard counts it.
// Dry-run by default: only shows the plan of `gh api` calls. Re-running is safe (idempotent).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, warn, fail } from '../core/output.js';
import { run } from '../core/exec.js';
import { loadConfig } from '../core/config.js';
import { allLabels } from './labels.js';
import { HARNESS_ROOT } from '../core/config.js';
import { GUARD_CONTEXT } from '../core/guard.js';

export const PKG = JSON.parse(readFileSync(join(HARNESS_ROOT, 'package.json'), 'utf8'));
/** The npm package with a pinned version: CI installs exactly this version (public registry, no token). */
export const HARNESS_REPO = 'GredesCerber/agent-crew';
export const DEFAULT_HARNESS = `${PKG.name}@${PKG.version}`;
// check — the name of the check run job from crew.yml (in branch protection — just "check").
// crew-guard — a commit status set by the crew-guard.yml workflow via GITHUB_TOKEN.
export const REQUIRED_CHECKS = ['check', GUARD_CONTEXT];
// GitHub App "GitHub Actions": a status with the same name set by a human or agent token will not count.
export const ACTIONS_APP_ID = 15368;

export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Pure function: the plan of `gh api` calls, with no network access.
 * Every step is idempotent: PUT/PATCH overwrite the state; if the object is missing (404) — `if_missing` (POST).
 */
export function planSetup({ repo, harness = DEFAULT_HARNESS, labels = [], branch = 'main' }) {
  const variable = { name: 'CREW_HARNESS', value: harness };
  return [
    {
      id: 'repo-settings',
      summary: 'repo settings: PR auto-merge (continuous merge for low/med), regular merge commit only (squash/rebase disabled — they lose trailers), delete branches after merge',
      method: 'PATCH',
      path: `repos/${repo}`,
      // squash and rebase are disabled: squash loses the Agent/Issue trailers and Closes #N, and compliance and crew-guard depend on them.
      body: { allow_auto_merge: true, allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false, delete_branch_on_merge: true },
    },
    {
      id: 'variable:CREW_HARNESS',
      summary: `variable CREW_HARNESS = ${harness} (CI installs it with npm install -g from the public GitHub repo at this tag)`,
      method: 'PATCH',
      path: `repos/${repo}/actions/variables/CREW_HARNESS`,
      body: variable,
      if_missing: { method: 'POST', path: `repos/${repo}/actions/variables`, body: variable },
    },
    ...labels.map((l) => ({
      id: `label:${l.name}`,
      summary: `label ${l.name}`,
      method: 'PATCH',
      path: `repos/${repo}/labels/${encodeURIComponent(l.name)}`,
      body: { new_name: l.name, color: l.color, description: l.description },
      if_missing: { method: 'POST', path: `repos/${repo}/labels`, body: { name: l.name, color: l.color, description: l.description } },
    })),
    {
      id: `branch-protection:${branch}`,
      summary: `protection for ${branch}: PRs only, green ${REQUIRED_CHECKS.join(' and ')} (crew-guard counts the agent review), no force-push`,
      method: 'PUT',
      path: `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
      body: {
        // strict: false — do not require a rebase onto fresh main before every merge (there are many PRs at a hackathon)
        required_status_checks: { strict: false, checks: REQUIRED_CHECKS.map((context) => ({ context, app_id: ACTIONS_APP_ID })) },
        // An admin (the harness developer) can merge bypassing this — that is how agent rules and CI are updated,
        // which crew-guard does not let agents change. Agents are forbidden from --admin in AGENTS.md.
        enforce_admins: false,
        required_pull_request_reviews: {
          // 0 manual approvals: the human is not an "approve button". The agent review is checked by crew-guard
          // (a crew:review marker from another agent on the current commit). Agents work under human
          // accounts, and GitHub does not allow approving your own PR — hence no native GitHub reviews.
          required_approving_review_count: 0,
          require_code_owner_reviews: false,
          dismiss_stale_reviews: false,
        },
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
      },
    },
  ];
}

const is404 = (r) => /HTTP 404|Not Found/i.test(r.stderr + r.stdout);

function call({ method, path, body }, cwd, sh = run) {
  return sh('gh', ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json', '--input', '-'], {
    cwd,
    input: JSON.stringify(body),
    allowFail: true,
  });
}

/** Execute the plan. Returns a result per step; does not stop at the first error. */
export function applyPlan(plan, cwd, sh = run) {
  return plan.map((step) => {
    let r = call(step, cwd, sh);
    let action = step.method;
    if (r.code !== 0 && step.if_missing && is404(r)) {
      r = call(step.if_missing, cwd, sh);
      action = step.if_missing.method;
    }
    return { id: step.id, ok: r.code === 0, action, error: r.code === 0 ? null : (r.stderr || r.stdout).split('\n')[0] };
  });
}

function detectRepo(cwd, sh = run) {
  const r = sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd, allowFail: true });
  return r.code === 0 && REPO_RE.test(r.stdout) ? r.stdout : null;
}

export default {
  name: 'github setup',
  summary: 'Configure the repo on GitHub: main protection, the CREW_HARNESS variable, labels (dry-run; --apply to execute)',
  agent: false,
  args: [
    { name: 'repo', type: 'string', description: 'owner/name (default — the current folder repo per gh repo view)' },
    { name: 'harness', type: 'string', description: `CREW_HARNESS value (default ${DEFAULT_HARNESS})` },
    { name: 'branch', type: 'string', description: 'branch to protect (default main)' },
    { name: 'apply', type: 'boolean', description: 'execute the plan (without the flag — only show it)' },
  ],
  // cwd and deps.run — for calls from crew up (project folder and a gh stub in tests); not passed from the CLI.
  run({ repo, harness = DEFAULT_HARNESS, branch = 'main', apply = false, cwd }, deps = {}) {
    const sh = deps.run ?? run;
    const { config, root } = loadConfig(cwd);
    if (repo !== undefined && !REPO_RE.test(String(repo))) {
      return fail('bad_input', `repo must be in the form owner/name, not "${repo}"`, { retry: 'crew github setup --repo <owner>/<name>' });
    }
    const resolved = repo ?? detectRepo(root, sh);
    if (!resolved && apply) {
      return fail('repo_unknown', 'Could not determine the GitHub repo', {
        cause_hint: 'the folder is not linked to a GitHub repo or gh is not authenticated',
        retry: 'crew github setup --repo <owner>/<name> --apply',
        stop_when: 'the repo has not been created yet — run gh repo create first',
      });
    }
    const labels = allLabels(config);
    const plan = planSetup({ repo: resolved ?? '<owner>/<name>', harness, labels, branch });

    if (!apply) {
      const summary = `Setup plan for ${resolved ?? '<owner>/<name>'}: ${plan.length} gh api calls (dry-run, nothing changed)`;
      const opts = {
        artifacts: { repo: resolved, apply: false, plan },
        next_actions: [resolved ? `crew github setup --repo ${resolved} --apply` : 'crew github setup --repo <owner>/<name> --apply'],
      };
      return resolved ? ok(summary, opts) : warn(summary + ' — repo not determined, pass --repo', opts);
    }

    if (sh('gh', ['auth', 'status'], { cwd: root, allowFail: true }).code !== 0) {
      return fail('gh_auth', 'gh is not authenticated', { retry: 'gh auth login', stop_when: 'no admin rights on the repo — ask the owner' });
    }
    const results = applyPlan(plan, root, sh);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      return fail('github_setup_failed', `Not applied: ${failed.length} of ${results.length}: ${failed.map((f) => f.id).join(', ')}`, {
        cause_hint: failed[0].error,
        retry: `crew github setup --repo ${resolved} --apply (re-running is safe)`,
        stop_when: 'HTTP 403 — no admin rights, or branch protection is unavailable on the plan for a private repo',
        artifacts: { repo: resolved, results },
      });
    }
    return ok(`Repo ${resolved} configured: ${results.length} steps`, {
      artifacts: { repo: resolved, results },
      next_actions: [
        'crew status',
      ],
    });
  },
};
