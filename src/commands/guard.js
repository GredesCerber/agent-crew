// crew guard --pr N [--report] — PR rules without manual approval (see src/core/guard.js).
// In CI it runs from the crew-guard workflow (pull_request_target / issue_comment): the guard config and code come
// from main, not from the PR branch, so a PR cannot weaken the check for itself.
// --report sets the crew-guard commit status on the PR head (a required check of main protection).
// An agent can run it without --report to understand why its PR is not merging.
import { ok, warn, fail } from '../core/output.js';
import { gh, ghJson, git } from '../core/exec.js';
import { loadConfig } from '../core/config.js';
import { evaluateGuard, pinnedVersion, linkedIssue, taskMarkers, GUARD_CONTEXT, PENDING_DIR } from '../core/guard.js';

/** PR files from the GitHub API (with status and previous_filename; gh pr view does not return them). */
function prFiles(pr, cwd) {
  const out = gh(['api', '--paginate', `repos/{owner}/{repo}/pulls/${pr}/files`, '--jq', '.[] | {filename, status, previous_filename, additions, deletions, changes}'], { cwd }).stdout;
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** PR commits without merge commits, including further API pages. PR code is not executed. */
export function prCommits(pr, cwd, fetch = gh) {
  const out = fetch(['api', '--paginate', `repos/{owner}/{repo}/pulls/${pr}/commits`, '--jq', '.[] | {sha, message: .commit.message, parents}'], { cwd }).stdout;
  // GitHub merge / Update branch commits need not have Agent; a regular commit titled Merge must.
  return out.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((c) => (c.parents ?? []).length <= 1).map(({ sha, message }) => {
    // Git distinguishes a real trailer from an Agent: line in the subject or plain text.
    const trailers = git(['interpret-trailers', '--parse'], { cwd, input: message }).stdout;
    const agent = /^Agent:[ \t]*(\S[^\r\n]*)$/im.exec(trailers)?.[1]?.trim() ?? null;
    return { sha, agent };
  });
}

/** Files tests/pending/<T>/ in the base commit (the task with code must move them). */
function pendingInBase(baseSha, taskId, cwd) {
  if (!baseSha || !taskId) return [];
  const dir = `${PENDING_DIR}${taskId}/`;
  const r = gh(['api', `repos/{owner}/{repo}/git/trees/${baseSha}?recursive=1`, '--jq', '.tree[] | select(.type == "blob") | .path'], { cwd, allowFail: true });
  return r.code === 0 ? r.stdout.split('\n').filter((p) => p.startsWith(dir)) : [];
}

function runUrl() {
  const { GITHUB_SERVER_URL: s, GITHUB_REPOSITORY: r, GITHUB_RUN_ID: id } = process.env;
  return s && r && id ? `${s}/${r}/actions/runs/${id}` : undefined;
}

export default {
  name: 'guard',
  summary: 'Check a PR against the crew rules (protected files, acceptance tests, agent review); --report sets the crew-guard status',
  args: [
    { name: 'pr', type: 'number', required: true, description: 'PR number' },
    { name: 'report', type: 'boolean', description: 'write the crew-guard commit status (done by CI)' },
  ],
  run({ pr, report = false }) {
    const { config, root } = loadConfig();
    const view = ghJson(['pr', 'view', String(pr), '--json', 'number,body,headRefOid,baseRefOid,labels,createdAt,comments,state,author'], { cwd: root });
    if (!view) return fail('pr_not_found', `PR #${pr} not found`, { retry: 'gh pr list', stop_when: 'PR is closed or belongs to another repo' });
    const files = prFiles(pr, root);
    const commits = prCommits(pr, root);
    const issueNo = linkedIssue(view.body);
    const issue = issueNo ? ghJson(['issue', 'view', String(issueNo), '--json', 'body,labels'], { cwd: root, allowFail: true }) : null;
    const risk = (view.labels ?? []).map((l) => l.name).find((n) => n.startsWith('risk:'))?.slice(5) ?? 'med';
    const tm = taskMarkers(issue?.body ?? '');
    const pendingFiles = tm.testsIssue ? pendingInBase(view.baseRefOid, tm.taskId, root) : [];

    const res = evaluateGuard({
      pendingFiles,
      files,
      commits,
      body: view.body,
      issueBody: issue?.body ?? '',
      // only members can label issues: a labelled issue is a team task, not an outsider's text
      issueTrusted: (issue?.labels ?? []).some((l) => /^(status|area):/.test(l.name)),
      prLogin: view.author?.login ?? null,
      requiredVersion: pinnedVersion(process.env.CREW_HARNESS ?? ''),
      comments: view.comments ?? [],
      headSha: view.headRefOid,
      risk,
      createdAt: view.createdAt,
      config,
    });

    if (report) {
      const args = ['api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${view.headRefOid}`, '-f', `state=${res.state}`, '-f', `context=${GUARD_CONTEXT}`, '-f', `description=${res.description}`];
      const url = runUrl();
      if (url) args.push('-f', `target_url=${url}`);
      gh(args, { cwd: root });
    }

    const artifacts = { pr, sha: view.headRefOid, state: res.state, risk, problems: res.problems, review: res.review, author: res.author, issue: res.issue, reported: report };
    if (res.state === 'failure') {
      return fail('guard_failed', `PR #${pr}: ${res.problems.map((p) => p.message).join('; ')}`, {
        cause_hint: res.problems[0].message,
        retry: res.problems.some((p) => p.rule === 'agent_trailer') ? 'tell the team captain about commits without Agent; make new commits via crew commit' : res.problems.some((p) => p.rule === 'changes_requested') ? 'apply the reviewer changes, crew check, crew commit, git push' : 'remove the forbidden changes from the PR, crew commit, git push',
        stop_when: res.problems.some((p) => p.rule === 'agent_trailer') ? 'agents do not rewrite git history — a human agrees on the fix' : 'cannot be done without changing the rules or other people tests → crew task status <id> blocked --note "need a task that changes acceptance"',
        artifacts,
      });
    }
    if (res.state === 'pending') {
      return warn(`PR #${pr}: ${res.description}`, {
        artifacts,
        next_actions: [`reviewer: skill crew-review → crew pr review ${pr} --verdict approve|changes --note "..."`],
      });
    }
    return ok(`PR #${pr}: ${res.description}`, {
      artifacts,
      next_actions: risk === 'high' ? ['integrator merges first: gh pr merge <n> --merge --delete-branch'] : ['auto-merge will merge the PR itself'],
    });
  },
};
