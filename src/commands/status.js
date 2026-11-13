// crew status — overview for the captain: queue by status, who is doing what, what is stuck (blocked, PRs without review, PRs ready to merge).
import { ok } from '../core/output.js';
import { listIssues, labelValue } from '../core/issues.js';
import { loadConfig, agentId } from '../core/config.js';
import { ghJson } from '../core/exec.js';
import { prQueue } from '../core/queue.js';

/** PRs waiting on humans/agents: ready to merge and without review (pure function for tests). */
export function prLines(prs, { config, now = Date.now() } = {}) {
  // me/login are empty: we look through the captain view — whoever reviews, the PR is waiting.
  return prQueue(prs, { me: agentId(), login: null, reviewers: [], config, now }).map((x) =>
    x.kind === 'fix'
      ? `PR #${x.number} ${x.title} — waiting on the author: ${x.reason}${x.age > 30 ? ' ⚠' : ''}`
      : x.kind === 'merge'
        ? `PR #${x.number} ${x.title} — ready (${x.risk}): merge it (gh pr merge ${x.number} --merge --delete-branch)`
        : `PR #${x.number} ${x.title} — waiting for review ${x.age} min (${x.have}/${x.need})${x.age > 30 ? ' ⚠' : ''}`);
}

export default {
  name: 'status',
  summary: 'Overview: queue by status, who is doing what, what is stuck (blocked, PRs without review, PRs ready to merge)',
  args: [],
  run() {
    const { config, root } = loadConfig();
    const issues = listIssues();
    const by = {};
    for (const i of issues) (by[labelValue(i, 'status') ?? 'no-status'] ??= []).push(i);
    const counts = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length]));
    const now = Date.now();
    const who = (i) => i.assignees.map((a) => a.login).join(',') || '?';
    const working = (by.claimed ?? []).map((i) => {
      const age = Math.round((now - Date.parse(i.updatedAt)) / 60000);
      return `#${i.number} ${i.title} — ${who(i)}, ${age} min ago${age > config.lease_minutes ? ' ⚠ going stale' : ''}`;
    });
    const blocked = [...(by.blocked ?? []), ...(by['needs-spec'] ?? [])].map((i) => `#${i.number} ${i.title} (${labelValue(i, 'status')}, area ${labelValue(i, 'area') ?? '?'}, ${who(i)})`);
    const prs = ghJson(['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,body,headRefOid,createdAt,isDraft,author,labels,comments,statusCheckRollup,mergeable,isCrossRepository,autoMergeRequest'], { cwd: root, allowFail: true }) ?? [];
    const waiting_prs = prLines(prs, { config, now });
    const next_actions = [
      ...(blocked.length ? ['captain: triage the stuck ones — gh issue view <id>; answer and return to the queue: crew task release <id> --force --note "answer: ..."; or add a task to the PRD for the right area and run crew kickoff --apply'] : []),
      ...(waiting_prs.length ? ['PRs waiting: reviewer — crew task next (hands out review/merge first)'] : []),
      'crew task next',
    ];
    return ok(`Open tasks: ${issues.length} · ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ')}${waiting_prs.length ? ` · PRs waiting: ${waiting_prs.length}` : ''}`, {
      artifacts: { counts, working, blocked, waiting_prs },
      next_actions,
    });
  },
};
