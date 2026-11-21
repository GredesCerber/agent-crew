// Working with the task queue in GitHub Issues through the gh CLI.
import { gh, ghJson } from './exec.js';

// waiting: waits for dependencies (crew:after marker in the body); crew task promote moves it to ready.
export const STATUS = ['ready', 'claimed', 'review', 'blocked', 'needs-spec', 'waiting', 'done'];
export const TIERS = ['low', 'mid', 'high'];

export const labelValue = (issue, prefix) =>
  issue.labels.map((l) => l.name).find((n) => n.startsWith(prefix + ':'))?.slice(prefix.length + 1) ?? null;

export function listIssues({ label, limit = 200, cwd } = {}) {
  const args = ['issue', 'list', '--state', 'open', '--limit', String(limit), '--json', 'number,title,labels,assignees,updatedAt'];
  if (label) args.push('--label', label);
  return ghJson(args, cwd ? { cwd } : undefined) ?? [];
}

/** Emergency stop label: while such an issue is open, agents do not take tasks. */
export const PAUSE_LABEL = 'crew:pause';

/** Open issues with the crew:pause label (pure function over the list from listIssues). */
export function pauseIssues(issues = []) {
  return issues.filter(
    (i) => (i.state ?? 'OPEN').toUpperCase() === 'OPEN' && (i.labels ?? []).some((l) => (l?.name ?? l) === PAUSE_LABEL),
  );
}

/** Whether the emergency stop is on. Without an argument it asks GitHub; tests pass a list. */
export function isPaused(issues = listIssues({ label: PAUSE_LABEL })) {
  return pauseIssues(issues).length > 0;
}

export function viewIssue(n) {
  return ghJson(['issue', 'view', String(n), '--json', 'number,title,labels,assignees,body,updatedAt,state,comments']);
}

export function setStatus(n, to, { from = [] } = {}) {
  const args = ['issue', 'edit', String(n), '--add-label', `status:${to}`];
  for (const f of from) if (f !== to) args.push('--remove-label', `status:${f}`);
  gh(args);
}

export function comment(n, body) {
  gh(['issue', 'comment', String(n), '--body', body]);
}

/** Machine-readable markers in comments: <!-- crew:claim agent=codex/x at=ISO --> */
export const marker = (kind, fields) =>
  `<!-- crew:${kind} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')} -->`;

/**
 * Text from an agent/human (--note) into a comment: escapes HTML comments
 * so a quoted marker in the note does not become a real marker.
 */
export const safeText = (s = '') => String(s ?? '').replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');

/** Repo members (write access) and the Actions bot. Markers from anyone else are ignored. */
export const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const BOT_LOGINS = ['github-actions', 'github-actions[bot]'];

/**
 * Whether markers in a comment can be trusted. In a public repo anyone can comment;
 * without this check an outsider could take a task from an agent (crew:release) or "approve" a PR (crew:review).
 * A comment without author/authorAssociation fields (synthetic, in tests) is trusted.
 */
export function isTrustedComment(c = {}) {
  if (!('authorAssociation' in c) && !c.author) return true;
  if (BOT_LOGINS.includes(c.author?.login)) return true;
  return TRUSTED_ASSOCIATIONS.includes(String(c.authorAssociation ?? '').toUpperCase());
}

export function parseMarkers(comments = [], { trustedOnly = true } = {}) {
  const out = [];
  for (const c of comments) {
    if (trustedOnly && !isTrustedComment(c)) continue;
    for (const m of (c.body ?? '').matchAll(/<!-- (?:crew|hk):(\w+(?:-\w+)*)((?: \w+=\S+)*) -->/g)) {
      const fields = Object.fromEntries([...m[2].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
      // kind, createdAt and by come from the comment itself: a kind= or by= field must not override them
      out.push({ ...fields, kind: m[1], createdAt: c.createdAt, by: c.author?.login ?? null });
    }
  }
  return out;
}

/** Who currently owns the task: the first claim after the last release. */
export function currentOwner(comments) {
  const ms = parseMarkers(comments);
  let owner = null;
  for (const m of ms) {
    if (m.kind === 'release') owner = null;
    else if (m.kind === 'claim' && !owner) owner = m;
  }
  return owner;
}

const markerTime = (m) => m?.createdAt ?? m?.at ?? null;

/**
 * Latest activity of the OWNER: their markers (claim, heartbeat, status) after their claim.
 * Markers from other agents (e.g. the loser of a claim_conflict) do not extend the lease.
 */
export function ownerActivityAt(comments, owner) {
  if (!owner) return null;
  const ms = parseMarkers(comments);
  const start = ms.findIndex((m) => m.kind === 'claim' && m.agent === owner.agent && m.at === owner.at);
  let last = markerTime(owner);
  for (const m of ms.slice(Math.max(start, 0))) if (m.agent === owner.agent && m.kind !== 'release') last = markerTime(m) ?? last;
  return last;
}

/**
 * Owner and whether their lease went stale (pure function).
 * -> { owner, lastActivityAt, stale }; with no owner stale = false.
 */
export function ownerState(comments, { lastCommitAt = null, now = Date.now(), leaseMinutes }) {
  const owner = currentOwner(comments);
  if (!owner) return { owner: null, lastActivityAt: null, stale: false };
  const lastActivityAt = ownerActivityAt(comments, owner);
  return { owner, lastActivityAt, stale: isStale({ lastMarkerAt: lastActivityAt, lastCommitAt, now, leaseMinutes }) };
}

/** ISO string / Date / ms number -> ms or null. */
const toMs = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const t = x instanceof Date ? x.getTime() : typeof x === 'number' ? x : Date.parse(x);
  return Number.isFinite(t) ? t : null;
};

/**
 * Whether the task lease went stale (pure function, tests run it).
 * Activity = the last crew marker in comments (if none, the issue's updatedAt)
 * OR the last commit on the task branch origin/crew/<id>-*, whichever is fresher.
 * So an agent that pushes but sends no heartbeat does not lose the task.
 * If there is no date at all, it is not stale (we do not take a task blindly).
 */
export function isStale({ lastMarkerAt, issueUpdatedAt, lastCommitAt, now = Date.now(), leaseMinutes }) {
  const times = [toMs(lastMarkerAt) ?? toMs(issueUpdatedAt), toMs(lastCommitAt)].filter((t) => t !== null);
  if (!times.length) return false;
  return toMs(now) - Math.max(...times) > leaseMinutes * 60_000;
}

export function tierAllows(workerTier, taskTier) {
  return TIERS.indexOf(taskTier ?? 'mid') <= TIERS.indexOf(workerTier ?? 'high');
}

const CYRILLIC = {
  '\u0430': 'a', '\u0431': 'b', '\u0432': 'v', '\u0433': 'g', '\u0434': 'd', '\u0435': 'e', '\u0451': 'yo', '\u0436': 'zh', '\u0437': 'z', '\u0438': 'i', '\u0439': 'y',
  '\u043a': 'k', '\u043b': 'l', '\u043c': 'm', '\u043d': 'n', '\u043e': 'o', '\u043f': 'p', '\u0440': 'r', '\u0441': 's', '\u0442': 't', '\u0443': 'u', '\u0444': 'f',
  '\u0445': 'kh', '\u0446': 'ts', '\u0447': 'ch', '\u0448': 'sh', '\u0449': 'shch', '\u044a': '', '\u044b': 'y', '\u044c': '', '\u044d': 'e', '\u044e': 'yu', '\u044f': 'ya',
};

export function slugify(title) {
  const s = title.normalize('NFC').toLowerCase().replace(/[\u0430-\u044f\u0451]/g, (c) => CYRILLIC[c])
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
  return s || 'task';
}
