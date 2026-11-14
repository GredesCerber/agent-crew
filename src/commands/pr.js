// crew pr open — hand in the work. Proceeds only with a green crew check on the current commit.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, fail } from '../core/output.js';
import { git, gh, ghJson, currentBranch } from '../core/exec.js';
import { loadConfig, agentId } from '../core/config.js';
import { viewIssue, setStatus, labelValue } from '../core/issues.js';
import { WAIVABLE, waiveMarker, authorAgent, reviewMarker, reviewPolicy, vendorOf } from '../core/guard.js';
import { checkLease, leaseLostError } from '../core/lease.js';
import { isFullRun } from './check.js';
import { safeText } from '../core/issues.js';
import { REQUIRED_CHECKS } from './github.js';
import { uiFiles, listShots, shotsSection } from '../core/shots.js';
import { LOCAL_VERSION, compareVersions } from '../core/version.js';

/**
 * Whether main has protection that waits for BOTH check AND crew-guard (without them GitHub auto-merge merges the PR immediately, skipping review).
 * Names come from REQUIRED_CHECKS. Any API error, a foreign set of checks or a malformed structure — no.
 */
export function mainProtected(root, sh = (args) => gh(args, { cwd: root, allowFail: true })) {
  const r = sh(['api', 'repos/{owner}/{repo}/branches/main/protection']);
  if (r.code !== 0) return false;
  try {
    const rsc = JSON.parse(r.stdout || '{}').required_status_checks;
    if (!rsc || typeof rsc !== 'object') return false;
    const names = new Set();
    if (Array.isArray(rsc.contexts)) for (const c of rsc.contexts) if (typeof c === 'string') names.add(c);
    if (Array.isArray(rsc.checks)) for (const c of rsc.checks) if (typeof c?.context === 'string') names.add(c.context);
    return REQUIRED_CHECKS.every((n) => names.has(n));
  } catch {
    return false;
  }
}

/**
 * Files that would conflict when merging origin/main into HEAD (git merge-tree, the working tree is untouched).
 * Empty when there are no conflicts or git cannot tell (old git, no origin/main): then CI and crew-guard decide.
 */
export function mainConflicts(root, sh = (args) => git(args, { cwd: root, allowFail: true })) {
  sh(['fetch', '--quiet', 'origin', 'main']);
  const r = sh(['merge-tree', '--write-tree', '--name-only', '--no-messages', 'origin/main', 'HEAD']);
  if (r.code !== 1) return [];
  return r.stdout.split('\n').slice(1).map((s) => s.trim()).filter(Boolean);
}

export function issueFromBranch(branch) {
  return Number(/^(?:crew|hk)\/(\d+)-/.exec(branch)?.[1]) || null;
}

/**
 * Merge policy by task risk (continuous merge instead of integration windows).
 * low/med → GitHub auto-merge: the PR merges itself once the required checks and review pass.
 * high → no auto-merge: the integrator merges manually and FIRST (this is the foundation: auth, data, demo path).
 * A regular merge (--merge), not squash: otherwise the Agent/Issue trailers are lost, and compliance depends on them.
 */
export function mergePolicy(risk = 'med', { draft = false } = {}) {
  const r = ['low', 'med', 'high'].includes(risk) ? risk : 'med';
  if (draft) return { risk: r, auto: false, note: 'draft — auto-merge is not enabled' };
  if (r === 'high') return { risk: r, auto: false, note: 'risk:high — the integrator merges manually, first' };
  return { risk: r, auto: true, args: ['--auto', '--merge', '--delete-branch'], note: 'auto-merge after green checks and review' };
}

/**
 * crew pr review <n> --verdict approve|changes — the reviewer agent verdict.
 * Writes a PR comment with a crew:review marker for the current commit; the crew-guard workflow
 * recomputes the status itself. A new push to the PR resets approvals (the new commit needs a review).
 */
export const prReview = {
  name: 'pr review',
  summary: 'PR review verdict (approve / changes) — counted by the crew-guard check',
  args: [
    { name: 'pr', type: 'number', positional: true, required: true, description: 'PR number' },
    { name: 'verdict', type: 'string', required: true, enum: ['approve', 'changes'], description: 'approve — OK to merge; changes — fixes needed' },
    { name: 'note', type: 'string', description: 'summary of the crew-review checklist; for changes — the specific fixes (required)' },
  ],
  run({ pr, verdict, note }) {
    const { config, root } = loadConfig();
    const me = agentId();
    if (verdict === 'changes' && !note) {
      return fail('bad_input', 'changes requires --note with the specific fixes', { retry: `crew pr review ${pr} --verdict changes --note "1) ... 2) ..."` });
    }
    const view = ghJson(['pr', 'view', String(pr), '--json', 'number,body,headRefOid,state,url'], { cwd: root });
    if (!view || view.state !== 'OPEN') {
      return fail('pr_not_open', `PR #${pr} is not open`, { retry: 'gh pr list', stop_when: 'PR is already merged or closed' });
    }
    const author = authorAgent(view.body);
    if (author && author === me) {
      return fail('self_review', `You wrote PR #${pr} yourself (${me}) — a review of your own work does not count`, {
        retry: 'crew task next or review someone else PR',
        stop_when: 'there are no other PRs to review',
      });
    }
    const policy = reviewPolicy(config);
    const sameVendor = !!author && vendorOf(author) === vendorOf(me);
    const sha = view.headRefOid;
    const head = verdict === 'approve' ? `✅ **Review by ${me}: OK to merge**` : `❌ **Review by ${me}: changes needed**`;
    const body = [reviewMarker({ verdict, agent: me, sha }), `${head} (commit ${sha.slice(0, 7)})`, '', safeText(note ?? '')].join('\n').trim() + '\n';
    gh(['pr', 'comment', String(pr), '--body', body], { cwd: root });
    const notCounted = policy.require === 'other-vendor' && sameVendor;
    return ok(`Review of PR #${pr} recorded: ${verdict}${notCounted ? ` (same vendor as the author — counts only if no reviewer from another vendor appears within ${policy.fallback_minutes} min)` : ''}`, {
      status: notCounted ? 'warning' : 'success',
      artifacts: { pr, verdict, agent: me, sha, author, counted_now: !notCounted },
      next_actions: verdict === 'approve' ? [`crew guard --pr ${pr} (status)`, 'crew task next'] : ['the author applies the fixes and pushes; then a new review is needed', 'crew task next'],
    });
  },
};

export const prOpen = {
  name: 'pr open',
  summary: 'Open a PR for the current task (only after a green crew check)',
  usesCwd: true,
  args: [{ name: 'draft', type: 'boolean', description: 'draft PR' }],
  run({ draft, cwd }) {
    const { root } = loadConfig(cwd);
    const branch = currentBranch(root);
    const id = issueFromBranch(branch);
    if (!id) {
      return fail('not_task_branch', `Branch ${branch} does not look like crew/<number>-...`, {
        cause_hint: 'work must start from a claimed task',
        retry: 'crew task next → crew task claim <id>',
      });
    }
    if (git(['status', '--porcelain'], { cwd: root }).stdout) {
      return fail('dirty_tree', 'There are uncommitted changes', { retry: 'crew commit -m "..." and run crew check again' });
    }
    const lcPath = join(root, '.crew', 'last-check.json');
    const sha = git(['rev-parse', 'HEAD'], { cwd: root }).stdout;
    const lc = existsSync(lcPath) ? JSON.parse(readFileSync(lcPath, 'utf8')) : null;
    const { config: cfg } = loadConfig(cwd);
    // Compared against the FULL list of config steps: a partial run (--only) or an old config does not count.
    const full = lc && isFullRun(lc.results ?? [], cfg.check ?? []);
    if (!lc || !lc.green || lc.partial || !full || lc.sha !== sha || lc.dirty) {
      return fail('check_required', 'No green full crew check for the current commit', {
        cause_hint: !lc ? 'crew check has not been run yet'
          : lc.partial ? 'the last run was partial (--only)'
          : !lc.green || !full ? 'the last check was red or did not run all crew.config.json steps'
          : 'there were changes after the check',
        retry: 'crew check',
      });
    }
    const issue = viewIssue(id);
    const agent = agentId();
    const vendor = vendorOf(agent);
    // Is the task still mine? Otherwise (the lease was taken away, someone else claimed it) — two PRs for one task.
    const lease = checkLease({ id, me: agent, view: () => issue });
    if (lease.state === 'lost') return leaseLostError(fail, id, lease, agent);
    // An outdated local crew opened PRs that bypassed review at the hackathon: refuse when the repo pins a newer one.
    const required = /@(\d+\.\d+\.\d+)\s*$|#v(\d+\.\d+\.\d+)\s*$/.exec(gh(['variable', 'get', 'CREW_HARNESS'], { cwd: root, allowFail: true }).stdout ?? '');
    const requiredVersion = required?.[1] ?? required?.[2];
    if (requiredVersion && compareVersions(LOCAL_VERSION, requiredVersion) === -1) {
      return fail('outdated_crew', `This repo uses agent-crew ${requiredVersion}, your crew is ${LOCAL_VERSION}`, {
        cause_hint: 'fixes and rules of the newer version would not apply to your PR',
        retry: `tell the human: npm i -g @gredescerber/agent-crew@${requiredVersion}, restart the agent session, then crew pr open`,
        stop_when: 'you cannot update — ask the human',
      });
    }
    // A PR that conflicts with main sits silently (CI does not even start). Shared files (translations, contracts)
    // conflicted all the time at the hackathon: catch it here, before pushing, with the exact files.
    const conflicts = mainConflicts(root);
    if (conflicts.length) {
      return fail('conflicts_with_main', `The branch conflicts with main in ${conflicts.length} file(s): ${conflicts.slice(0, 5).join(', ')}`, {
        cause_hint: 'someone merged changes to the same lines; shared append-only files (translations, lists) conflict most often',
        retry: 'git merge origin/main → resolve the conflicts (keep both sides where they just add) → crew commit -m "merge main" → crew check → crew pr open',
        stop_when: 'you cannot tell which side is right — crew ask <area of the file> --text "..."',
        artifacts: { conflicts },
      });
    }

    // A PR for this branch is already open (rework after review) — we only push and do not create a second PR.
    const existing = ghJson(['pr', 'view', branch, '--json', 'url,state,number'], { cwd: root, allowFail: true });
    git(['push', '-u', 'origin', branch], { cwd: root });
    if (existing?.state === 'OPEN') {
      setStatus(id, 'review', { from: ['claimed', 'blocked'] });
      return ok(`PR updated: ${existing.url} (commit ${sha.slice(0, 7)}) — a new review of this commit is needed`, {
        artifacts: { pr: existing.url, issue: id, branch, updated: true, sha },
        next_actions: [`reviewer: crew pr review ${existing.number} --verdict approve|changes (old approvals do not apply to the new commit)`, 'crew task next'],
      });
    }
    const body = [
      `Closes #${id}`,
      '',
      `**Agent:** \`${agent}\``,
      '',
      '## What was done',
      '_(the agent fills this in: 2–5 bullets)_',
      '',
      '## Checks',
      `- [x] crew check green on ${sha.slice(0, 7)} (${lc.results.map((r) => r.name).join(', ')})`,
      '',
      '## Review checklist (filled in by a reviewer from another vendor)',
      '- [ ] No behavioural regressions / demo path not broken',
      '- [ ] Security assumptions (secrets, auth, input, prompt injection)',
      '- [ ] Data integrity and conformance to contracts/',
      '- [ ] Error handling (no swallowed exceptions, fallbacks exist)',
      '- [ ] Rollout safety (rollback possible, does not break main)',
    ].join('\n');
    // Visual change: show the human and the reviewer what it looked like before and after (crew shots).
    const changed = git(['diff', '--name-only', 'origin/main...HEAD'], { cwd: root, allowFail: true }).stdout.split('\n').filter(Boolean);
    const ui = uiFiles(changed);
    const shots = listShots(root, id);
    const repoSlug = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(git(['remote', 'get-url', 'origin'], { cwd: root, allowFail: true }).stdout)?.[1];
    const visual = repoSlug ? shotsSection({ repo: repoSlug, sha, shots }) : '';
    const fullBody = visual ? `${body}\n\n${visual}` : body;
    const noShots = ui.length > 0 && !Object.keys(shots).length;
    const args = ['pr', 'create', '--head', branch, '--title', `${issue.title} (#${id})`, '--body', fullBody];
    if (draft) args.push('--draft');
    const url = gh(args, { cwd: root }).stdout.split('\n').pop();
    const policy = mergePolicy(labelValue(issue, 'risk') ?? 'med', { draft });
    gh(['pr', 'edit', url, '--add-label', `agent:${vendor}`, '--add-label', `risk:${policy.risk}`], { cwd: root, allowFail: true });
    setStatus(id, 'review', { from: ['claimed'] });
    let merge = policy.note;
    let status = 'success';
    // A private repo on the free plan: there is no main protection, and GitHub "auto-merge" merges the PR immediately, without review or crew-guard
    //. So we do not enable auto-merge: crew task next will hand out the merge after a green crew-guard.
    const guarded = policy.auto ? mainProtected(root) : true;
    if (policy.auto && !guarded) {
      status = 'warning';
      merge = 'main is not protected (private repo on the free plan) — auto-merge not enabled; the agent that crew task next hands the merge to will merge after review';
    } else if (policy.auto) {
      const r = gh(['pr', 'merge', url, ...policy.args], { cwd: root, allowFail: true });
      if (r.code !== 0) {
        // Without main protection GitHub auto-merge is unavailable. We do NOT merge directly — review is mandatory.
        status = 'warning';
        merge = `auto-merge did not enable: ${(r.stderr || r.stdout).split('\n')[0]}`;
      }
    }
    const { config } = loadConfig(cwd);
    const rp = reviewPolicy(config);
    const need = policy.risk === 'high' ? rp.approvals_high : rp.approvals;
    const who = rp.require === 'other-vendor' ? `an agent from another vendor (not ${vendor})` : `another agent (not ${agent})`;
    return ok(`PR opened: ${url} (${merge})`, {
      status,
      artifacts: { pr: url, issue: id, branch, risk: policy.risk, auto_merge: policy.auto && status === 'success', reviews_needed: need },
      next_actions: [
        `review: ${who}, approvals needed — ${need}${policy.risk === 'high' ? ' (one of them is a security review)' : ''}: skill crew-review → crew pr review <n> --verdict approve|changes`,
        ...(noShots ? [`UI files changed (${ui.slice(0, 3).join(', ')}${ui.length > 3 ? ', …' : ''}) but there are no before/after screenshots: crew shots after --url <page>, crew commit, crew pr open (and next time crew shots before at the start of the task)`] : []),
        ...(status === 'warning' ? ['do not merge yourself: crew task next hands out the merge (kind: merge) when review and crew-guard are green; for the human — main protection: a public repo or GitHub Pro, then crew github setup --apply'] : []),
        'crew task next',
      ],
    });
  },
};


/**
 * crew pr waive <n> --rule <r> --reason "..." — a human records why a paperwork rule does not apply to this commit
 * (a PR made outside crew: cloud session, plain git). crew-guard then ignores that rule for this head commit only.
 * Protected files, acceptance tests and the review can never be waived.
 */
export const prWaive = {
  name: 'pr waive',
  summary: 'Human: waive a paperwork rule of crew-guard (closes, agent_trailer, not_crew_pr) for the current commit, with a reason',
  agent: false,
  args: [
    { name: 'pr', type: 'number', positional: true, required: true, description: 'PR number' },
    { name: 'rule', type: 'string', required: true, enum: WAIVABLE, description: 'the crew-guard rule to waive' },
    { name: 'reason', type: 'string', required: true, description: 'why (kept in the PR for the record)' },
  ],
  run({ pr, rule, reason }) {
    const { root } = loadConfig();
    const view = ghJson(['pr', 'view', String(pr), '--json', 'headRefOid,state'], { cwd: root, allowFail: true });
    if (!view || view.state !== 'OPEN') return fail('pr_not_open', `PR #${pr} is not open`, { retry: 'gh pr list' });
    const sha = view.headRefOid.slice(0, 12);
    gh(['pr', 'comment', String(pr), '--body', `${waiveMarker({ rule, sha })}
**Waived \`${rule}\`** for commit ${sha.slice(0, 7)}: ${safeText(reason)}`], { cwd: root });
    return ok(`Rule ${rule} waived for PR #${pr} at ${sha.slice(0, 7)}`, {
      artifacts: { pr, rule, sha },
      next_actions: ['crew-guard recomputes on this comment; the PR still needs a review', `a new push needs a new waiver: crew pr waive ${pr} --rule ${rule} --reason "..."`],
    });
  },
};

export default [prOpen, prReview, prWaive];
