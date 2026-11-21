// What an agent should do next (pure functions, no network): merge a ready PR, review, take a task.
// Used by crew task next and crew status. Without it PRs hang without review
// and the whole queue waits behind the skeleton.
import { authorAgent, linkedIssue, reviewPolicy, reviewState, vendorOf } from './guard.js';
import { labelValue, tierAllows } from './issues.js';
import { sameAgent } from './session.js';

export const riskOfPr = (pr) => (pr.labels ?? []).map((l) => l.name ?? l).find((n) => n.startsWith('risk:'))?.slice(5) ?? 'med';
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * PR check summary from statusCheckRollup: { check, guard } -> 'success' | 'failure' | 'pending' | null.
 * Reruns of one check produce several entries: any success counts as success (the merge is still guarded by main protection).
 */
export function prChecks(pr) {
  const seen = { check: [], guard: [] };
  let guardText = '';
  for (const c of pr.statusCheckRollup ?? []) {
    const name = c.name ?? c.context;
    const key = name === 'check' ? 'check' : name === 'crew-guard' ? 'guard' : null;
    if (key) seen[key].push(String(c.conclusion || c.state || '').toUpperCase());
    if (key === 'guard' && c.description) guardText = c.description;
  }
  const sum = (xs) => {
    if (!xs.length) return null;
    if (xs.includes('SUCCESS')) return 'success';
    if (xs.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(s))) return 'failure';
    return 'pending';
  };
  return { check: sum(seen.check), guard: sum(seen.guard), ...(guardText ? { guardText } : {}) };
}

/**
 * PRs waiting for the team. -> [{ kind: 'merge'|'review', number, title, risk, age, reviewable, why_not }]
 * merge: risk:high, reviews collected, checks green: there is no auto-merge, someone must merge.
 * review: approval needed; reviewable is whether this particular agent can give it (and whether it will count).
 * reviewers: logins with the review area in crew-team; they review first, the others after fallback_minutes.
 */
export function prQueue(prs = [], { me, login, reviewers = [], config = {}, now = Date.now() } = {}) {
  const policy = reviewPolicy(config);
  const lc = (s) => String(s ?? '').toLowerCase();
  const isReviewer = !!login && reviewers.some((r) => lc(r) === lc(login));
  const out = [];
  for (const pr of prs) {
    if (pr.isDraft) continue;
    // PR from a fork (public repo): its text and diff are foreign, so we do not hand it to agents for review (prompt injection).
    if (pr.isCrossRepository) continue;
    const author = authorAgent(pr.body);
    // mine (exact name) decides who gets the fix; own (any session of the same agent) decides who may not review it
    const mine = !!author && author === me;
    const own = !!author && sameAgent(author, me);
    const risk = riskOfPr(pr);
    const need = risk === 'high' ? policy.approvals_high : policy.approvals;
    const rs = reviewState(pr.comments ?? [], { headSha: pr.headRefOid, author, prLogin: pr.author?.login ?? null, policy, prCreatedAt: pr.createdAt, now });
    const age = Math.max(0, Math.round((now - Date.parse(pr.createdAt ?? '')) / 60000)) || 0;
    const checks = prChecks(pr);
    const conflict = String(pr.mergeable ?? '').toUpperCase() === 'CONFLICTING';
    // PR is waiting for its author: reviewer requests changes, red check or conflict with main. The author fixes it before new tasks.
    // A red crew-guard means a rule is broken (protected files, acceptance tests, paperwork): only the author can fix it.
    const fixWhy = rs.changes.length ? `reviewer requests changes (${rs.changes.join(', ')})` : conflict ? 'conflict with main'
      : checks.check === 'failure' ? 'red check' : checks.guard === 'failure' ? `crew-guard: ${checks.guardText || `a rule is broken (crew guard --pr ${pr.number} shows which)`}` : null;
    if (fixWhy) {
      out.push({ kind: 'fix', number: pr.number, title: pr.title, issue: linkedIssue(pr.body), risk, age, mine, reason: fixWhy, reviewable: false });
      continue;
    }
    if (rs.approvals.length >= need) {
      // risk:high is merged manually; low/med if GitHub auto-merge did not turn on (no autoMergeRequest).
      const manual = risk === 'high' || ('autoMergeRequest' in pr && !pr.autoMergeRequest);
      // solo: nobody reviews, so a risk:high PR is the person's call: agents and merge-ready leave it alone (human: true)
      const human = !!config.solo && risk === 'high';
      if (manual && checks.check === 'success' && checks.guard === 'success') out.push({ kind: 'merge', number: pr.number, title: pr.title, risk, age, sha: pr.headRefOid, reviewable: false, ...(human ? { human } : {}) });
      // approved, checks still running (or auto-merge pending): nobody has to act, but humans should see it
      else if (checks.check !== 'success' || checks.guard !== 'success') out.push({ kind: 'checks', number: pr.number, title: pr.title, risk, age, reviewable: false });
      continue;
    }
    const sha7 = String(pr.headRefOid ?? '').slice(0, 7);
    const reviewedHead = !!sha7 && (pr.comments ?? []).some((c) => new RegExp(`<!-- (?:crew|hk):review [^>]*agent=${esc(me)} [^>]*sha=${esc(sha7)}`).test(c.body ?? ''));
    const counts = policy.require === 'other-agent' || rs.fallback || !author || vendorOf(author) !== vendorOf(me);
    const authorIsReviewer = reviewers.some((r) => lc(r) === lc(pr.author?.login));
    const turn = isReviewer || !reviewers.length || authorIsReviewer || age >= policy.fallback_minutes;
    const why_not = own ? 'own PR' : reviewedHead ? 'already reviewed this commit' : !counts ? 'needs a reviewer from another vendor' : !turn ? `the team reviewer goes first (${reviewers.join(', ')})` : null;
    out.push({ kind: 'review', number: pr.number, title: pr.title, risk, age, need, have: rs.approvals.length, reviewable: !why_not, why_not });
  }
  const rank = (x) => ({ fix: 0, merge: 10, review: 20, checks: 30 }[x.kind] ?? 40) + (x.risk === 'high' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.number - b.number);
}

/**
 * Ready tasks ordered "assigned to me -> nobody's -> in someone else's area" (assignment = area owner from crew-team).
 * -> [{ issue, owners, mine }]
 */
export function taskOrder(ready = [], { login, area, tier = 'high' } = {}) {
  const me = String(login ?? '').toLowerCase();
  return ready
    .filter((i) => !area || labelValue(i, 'area') === area)
    .filter((i) => tierAllows(tier, labelValue(i, 'tier')))
    .map((i) => {
      const owners = (i.assignees ?? []).map((a) => a.login);
      const mine = !!me && owners.some((o) => o.toLowerCase() === me);
      // priority:high / priority:low (set by a human, e.g. on crew board) order tasks inside each group
      const p = { high: 0, low: 2 }[labelValue(i, 'priority')] ?? 1;
      return { issue: i, owners, mine, rank: (mine ? 0 : owners.length ? 2 : 1) * 10 + p };
    })
    .sort((a, b) => a.rank - b.rank || a.issue.number - b.issue.number);
}
