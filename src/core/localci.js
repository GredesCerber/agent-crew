// Local CI: when GitHub Actions do not run, `crew tick` runs the `check` job on this machine and posts its result as
// the `check` commit status. The job is the same as crew.yml's: a clean checkout of the PR head, crew.config.json from
// the base commit (an agent cannot go green by editing the check list), product dependencies, then crew check.
// Main protection counts such a status only after `crew github setup --local_checks --apply` (any source, not just
// GitHub Actions). Only same-repo PRs run: a fork's code never runs on a team member's machine.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, runShell } from './exec.js';

export const CHECK_CONTEXT = 'check';

/** Does this PR still need a local `check` run? Not a draft, not from a fork, and no check result on its head yet. */
export function needsLocalCheck(pr) {
  if (!pr || pr.isDraft || pr.isCrossRepository || !pr.headRefOid) return false;
  // any entry (a pending run here or on another machine, or a finished result) means it is taken care of
  return !(pr.statusCheckRollup ?? []).some((c) => (c.name ?? c.context) === CHECK_CONTEXT);
}

/** The setup steps crew.yml runs before crew check: product dependencies in web/ and api/. */
export function installSteps(dir, exists = existsSync) {
  const out = [];
  for (const d of ['web', 'api']) {
    if (exists(join(dir, d, 'package-lock.json'))) out.push({ cwd: d, run: 'npm ci --no-audit --no-fund' });
    else if (exists(join(dir, d, 'package.json'))) out.push({ cwd: d, run: 'npm install --no-audit --no-fund' });
  }
  return out;
}

const short = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Post the `check` commit status with the caller's gh account. */
export const postStatus = (root) => (sha, state, description) => run('gh', [
  'api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${sha}`,
  '-f', `state=${state}`, '-f', `context=${CHECK_CONTEXT}`, '-f', `description=${description}`,
], { cwd: root, allowFail: true });

/**
 * Run the check job for one PR in a throwaway worktree and post the status. → { pr, sha, state, description }
 * deps: git(args) → { code, stdout }, sh(line, opts), check({ cwd }) → crew envelope, post(sha, state, text), tmp() → dir.
 */
export function checkPr(pr, root, deps) {
  const git = deps.git ?? ((args) => run('git', args, { cwd: root, allowFail: true }));
  const sh = deps.sh ?? runShell;
  const post = deps.post ?? postStatus(root);
  const sha = pr.headRefOid;
  const dir = (deps.tmp ?? (() => mkdtempSync(join(tmpdir(), `crew-check-${pr.number}-`))))();
  const result = (state, description) => {
    post(sha, state, short(description));
    return { pr: pr.number, sha, state, description };
  };
  post(sha, 'pending', 'crew tick: running crew check on a team machine');
  let added = false;
  try {
    if (git(['fetch', '--quiet', 'origin', `pull/${pr.number}/head`]).code !== 0) return result('error', 'crew tick could not fetch the PR head');
    if (git(['worktree', 'add', '--detach', '--force', dir, sha]).code !== 0) return result('error', 'crew tick could not check out the PR head');
    added = true;
    // as in crew.yml: the check list comes from the base commit, so a PR cannot make itself green by editing it
    const base = pr.baseRefOid ? git(['show', `${pr.baseRefOid}:crew.config.json`]) : { code: 1 };
    if (base.code === 0 && base.stdout) writeFileSync(join(dir, 'crew.config.json'), base.stdout + '\n');
    for (const s of installSteps(dir, deps.exists)) {
      const r = sh(s.run, { cwd: join(dir, s.cwd), timeout_s: 900 });
      if (r.code !== 0) return result('failure', `dependencies: ${s.cwd}: ${s.run} failed`);
    }
    let env;
    try { env = deps.check({ cwd: dir }); } catch (e) { env = { status: 'error', summary: String(e?.message ?? e) }; }
    if (env.status === 'error') return result('failure', `crew check: ${env.summary}`);
    return result('success', `crew check: ${env.summary}`);
  } catch (e) {
    return result('error', `crew tick: ${String(e?.message ?? e).split('\n')[0]}`);
  } finally {
    if (added) git(['worktree', 'remove', '--force', dir]);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a locked file on Windows: git worktree prune clears it later */ }
    git(['worktree', 'prune']);
  }
}

/** Every open PR that needs it gets a local check run, one at a time. → { status, summary, runs } */
export async function localChecks({ root = process.cwd(), prs, deps = {} } = {}) {
  const check = deps.check ?? (await import('../commands/check.js')).default.run;
  const list = prs ?? JSON.parse(run('gh', ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,headRefOid,baseRefOid,isDraft,isCrossRepository,statusCheckRollup'], { cwd: root }).stdout || '[]');
  const todo = list.filter(needsLocalCheck);
  const runs = todo.map((pr) => checkPr(pr, root, { ...deps, check }));
  const bad = runs.filter((r) => r.state !== 'success');
  return {
    status: bad.length ? 'warning' : 'success',
    summary: todo.length ? `checked ${todo.length} PR(s): ${runs.map((r) => `#${r.pr} ${r.state}`).join(', ')}` : 'no PR waits for a check',
    runs,
  };
}
