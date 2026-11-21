// Data for the screens of crew board beyond the kanban (pure functions, no network; the server feeds them gh data).
// Task drawer, Team & roles, Inbox, Discovery, Pull requests, Activity. Each view says what a number means
// and what the person can do next, so the page itself stays a thin renderer.
import { labelValue, parseMarkers, currentOwner, ownerActivityAt } from './issues.js';
import { prChecks, prQueue, riskOfPr } from './queue.js';
import { linkedIssue, authorAgent } from './guard.js';
import { QUESTION_LABEL, HUMAN_LABEL, questionMeta } from './questions.js';
import { IDEA_LABEL, ideaMeta } from './ideas.js';
import { handoverPolicy, explainPolicy } from './captain.js';
import { RESEARCH_LABEL, budgetOf, researchIdOf, phaseOf } from './discovery.js';

const ms = (x) => { const t = Date.parse(x ?? ''); return Number.isFinite(t) ? t : null; };
const minutesSince = (x, now) => { const t = ms(x); return t === null ? null : Math.max(0, Math.round((now - t) / 60000)); };
const names = (labels = []) => labels.map((l) => l.name);
const lc = (s) => String(s ?? '').toLowerCase();
/** Plain text for the page: markers and HTML comments out, long bodies cut. */
const plain = (s, max = 4000) => String(s ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n').trim().slice(0, max);

/** Goal and acceptance checklist from a task body (crew kickoff writes markdown sections; hand-written issues work too). */
export function taskText(body = '') {
  const text = plain(body);
  const criteria = [...text.matchAll(/^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/gm)].map((m) => ({ text: m[2].trim(), done: m[1] !== ' ' }));
  const section = (name) => new RegExp(`^#{1,4}\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,4}\\s|(?![\\s\\S]))`, 'im').exec(text)?.[1]?.trim() ?? null;
  const bold = /\*\*Goal:?\*\*:?\s*(.+)/i.exec(text)?.[1]?.trim() ?? null;
  const goal = section('Goal') ?? bold ?? text.split('\n').find((l) => l.trim() && !/^\s*([-*#>]|```)/.test(l))?.trim() ?? null;
  return { goal: goal ? goal.slice(0, 600) : null, criteria: criteria.slice(0, 30), text };
}

const TIMELINE = {
  claim: (m) => ({ title: `Claimed by ${m.agent ?? m.by ?? '?'}`, tone: 'good', detail: 'lease taken: the task is reserved for this agent' }),
  heartbeat: (m) => ({ title: 'Heartbeat', tone: 'good', detail: `${m.agent ?? m.by ?? 'the agent'} is still working` }),
  // crew task status writes state=; to= is kept for older markers
  status: (m) => { const to = m.state ?? m.to ?? '?'; return { title: `Status → ${to}`, tone: to === 'blocked' ? 'bad' : 'info', detail: m.agent ? `by ${m.agent}` : '' }; },
  release: (m) => ({ title: 'Returned to the queue', tone: 'warn', detail: `lease released by ${m.agent ?? m.by ?? '?'}` }),
  answer: (m) => ({ title: 'Answer', tone: 'info', detail: m.agent ? `from ${m.agent}` : '' }),
  'idea-accepted': (m) => ({ title: 'Accepted from an idea', tone: 'good', detail: m.by ? `by @${m.by}` : '' }),
};

const at = (m) => m.createdAt ?? m.at ?? null;
/**
 * What happened to a task, oldest first: crew markers on the issue, the linked PR being opened and its review
 * verdicts, the last commit on the task branch. Heartbeats in a row collapse into one line, so a long session
 * does not push the claim out of the list.
 */
export function taskTimeline(issue, pr = null, lastCommitAt = null, max = 20) {
  const events = parseMarkers(issue.comments ?? [])
    .filter((m) => TIMELINE[m.kind])
    .map((m) => ({ kind: m.kind, at: at(m), ...TIMELINE[m.kind](m) }));
  if (pr) {
    events.push({ kind: 'pr', at: pr.createdAt ?? null, title: `PR #${pr.number} opened`, tone: 'info', detail: authorAgent(pr.body) ? `by ${authorAgent(pr.body)}` : pr.title });
    for (const m of parseMarkers(pr.comments ?? [])) {
      if (m.kind !== 'review') continue;
      const okv = m.verdict === 'approve';
      events.push({ kind: 'review', at: at(m), title: okv ? 'Review: approved' : `Review: ${m.verdict ?? 'changes requested'}`, tone: okv ? 'good' : 'bad', detail: m.agent ? `by ${m.agent}` : '' });
    }
  }
  if (lastCommitAt) events.push({ kind: 'commit', at: lastCommitAt, title: 'Last commit on the task branch', tone: 'info', detail: '' });
  const sorted = events.map((x, i) => ({ x, i })).sort((a, b) => (ms(a.x.at) ?? 0) - (ms(b.x.at) ?? 0) || a.i - b.i).map((y) => y.x);
  const out = [];
  for (const ev of sorted) {
    const last = out[out.length - 1];
    if (ev.kind === 'heartbeat' && last?.kind === 'heartbeat') {
      last.count = (last.count ?? 1) + 1;
      last.at = ev.at;
      last.title = `Heartbeat ×${last.count}`;
      last.detail = `${ev.detail}; the time of the last one is shown`;
    } else out.push({ ...ev });
  }
  // keep the first claim even when the list is cut: who took the task is the most useful line
  if (out.length <= max) return out;
  const firstClaim = out.findIndex((e) => e.kind === 'claim');
  const tail = out.slice(-max);
  return firstClaim >= 0 && !tail.includes(out[firstClaim]) ? [out[firstClaim], ...tail.slice(1)] : tail;
}

/**
 * The task drawer. issue: gh issue view (body, comments, labels, assignees); prs: open PRs (as on the board).
 * → goal, criteria, owner and lease, timeline, dependencies, the linked PR with its review and checks.
 */
export function taskView(issue, { prs = [], config = {}, now = Date.now(), lastCommitAt = null } = {}) {
  if (!issue) return null;
  const { goal, criteria, text } = taskText(issue.body);
  const owner = currentOwner(issue.comments ?? []);
  const leaseMinutes = config.lease_minutes ?? 45;
  const lastAt = owner ? [ms(ownerActivityAt(issue.comments ?? [], owner)), ms(lastCommitAt)].filter((x) => x !== null).sort((a, b) => b - a)[0] ?? null : null;
  const left = lastAt === null ? null : Math.round((lastAt + leaseMinutes * 60000 - now) / 60000);
  const after = (parseMarkers([{ body: issue.body ?? '' }], { trustedOnly: false }).find((m) => m.kind === 'after')?.issues ?? '')
    .split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const pr = prs.find((p) => linkedIssue(p.body) === issue.number);
  const timeline = taskTimeline(issue, pr, lastCommitAt);
  const queued = pr ? prQueue([pr], { me: 'board', login: null, reviewers: [], config, now })[0] : null;
  const checks = pr ? prChecks(pr) : null;
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state ?? 'OPEN',
    status: labelValue(issue, 'status'),
    area: labelValue(issue, 'area'),
    risk: labelValue(issue, 'risk'),
    tier: labelValue(issue, 'tier'),
    priority: labelValue(issue, 'priority') ?? 'normal',
    assignees: (issue.assignees ?? []).map((a) => a.login),
    goal,
    criteria,
    body: text.slice(0, 2500),
    owner: owner ? { agent: owner.agent ?? null, since: owner.createdAt ?? owner.at ?? null, lease_left_min: left, stale: left !== null && left < 0 } : null,
    lease_minutes: leaseMinutes,
    timeline,
    after,
    pr: pr ? {
      number: pr.number,
      title: pr.title,
      author: authorAgent(pr.body),
      check: checks.check,
      guard: checks.guard,
      guard_text: checks.guardText ?? null,
      kind: queued?.kind ?? null,
      reason: queued?.reason ?? null,
      have: queued?.have ?? null,
      need: queued?.need ?? null,
    } : null,
    claim_command: `crew task claim ${issue.number}`,
  };
}

/**
 * Team & roles. members: collaborators; team: crew-team block; columns: board columns; claimComments: owner markers
 * of claimed tasks; closed: issues closed in the last 7 days; acting: who acts as captain now.
 */
export function teamView({ members = [], team = null, columns = {}, claimComments = {}, closed = [], config = {}, acting = null, now = Date.now() } = {}) {
  const areasOf = new Map((team?.members ?? []).map((m) => [lc(m.login), m]));
  const all = [...new Set([...members, ...(team?.members ?? []).map((m) => m.login)])].filter((l) => !/\[bot\]$/.test(l));
  const cards = Object.values(columns).flat();
  const weekAgo = now - 7 * 86400000;
  const people = all.map((login) => {
    const mine = cards.filter((c) => c.assignees.some((a) => lc(a) === lc(login)));
    const working = mine.filter((c) => c.status === 'claimed' || c.status === 'review');
    const agents = [...new Set(working.map((c) => currentOwner(claimComments[c.number] ?? [])?.agent).filter(Boolean))];
    const busyMin = working.length ? Math.min(...working.map((c) => c.idle_min)) : null;
    const t = areasOf.get(lc(login));
    return {
      login,
      areas: t?.areas?.filter((a) => a !== 'review') ?? [],
      reviewer: !!t?.review,
      in_team: !!t,
      captain: lc(login) === lc(config.captain),
      working: working.map((c) => ({ number: c.number, title: c.title, status: c.status })),
      queued: mine.filter((c) => c.status === 'ready').length,
      agents,
      active_min: busyMin,
      done_week: closed.filter((i) => ms(i.closedAt) >= weekAgo && (i.assignees ?? []).some((a) => lc(a.login) === lc(login))).length,
    };
  }).sort((a, b) => Number(b.captain) - Number(a.captain) || Number(!!b.working.length) - Number(!!a.working.length) || a.login.localeCompare(b.login));
  const policy = handoverPolicy(config);
  return {
    captain: config.captain ?? null,
    acting: acting?.login && acting.why !== 'captain' ? acting : null,
    policy: { mode: policy.mode, deputies: policy.deputies ?? [], fallback_hours: policy.fallback_hours ?? null, explain: explainPolicy(config) },
    people,
    newcomers: team ? people.filter((p) => !p.in_team).map((p) => p.login) : [],
    has_team_block: !!team,
  };
}

/** Inbox: ideas for the captain, questions that need a human, questions between agents. */
export function inboxView({ ideas = [], questions = [], now = Date.now() } = {}) {
  const q = questions.map((i) => {
    const meta = questionMeta(i) ?? {};
    return {
      number: i.number,
      title: i.title.replace(/^Question(?: for [^:]+)?:\s*/i, ''),
      from: meta.from ?? null,
      area: meta.area ?? labelValue(i, 'area'),
      task: Number(meta.task) || null,
      text: plain(i.body, 1200),
      age_min: minutesSince(i.createdAt, now),
      human: names(i.labels).includes(HUMAN_LABEL),
    };
  });
  return {
    ideas: ideas.filter((i) => names(i.labels).includes(IDEA_LABEL)).map((i) => {
      const meta = ideaMeta(i) ?? {};
      return { number: i.number, title: i.title.replace(/^Idea:\s*/i, ''), who: meta.who ?? null, from: meta.from ?? null, task: Number(meta.task) || null, text: plain(i.body, 1200), age_min: minutesSince(i.createdAt ?? i.updatedAt, now) };
    }),
    human: q.filter((x) => x.human),
    agents: q.filter((x) => !x.human),
  };
}

/** Discovery: research tasks against their budget, the exit criteria, the decisions log, what blocks the plan. */
export function discoveryView({ config = {}, research = [], status = null, discoveryText = '', decisionsText = '', now = Date.now() } = {}) {
  const tasks = research.map((i) => {
    const budget = budgetOf(i.title);
    const claim = parseMarkers(i.comments ?? []).find((m) => m.kind === 'claim');
    const used = claim && i.state !== 'CLOSED' ? (now - (ms(claim.createdAt ?? claim.at) ?? now)) / 3600000 : null;
    return {
      number: i.number,
      id: researchIdOf(i),
      title: i.title.replace(/^Research\s*(\[[^\]]*\])?:\s*/i, ''),
      owner: (i.assignees ?? [])[0]?.login ?? null,
      state: i.state === 'CLOSED' ? 'done' : labelValue(i, 'status') ?? 'ready',
      budget_hours: budget,
      used_hours: used === null ? null : Math.round(used * 10) / 10,
      over: budget !== null && used !== null && used > budget,
    };
  });
  const section = /^##\s+Exit criteria\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(discoveryText)?.[1] ?? '';
  const exit = [...section.matchAll(/^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/gm)].map((m) => ({ text: m[2].trim(), done: m[1] !== ' ' }));
  const decisions = [...decisionsText.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})\s*[—–-]?\s*(.*)$/gm)].map((m) => ({ date: m[1], title: m[2].trim() })).reverse().slice(0, 30);
  return {
    phase: phaseOf(config),
    tasks,
    exit,
    decisions,
    ready: status?.ready ?? false,
    missing: status?.missing ?? [],
  };
}

const NEXT = {
  merge: (q) => (q.human ? { label: 'A person merges it', tone: 'accent' } : { label: 'Merge', tone: 'accent' }),
  review: (q) => ({ label: `Needs review ${q.have}/${q.need}`, tone: 'warn' }),
  checks: () => ({ label: 'Waiting for checks', tone: 'info' }),
  fix: (q) => ({ label: `Author fixes: ${q.reason}`, tone: 'bad' }),
};

/** Pull requests with who wrote and reviewed them, checks, crew-guard and the next step. */
export function prsView(prs = [], { config = {}, now = Date.now() } = {}) {
  const queue = new Map(prQueue(prs, { me: 'board', login: null, reviewers: [], config, now }).map((q) => [q.number, q]));
  return prs.filter((p) => !p.isDraft).map((p) => {
    const q = queue.get(p.number) ?? null;
    const c = prChecks(p);
    const reviews = new Map();
    for (const m of parseMarkers(p.comments ?? [])) if (m.kind === 'review' && m.agent) reviews.set(m.agent, { agent: m.agent, verdict: m.verdict, current: !!m.sha && String(p.headRefOid ?? '').startsWith(m.sha) });
    return {
      number: p.number,
      title: p.title,
      author: authorAgent(p.body),
      issue: linkedIssue(p.body),
      reviews: [...reviews.values()],
      check: c.check,
      guard: c.guard,
      guard_text: c.guardText ?? null,
      risk: riskOfPr(p),
      age_min: minutesSince(p.createdAt, now),
      conflict: String(p.mergeable ?? '').toUpperCase() === 'CONFLICTING',
      draft: !!p.isDraft,
      fork: !!p.isCrossRepository,
      kind: q?.kind ?? (p.isCrossRepository ? 'fork' : null),
      next: q ? NEXT[q.kind]?.(q) ?? null : p.isCrossRepository ? { label: 'From a fork: a person reviews it', tone: 'warn' } : null,
    };
  });
}

const DAY = 86400000;
/** Activity: a feed of recent events (GitHub + this machine's crew metrics) and simple team-health series. */
export function activityView({ closed = [], merged = [], events = [], stale = [], now = Date.now(), days = 7 } = {}) {
  // buckets are local days (the board runs on the captain's machine, as the page does): label them with the local
  // date, not toISOString, which is UTC and shifts every bar by a day east of Greenwich
  const series = [];
  const pad = (x) => String(x).padStart(2, '0');
  for (let d = days - 1; d >= 0; d--) {
    const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - d);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const from = start.getTime(); const to = end.getTime();
    series.push({ day: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`, done: closed.filter((i) => { const t = ms(i.closedAt); return t !== null && t >= from && t < to; }).length });
  }
  const feed = [
    ...closed.map((i) => ({ at: i.closedAt, kind: 'done', title: `#${i.number} ${i.title}`, who: (i.assignees ?? [])[0]?.login ?? null })),
    ...merged.map((p) => ({ at: p.mergedAt, kind: 'merged', title: `PR #${p.number} ${p.title}`, who: p.mergedBy?.login ?? null })),
    ...events.filter((e) => ['task claim', 'pr open', 'task release', 'idea', 'ask', 'pr review'].includes(e.command) && e.status !== 'error')
      .map((e) => ({ at: e.at, kind: e.command.replace(' ', '_'), title: e.issue ? `#${e.issue}` : e.command, who: e.agent ?? null })),
  ].filter((x) => ms(x.at) !== null && ms(x.at) >= now - days * DAY).sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 60);
  // claim -> pr open per agent, from this machine's metrics only
  const claimAt = new Map();
  const per = new Map();
  for (const e of [...events].sort((a, b) => ms(a.at) - ms(b.at))) {
    if (e.status === 'error' || e.issue == null) continue;
    const key = `${e.agent}#${e.issue}`;
    if (e.command === 'task claim') claimAt.set(key, ms(e.at));
    if (e.command === 'pr open' && claimAt.has(key)) {
      (per.get(e.agent) ?? per.set(e.agent, []).get(e.agent)).push((ms(e.at) - claimAt.get(key)) / 60000);
      claimAt.delete(key);
    }
  }
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
  return {
    days: series,
    done_total: series.reduce((s, x) => s + x.done, 0),
    claim_to_pr: [...per.entries()].map(([agent, xs]) => ({ agent, median_min: median(xs), count: xs.length })).sort((a, b) => a.agent.localeCompare(b.agent)),
    stale,
    feed,
    metrics_local: events.length > 0,
  };
}

/** Lines that the Board tab shows above the columns when the team is paused. */
export const pauseView = (issues = []) => issues.filter((i) => names(i.labels).includes('crew:pause') && (i.state ?? 'OPEN') === 'OPEN').map((i) => ({ number: i.number, title: i.title }));
