// Team digest without an LLM: what waits for a human, stale leases, PRs, idle members. `crew digest` prints it;
// the sweep job posts it to one pinned issue every 15 minutes, so no agent session has to poll the repo.
import { labelValue, ownerState } from './issues.js';
import { prQueue } from './queue.js';
import { questionMeta, HUMAN_LABEL, QUESTION_LABEL } from './questions.js';
import { IDEA_LABEL, ideaMeta } from './ideas.js';
import { RESEARCH_LABEL, budgetOf, phaseOf } from './discovery.js';
import { parseMarkers } from './issues.js';

export const DIGEST_LABEL = 'crew:digest';
export const DIGEST_TITLE = 'crew digest: team status';
export const DIGEST_MARKER = '<!-- crew:digest -->';

const minsSince = (now, iso) => Math.max(0, Math.round((now - Date.parse(iso ?? '')) / 60000)) || 0;
const names = (xs) => (xs ?? []).map((x) => x.name);

/** -> { sections: [{ key, title, lines }], counts } (pure, no network). */
export function digestModel({ issues = [], prs = [], questions = [], ideas = [], team = null, claimComments = {}, acting = null, collaborators = [], config = {}, now = Date.now() } = {}) {
  const lease = config.lease_minutes ?? 45;
  const reviewWait = config.review?.fallback_minutes ?? 30;
  const st = (i) => labelValue(i, 'status');
  const who = (i) => (i.assignees ?? []).map((a) => `@${a.login}`).join(' ') || 'no owner';
  const tasks = issues.filter((i) => !names(i.labels).some((n) => ['epic', QUESTION_LABEL, DIGEST_LABEL, IDEA_LABEL].includes(n)));
  const ready = tasks.filter((i) => st(i) === 'ready');
  const claimed = tasks.filter((i) => st(i) === 'claimed');

  const human = questions.filter((q) => names(q.labels).includes(HUMAN_LABEL))
    .map((q) => `#${q.number} ${q.title} (asked by ${questionMeta(q)?.from ?? 'an agent'})`);
  const blocked = tasks.filter((i) => ['blocked', 'needs-spec'].includes(st(i))).map((i) => `#${i.number} ${i.title} (${st(i)}, ${who(i)})`);
  // Same rule as the sweep: the owner's last crew marker, not the issue's updatedAt (any bystander comment bumps that).
  const quiet = (i) => {
    const c = claimComments[i.number];
    if (!c) return { stale: minsSince(now, i.updatedAt) > lease, min: minsSince(now, i.updatedAt) };
    const s = ownerState(c, { now, leaseMinutes: lease });
    return { stale: s.stale, min: minsSince(now, s.lastActivityAt ?? i.updatedAt) };
  };
  const stale = claimed.filter((i) => quiet(i).stale)
    .map((i) => `#${i.number} ${i.title} (${who(i)}, quiet ${quiet(i).min} min, lease ${lease})`);
  const prLines = prQueue(prs, { me: 'crew-digest', login: null, reviewers: [], config, now }).map((x) =>
    x.kind === 'fix' ? `#${x.number} ${x.title}: waits for its author (${x.reason})`
      : x.kind === 'merge' ? `#${x.number} ${x.title}: ready to merge${x.human ? ' (risk:high in solo: a person reads and merges it)' : ''}`
        : x.kind === 'checks' ? `#${x.number} ${x.title}: approved, waiting for checks`
          : `#${x.number} ${x.title}: waits for review ${x.age} min${x.age > reviewWait ? ' (slow)' : ''}`);
  const unanswered = questions.filter((q) => !names(q.labels).includes(HUMAN_LABEL))
    .map((q) => `#${q.number} ${q.title} (to ${who(q)}, ${minsSince(now, q.createdAt ?? q.updatedAt)} min)`);
  // Research taken longer ago than its budget ([Nh] in the title): one research task must not eat the whole discovery.
  const overBudget = claimed.filter((i) => names(i.labels).includes(RESEARCH_LABEL) && budgetOf(i.title)).flatMap((i) => {
    const claims = parseMarkers(claimComments[i.number] ?? []).filter((m) => m.kind === 'claim');
    const since = claims.length ? claims[claims.length - 1].at ?? claims[claims.length - 1].createdAt : i.updatedAt;
    const hours = minsSince(now, since) / 60;
    return hours > budgetOf(i.title) ? [`#${i.number} ${i.title} (${who(i)}, ${hours.toFixed(1)} h of ${budgetOf(i.title)} h)`] : [];
  });
  const ideaLines = ideas.map((i) => { const m = ideaMeta(i); return `#${i.number} ${i.title}${m?.who ? ` (from @${m.who})` : ''}, ${minsSince(now, i.createdAt)} min`; });
  // People with write access who are not in the crew-team block yet (added in GitHub settings): the captain gives them an
  // area; meanwhile their agents take free tasks from anyone.
  const inTeam = new Set((team?.members ?? []).map((m) => m.login.toLowerCase()));
  const newcomers = team ? collaborators.filter((l) => !inTeam.has(String(l).toLowerCase()) && !/\[bot\]$/.test(l))
    .map((l) => `@${l}: has access but no area in docs/prd.md (crew-team); until then their agent takes free tasks`) : [];
  const idle = [];
  for (const m of team?.members ?? []) {
    const lc = m.login.toLowerCase();
    const mine = (i) => (i.assignees ?? []).some((a) => a.login.toLowerCase() === lc);
    if (claimed.some(mine)) continue;
    // a member whose PR is open (in review or waiting for their fixes) is not idle
    if (prs.some((p) => !p.isDraft && String(p.author?.login ?? '').toLowerCase() === lc)) continue;
    const waiting = ready.filter(mine).length;
    idle.push(`@${m.login}: nothing in progress, ${waiting ? `${waiting} ready task(s) assigned` : 'no ready tasks assigned'}`);
  }

  const sections = [
    { key: 'human', title: 'Needs a human', lines: [...human, ...blocked] },
    { key: 'stale', title: 'Stale leases', lines: stale },
    { key: 'prs', title: 'Pull requests', lines: prLines },
    { key: 'ideas', title: 'Ideas waiting for the captain', lines: ideaLines },
    { key: 'questions', title: 'Open questions between agents', lines: unanswered },
    { key: 'idle', title: 'Idle members', lines: idle },
    { key: 'newcomers', title: 'Joined without an area', lines: newcomers },
    { key: 'research', title: 'Research over budget', lines: overBudget },
  ];
  // who decides right now (the captain, or a deputy during a handover / automatic fallback)
  const captain = config.captain ? { captain: config.captain, acting: acting?.login && acting.why !== 'captain' ? acting : null } : null;
  return {
    captain,
    phase: phaseOf(config),
    sections,
    counts: { ready: ready.length, claimed: claimed.length, human: human.length + blocked.length, stale: stale.length, prs: prLines.length, questions: unanswered.length, ideas: ideaLines.length, idle: idle.length, newcomers: newcomers.length },
  };
}

/** Markdown for the pinned issue (and the terminal). */
export function renderDigest(model, { now = Date.now() } = {}) {
  const c = model.counts;
  const stamp = new Date(now).toISOString().replace('T', ' ').slice(0, 16);
  const out = [DIGEST_MARKER, `_Updated ${stamp} UTC by \`crew digest\` (no LLM). Edits here are overwritten._`, '',
    `**${c.ready}** ready · **${c.claimed}** in progress · **${c.human}** need a human · **${c.stale}** stale · **${c.prs}** PRs waiting`, ''];
  // The issue is rewritten every 15 minutes: break @mentions (ours and any in titles) so nobody gets pinged each time.
  const quiet = (l) => l.replace(/@(?=[\w-])/g, '@​');
  if (model.phase === 'discovery') out.push('**Phase:** discovery: research and decisions, no product code until the plan (`crew discover status`)', '');
  const cap = model.captain;
  if (cap) out.push(quiet(cap.acting ? `**Captain:** @${cap.captain}; **acting now:** @${cap.acting.login} (${cap.acting.why === 'handoff' ? `handed over until ${cap.acting.until}` : 'the captain has been quiet, automatic fallback'})` : `**Captain:** @${cap.captain}`), '');
  for (const s of model.sections) out.push(`### ${s.title}`, ...(s.lines.length ? s.lines.map((l) => `- ${quiet(l)}`) : ['- none']), '');
  return out.join('\n');
}
