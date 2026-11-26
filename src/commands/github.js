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
export function planSetup({ repo, harness = DEFAULT_HARNESS, labels = [], branch = 'main', localChecks = false }) {
  // localChecks: GitHub Actions do not run, so `check` and crew-guard come from crew tick on a team machine (a person's
  // token). -1 = any source. The cost: anyone with push access could set these statuses by hand. Off again by default.
  const source = localChecks ? -1 : ACTIONS_APP_ID;
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
      summary: `protection for ${branch}: PRs only, green ${REQUIRED_CHECKS.join(' and ')} (crew-guard counts the agent review)${localChecks ? ' from any source (crew tick on a team machine)' : ' from GitHub Actions'}, no force-push`,
      method: 'PUT',
      path: `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
      body: {
        // strict: false — do not require a rebase onto fresh main before every merge (there are many PRs at a hackathon)
        required_status_checks: { strict: false, checks: REQUIRED_CHECKS.map((context) => ({ context, app_id: source })) },
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

/**
 * Keep what an existing repo already enforces on the branch (pure). PUT replaces the whole protection, so without this
 * a pilot in a live repo would drop its own required checks and reviews. Rules are only added or made stricter:
 * required checks are the union, review counts take the maximum, flags stay on if they were on.
 * existing: GET .../protection (or null). → { body, kept: [what was kept], warnings }
 */
export function mergeProtection(body, existing) {
  if (!existing || typeof existing !== 'object') return { body, kept: [], warnings: [], blockers: [] };
  const kept = [];
  const warnings = [];
  const blockers = [];
  const out = structuredClone(body);
  const logins = (x) => ({ users: (x?.users ?? []).map((u) => u.login), teams: (x?.teams ?? []).map((t) => t.slug), apps: (x?.apps ?? []).map((a) => a.slug) });
  const rsc = existing.required_status_checks;
  if (rsc) {
    const ours = new Map(out.required_status_checks.checks.map((c) => [c.context, c]));
    const theirs = rsc.checks?.length ? rsc.checks : (rsc.contexts ?? []).map((context) => ({ context, app_id: null }));
    for (const c of theirs) {
      // a check with no fixed source stays open to any source (-1); one bound to an app stays bound to it
      const app = Number.isInteger(c.app_id) && c.app_id > 0 ? c.app_id : -1;
      const mine = ours.get(c.context);
      if (mine) {
        // crew's own source wins for crew's own checks: Actions by default, any source with --local_checks
        if (app !== -1 && mine.app_id !== -1 && app !== mine.app_id) blockers.push(`the required check "${c.context}" on main comes from another app (id ${app}); crew needs its own "${c.context}" from GitHub Actions: rename one of them first`);
        continue;
      }
      out.required_status_checks.checks.push({ context: c.context, app_id: app });
      ours.set(c.context, c);
      kept.push(`required check ${c.context}`);
    }
    if (rsc.strict) { out.required_status_checks.strict = true; kept.push('branches must be up to date before merging'); }
  }
  const rv = existing.required_pull_request_reviews;
  if (rv) {
    const want = out.required_pull_request_reviews;
    if ((rv.required_approving_review_count ?? 0) > want.required_approving_review_count) {
      want.required_approving_review_count = rv.required_approving_review_count;
      kept.push(`${rv.required_approving_review_count} approving review(s) from a person`);
    }
    for (const k of ['require_code_owner_reviews', 'dismiss_stale_reviews', 'require_last_push_approval']) {
      if (rv[k]) { want[k] = true; kept.push(k.replaceAll('_', ' ')); }
    }
    if (rv.dismissal_restrictions) { want.dismissal_restrictions = logins(rv.dismissal_restrictions); kept.push('who may dismiss reviews'); }
    if (rv.bypass_pull_request_allowances) { want.bypass_pull_request_allowances = logins(rv.bypass_pull_request_allowances); kept.push('who may bypass pull requests'); }
  }
  if (existing.enforce_admins?.enabled) { out.enforce_admins = true; kept.push('rules apply to admins too'); }
  if (existing.required_conversation_resolution?.enabled) { out.required_conversation_resolution = true; kept.push('conversations resolved before merging'); }
  if (existing.required_linear_history?.enabled) {
    // GitHub needs squash or rebase allowed for linear history, and crew turns both off: the two cannot be set together
    blockers.push('main requires linear history, but crew merges with merge commits (squash and rebase lose the Agent trailers crew-guard reads): turn "Require linear history" off first, or do not use crew on this repo');
  }
  // restrictions present, even with empty lists (only admins push), are kept as they are
  if (existing.restrictions) { out.restrictions = logins(existing.restrictions); kept.push('who may push'); }
  return { body: out, kept, warnings, blockers };
}

/**
 * The current protection of the branch. → { state: none | present | unavailable | unknown, data, error }.
 * unknown (a timeout, a 5xx, no right to read it) is not "none": overwriting it could drop rules we never saw.
 */
export function currentProtection(repo, branch, cwd, sh) {
  const r = sh('gh', ['api', `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`], { cwd, allowFail: true });
  const said = `${r.stderr ?? ''}\n${r.stdout ?? ''}`;
  if (r.code !== 0) {
    if (/Branch not protected/i.test(said) || (/HTTP 404/.test(said) && !/Branch not found/i.test(said))) return { state: 'none', data: null };
    if (/Upgrade to GitHub Pro|make this repository public/i.test(said)) return { state: 'unavailable', data: null };
    return { state: 'unknown', data: null, error: said.trim().split('\n')[0] || 'gh failed' };
  }
  try {
    const data = JSON.parse(r.stdout || 'null');
    return data ? { state: 'present', data } : { state: 'none', data: null };
  } catch { return { state: 'unknown', data: null, error: 'gh returned something that is not JSON' }; }
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
    { name: 'no_protection', type: 'boolean', description: 'do not touch the protection of the branch (a private repo on the free plan cannot have one)' },
    { name: 'local_checks', type: 'boolean', description: 'GitHub Actions do not run here: count check and crew-guard from crew tick on a team machine (any source). Run setup again without it once Actions work' },
  ],
  // cwd and deps.run — for calls from crew up (project folder and a gh stub in tests); not passed from the CLI.
  run({ repo, harness = DEFAULT_HARNESS, branch = 'main', apply = false, cwd, no_protection = false, local_checks = false }, deps = {}) {
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
    const plan = planSetup({ repo: resolved ?? '<owner>/<name>', harness, labels, branch, localChecks: local_checks });
    // an existing repo keeps its own required checks and review rules: crew adds to them, never removes them
    let merged = { kept: [], warnings: [], blockers: [] };
    // read only when applying: the dry run makes no GitHub calls; --apply reads the rules first and keeps them
    const prot = resolved && apply ? currentProtection(resolved, branch, root, sh) : { state: 'none' };
    if (no_protection || prot.state === 'unavailable') {
      plan.pop();
      merged.warnings.push(no_protection ? `the protection of ${branch} is left as it is (--no_protection)` : `${branch} cannot be protected on this plan (a private repo on the free plan): PRs can merge without review or checks`);
    } else if (prot.state === 'unknown') {
      merged.blockers.push(`could not read the current protection of ${branch} (${prot.error}): not changing anything, so no rule of yours is lost; try again`);
    } else {
      merged = mergeProtection(plan.at(-1).body, prot.data);
      plan.at(-1).body = merged.body;
      if (merged.kept.length) plan.at(-1).summary += `; kept from the existing rules: ${merged.kept.join(', ')}`;
      if (local_checks) merged.warnings.push(`${branch} counts check and crew-guard from any source: keep crew tick running on a team machine, and run crew github setup --apply (without --local_checks) once GitHub Actions work again`);
    }

    if (!apply) {
      const summary = `Setup plan for ${resolved ?? '<owner>/<name>'}: ${plan.length} gh api calls (dry-run, nothing changed; --apply first reads the current protection of ${branch} and keeps its rules)`;
      const opts = {
        artifacts: { repo: resolved, apply: false, plan, kept: merged.kept, warnings: merged.warnings, blockers: merged.blockers },
        next_actions: [...merged.blockers, ...merged.warnings, resolved ? `crew github setup --repo ${resolved} --apply` : 'crew github setup --repo <owner>/<name> --apply'],
      };
      return resolved && !merged.warnings.length && !merged.blockers.length ? ok(summary, opts) : warn(summary + (resolved ? '' : ' — repo not determined, pass --repo'), opts);
    }

    if (sh('gh', ['auth', 'status'], { cwd: root, allowFail: true }).code !== 0) {
      return fail('gh_auth', 'gh is not authenticated', { retry: 'gh auth login', stop_when: 'no admin rights on the repo — ask the owner' });
    }
    // nothing is written while the branch rules cannot be merged safely
    if (merged.blockers.length) {
      return fail('protection_conflict', `Not changing ${resolved}: ${merged.blockers[0]}`, { cause_hint: merged.blockers.join(' | '), retry: `fix it, then crew github setup --repo ${resolved} --apply`, stop_when: 'a rule only a repo admin can change: tell them', artifacts: { repo: resolved, blockers: merged.blockers } });
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
    return (merged.warnings.length ? warn : ok)(`Repo ${resolved} configured: ${results.length} steps${merged.kept.length ? ` (kept ${merged.kept.length} existing rule(s))` : ''}`, {
      artifacts: { repo: resolved, results, kept: merged.kept, warnings: merged.warnings },
      next_actions: [...merged.warnings, 'crew status'],
    });
  },
};
