// crew digest [--post] — team status without an LLM: what waits for a human, stale leases, PRs, open questions,
// idle members. --post keeps it in one pinned issue (label crew:digest); the sweep job runs it every 15 minutes,
// so nobody has to keep an agent session polling the repo.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, fail } from '../core/output.js';
import { gh, ghJson } from '../core/exec.js';
import { loadConfig } from '../core/config.js';
import { listIssues } from '../core/issues.js';
import { DEFAULT_PRD, parsePrd } from '../core/prd.js';
import { QUESTION_LABEL } from '../core/questions.js';
import { digestModel, renderDigest, DIGEST_LABEL, DIGEST_TITLE } from '../core/digest.js';

const PR_FIELDS = 'number,title,body,headRefOid,createdAt,isDraft,author,labels,comments,statusCheckRollup,mergeable,isCrossRepository,autoMergeRequest';

export const openQuestions = (root) =>
  ghJson(['issue', 'list', '--state', 'open', '--label', QUESTION_LABEL, '--limit', '100', '--json', 'number,title,body,labels,assignees,createdAt'], { cwd: root, allowFail: true }) ?? [];

/** The crew-team block of docs/prd.md in this checkout, or null. */
export function teamOf(root) {
  const p = join(root, DEFAULT_PRD);
  return existsSync(p) ? parsePrd(readFileSync(p, 'utf8')).team : null;
}

/** Live data through gh (tests pass deps.data instead). */
export function githubData(root) {
  return {
    issues: listIssues({ limit: 500 }),
    prs: ghJson(['pr', 'list', '--state', 'open', '--limit', '50', '--json', PR_FIELDS], { cwd: root, allowFail: true }) ?? [],
    questions: openQuestions(root),
    team: teamOf(root),
  };
}

/** Create the pinned digest issue once, then edit its body. -> { issue, created } | { error } */
export function postDigest(body, { root = '.', gh: ghf = gh, ghJson: ghj = ghJson } = {}) {
  const found = ghj(['issue', 'list', '--state', 'open', '--label', DIGEST_LABEL, '--limit', '1', '--json', 'number'], { cwd: root, allowFail: true }) ?? [];
  if (found[0]?.number) {
    const r = ghf(['issue', 'edit', String(found[0].number), '--body-file', '-'], { cwd: root, allowFail: true, input: body });
    return r.code === 0 ? { issue: found[0].number, created: false } : { error: (r.stderr || r.stdout || '').split('\n')[0] || 'issue edit failed' };
  }
  const r = ghf(['issue', 'create', '--title', DIGEST_TITLE, '--label', DIGEST_LABEL, '--body-file', '-'], { cwd: root, allowFail: true, input: body });
  const number = Number(/\/issues\/(\d+)/.exec(r.stdout ?? '')?.[1]);
  if (r.code !== 0 || !number) return { error: (r.stderr || r.stdout || '').split('\n')[0] || 'issue create failed' };
  ghf(['issue', 'pin', String(number)], { cwd: root, allowFail: true });
  return { issue: number, created: true };
}

export default {
  name: 'digest',
  summary: 'Team status without an LLM: needs-a-human, stale leases, PRs, open questions, idle members; --post updates the pinned issue',
  args: [{ name: 'post', type: 'boolean', description: 'create or update the pinned "crew digest" issue (the sweep job does this)' }],
  run({ post = false } = {}, deps = {}) {
    const { config, root } = deps.config ? { config: deps.config, root: '.' } : loadConfig();
    const data = deps.data ?? githubData(root);
    const now = deps.now ?? Date.now();
    const model = digestModel({ ...data, config, now });
    const markdown = renderDigest(model, { now });
    let posted = null;
    if (post) {
      posted = postDigest(markdown, { root, ...(deps.gh ? { gh: deps.gh } : {}), ...(deps.ghJson ? { ghJson: deps.ghJson } : {}) });
      if (posted.error) {
        return fail('gh_failed', 'Could not update the digest issue', { cause_hint: posted.error, retry: 'crew labels sync (the crew:digest label may be missing), then crew digest --post' });
      }
    }
    const c = model.counts;
    return ok(`${c.human} need a human, ${c.stale} stale, ${c.prs} PRs waiting, ${c.idle} idle${posted ? `; digest #${posted.issue}${posted.created ? ' created and pinned' : ' updated'}` : ''}`, {
      status: c.human || c.stale ? 'warning' : 'success',
      artifacts: { counts: c, sections: model.sections, markdown, issue: posted?.issue ?? null },
    });
  },
};
