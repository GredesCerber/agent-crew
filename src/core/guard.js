// crew-guard: PR rules without a human "approve button". Pure functions, no network (tests run them).
//
// A human does not approve every PR. Instead, automatically:
//   1. Agents never change agent rules and CI (PROTECTED_PATHS): a PR touching them will not pass.
//      Only the harness developer changes them (harness update), merging past protection as admin.
//   2. Acceptance tests: new ones may be added; changing/deleting existing ones is allowed only if
//      the PR's task (Closes #N) explicitly lists those files in the "Changes acceptance" section.
//      Such a task is written by the planner/analyst (usually from human feedback), not by a builder.
//   3. Review is done by an agent: a crew:review marker from ANOTHER agent on the PR's current commit
//      (by default from another vendor; if there is none for longer than fallback_minutes, from any other agent).
//
// Limitation: agents work under human accounts, so this does not stop a deliberate agent forging a marker.
// The goal is to catch laziness and mistakes (weakened a test, "fixed" CI, approved itself).

import { isTrustedComment } from './issues.js';

/** Agent rules and CI files: agents do not change them. */
export const PROTECTED_PATHS = ['crew.config.json', '.github/', 'AGENTS.md', 'CLAUDE.md', 'agents/', 'events/'];
export const ACCEPTANCE_DIR = 'tests/acceptance/';
/** Tests from a tests task (tests_for), until a code task moves them. CI does not run them. */
export const PENDING_DIR = 'tests/pending/';

/** Rename tests/pending/... -> tests/acceptance/... without a single changed line. */
export function isPureMove(f = {}) {
  const changes = Number.isFinite(f.changes) ? f.changes : (f.additions ?? 0) + (f.deletions ?? 0);
  return (
    f.status === 'renamed' &&
    !!f.previous_filename &&
    norm(f.previous_filename).startsWith(PENDING_DIR) &&
    norm(f.filename).startsWith(ACCEPTANCE_DIR) &&
    (Number.isFinite(f.changes) || Number.isFinite(f.additions) || Number.isFinite(f.deletions)) &&
    changes === 0
  );
}

/** Markers of a task from the issue body: { taskId, testsFor, testsIssue }. */
export function taskMarkers(issueBody = '') {
  const pick = (kind, key) => new RegExp(`<!-- crew:${kind}\\b[^>]*?\\b${key}=(\\S+?)[\\s>]`).exec(issueBody ?? '')?.[1] ?? null;
  return { taskId: pick('task', 'id'), testsFor: pick('tests-for', 'task'), testsIssue: Number(pick('tests', 'issue')) || null };
}
export const ACCEPTANCE_SECTION = 'Changes acceptance';
export const REVIEW_MODES = ['other-vendor', 'other-agent'];
export const GUARD_CONTEXT = 'crew-guard';

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');

export function isProtected(path) {
  const p = norm(path);
  return PROTECTED_PATHS.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));
}

/** Review settings from crew.config.json -> review. Default: other-vendor when there is more than one host. */
export function reviewPolicy(config = {}) {
  const r = config.review ?? {};
  const multi = (config.hosts ?? []).length > 1;
  return {
    require: REVIEW_MODES.includes(r.require) ? r.require : multi ? 'other-vendor' : 'other-agent',
    approvals: Number.isInteger(r.approvals) && r.approvals >= 0 ? r.approvals : 1,
    approvals_high: Number.isInteger(r.approvals_high) && r.approvals_high >= 0 ? r.approvals_high : 1,
    fallback_minutes: Number.isFinite(r.fallback_minutes) && r.fallback_minutes >= 0 ? r.fallback_minutes : 30,
  };
}

/** Task number from the PR body (Closes/Fixes/Resolves #N). */
export function linkedIssue(body = '') {
  return Number(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)/i.exec(body ?? '')?.[1]) || null;
}

/** Author agent from the PR body (crew pr open writes **Agent:** `codex/x`). */
export function authorAgent(body = '') {
  return /\*\*Agent:\*\*\s*`([^`]+)`/.exec(body ?? '')?.[1] ?? null;
}

/** Vendor from an agent id: claude/opus@petya -> claude. */
export const vendorOf = (agent) => String(agent ?? '').split(/[/@]/)[0] || null;

/**
 * Which existing acceptance tests the task allows changing: the "Changes acceptance" section of the issue body.
 * Lines with paths inside tests/acceptance/; `dir/**` means the whole folder. Everything else is ignored.
 */
export function allowedAcceptanceChanges(issueBody = '') {
  const lines = String(issueBody ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,4}\s+/.test(l) && l.replace(/^#+\s+/, '').trim() === ACCEPTANCE_SECTION);
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,4}\s+/.test(l)) break;
    for (const m of l.matchAll(/(?:^|[\s`,(])((?:\.\/)?tests\/acceptance\/[^\s`,)]+)/g)) out.push(norm(m[1]));
  }
  return [...new Set(out)];
}

const covered = (path, allowed) =>
  allowed.some((a) => (a.endsWith('/**') ? path.startsWith(a.slice(0, -2)) : a.endsWith('/') ? path.startsWith(a) : path === a));

/**
 * Changed PR files (as in GitHub API pulls/N/files: filename, status, previous_filename)
 * -> violations of protected paths and acceptance tests.
 */
export function fileViolations(files = [], { allowedAcceptance = [] } = {}) {
  const protectedHits = [];
  const acceptanceHits = [];
  for (const f of files) {
    const paths = [f.filename, f.previous_filename].filter(Boolean).map(norm);
    if (paths.some(isProtected)) protectedHits.push(norm(f.filename));
    // Moving tests written by another agent from tests/pending/ to tests/acceptance/ unchanged is allowed.
    if (isPureMove(f)) continue;
    // tests/pending/ (tests from a tests task) are frozen the same way as tests/acceptance/.
    const prevPending = f.previous_filename && norm(f.previous_filename).startsWith(PENDING_DIR);
    if ((f.status !== 'added' && norm(f.filename).startsWith(PENDING_DIR)) || prevPending) {
      acceptanceHits.push(norm(f.previous_filename ?? f.filename));
      continue;
    }
    // new files in tests/acceptance are allowed; changing/deleting/renaming an existing one only by task
    const touchesExisting =
      (f.status !== 'added' && norm(f.filename).startsWith(ACCEPTANCE_DIR)) ||
      (f.previous_filename && norm(f.previous_filename).startsWith(ACCEPTANCE_DIR));
    if (touchesExisting) {
      const target = norm(f.previous_filename ?? f.filename);
      if (!covered(target, allowedAcceptance)) acceptanceHits.push(target);
    }
  }
  return { protectedHits: [...new Set(protectedHits)], acceptanceHits: [...new Set(acceptanceHits)] };
}

/**
 * Review markers: <!-- crew:review verdict=approve|changes agent=<id> sha=<commit> -->.
 * The last verdict of each agent is taken; only verdicts on the current head count.
 */
export function reviewState(comments = [], { headSha, author, policy, prCreatedAt, now = Date.now() }) {
  const latest = new Map();
  for (const c of comments) {
    // in a public repo anyone can comment: review markers only count from repo members
    if (!isTrustedComment(c)) continue;
    for (const m of String(c.body ?? '').matchAll(/<!-- crew:review((?: \w+=\S+)*) -->/g)) {
      const f = Object.fromEntries([...m[1].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
      if (!f.agent || !f.verdict || !f.sha) continue;
      latest.set(f.agent, { agent: f.agent, verdict: f.verdict, sha: f.sha, at: c.createdAt });
    }
  }
  const onHead = [...latest.values()].filter((r) => headSha && r.sha.length >= 7 && headSha.startsWith(r.sha));
  const notAuthor = onHead.filter((r) => r.agent !== author);
  const otherVendor = notAuthor.filter((r) => vendorOf(r.agent) !== vendorOf(author));
  const created = Date.parse(prCreatedAt ?? '');
  const fallback = policy.require === 'other-vendor' && Number.isFinite(created) && now - created > policy.fallback_minutes * 60_000;
  const eligible = policy.require === 'other-agent' || fallback ? notAuthor : otherVendor;
  return {
    approvals: eligible.filter((r) => r.verdict === 'approve').map((r) => r.agent),
    changes: eligible.filter((r) => r.verdict === 'changes').map((r) => r.agent),
    stale: [...latest.values()].filter((r) => !onHead.includes(r)).map((r) => r.agent),
    self: onHead.some((r) => r.agent === author),
    fallback,
  };
}

/**
 * PR summary -> { state: success|pending|failure, description (<=140 chars for the status), problems[] }.
 * failure: a rule is violated (the agent must redo it); pending: all fine, waiting for an agent review.
 */
export function evaluateGuard({ files = [], body = '', issueBody = '', comments = [], commits = [], headSha, risk = 'med', createdAt, config = {}, now = Date.now(), pendingFiles = [] }) {
  const problems = [];
  const issue = linkedIssue(body);
  if (!issue) problems.push({ rule: 'closes', message: 'the PR description has no "Closes #N": a PR must close a task' });

  const noAgent = commits.filter((c) => !String(c.agent ?? '').trim()).map((c) => c.sha);
  if (noAgent.length) {
    problems.push({
      rule: 'agent_trailer',
      message: `commits without an Agent trailer: ${noAgent.map((sha) => sha.slice(0, 7)).join(', ')} (use crew commit)`,
      commits: noAgent,
    });
  }

  // Tests and code are by different agents: a tests task touches only its own tests/pending/<T>/ folder,
  // a code task must move all those tests to tests/acceptance/ unchanged.
  const tm = taskMarkers(issueBody);
  if (tm.testsFor) {
    const dir = `${PENDING_DIR}${tm.testsFor}/`;
    const outside = files.map((f) => norm(f.filename)).filter((p) => !p.startsWith(dir));
    if (outside.length) {
      problems.push({ rule: 'tests_task_scope', message: `the tests task only changes ${dir}, but the PR touches: ${outside.join(', ')}`, files: outside });
    }
  }
  if (pendingFiles.length) {
    const moved = new Set(files.filter(isPureMove).map((f) => norm(f.previous_filename)));
    const left = pendingFiles.map(norm).filter((p) => !moved.has(p));
    if (left.length) {
      problems.push({
        rule: 'pending_tests_not_moved',
        message: `tests from the tests task were not moved to tests/acceptance/ unchanged: ${left.join(', ')} (git mv, no edits)`,
        files: left,
      });
    }
  }

  const allowedAcceptance = allowedAcceptanceChanges(issueBody);
  const { protectedHits, acceptanceHits } = fileViolations(files, { allowedAcceptance });
  if (protectedHits.length) {
    problems.push({
      rule: 'protected_paths',
      message: `the PR changes agent rules or CI (${protectedHits.join(', ')}): not allowed for agents; only the harness developer changes these`,
      files: protectedHits,
    });
  }
  if (acceptanceHits.length) {
    problems.push({
      rule: 'acceptance_changed',
      message: `the PR changes existing acceptance tests (${acceptanceHits.join(', ')}), but task #${issue ?? '?'} does not allow it (section "${ACCEPTANCE_SECTION}")`,
      files: acceptanceHits,
    });
  }

  const policy = reviewPolicy(config);
  const author = authorAgent(body);
  if (!author) {
    problems.push({
      rule: 'not_crew_pr',
      message: 'the PR description has no **Agent:** line: the PR was not opened via crew pr open (without crew check and a known author the review cannot count)',
    });
  }
  const need = risk === 'high' ? policy.approvals_high : policy.approvals;
  const review = reviewState(comments, { headSha, author, policy, prCreatedAt: createdAt, now });
  if (review.changes.length) {
    problems.push({ rule: 'changes_requested', message: `reviewer requests changes: ${review.changes.join(', ')}` });
  }

  const fail = problems.length > 0;
  const reviewed = review.approvals.length >= need;
  const state = fail ? 'failure' : reviewed ? 'success' : 'pending';
  const who = policy.require === 'other-vendor' && !review.fallback ? 'an agent from another vendor' : 'another agent';
  const description = fail
    ? problems.map((p) => p.rule).join(', ')
    : reviewed
      ? `ok: review ${review.approvals.join(', ') || 'not required'}`
      : `waiting for review by ${who}: ${review.approvals.length}/${need}`;
  return {
    state,
    description: description.slice(0, 140),
    problems,
    issue,
    author,
    review: { ...review, need, require: policy.require },
    allowed_acceptance: allowedAcceptance,
  };
}

/** Review marker text for a comment. */
export const reviewMarker = ({ verdict, agent, sha }) => `<!-- crew:review verdict=${verdict} agent=${agent} sha=${sha} -->`;
