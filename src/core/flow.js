// Flow of work through the crew stations, from GitHub itself (team-wide, unlike the per-machine metrics log):
//   queue   the task is created → an agent claims it (crew:claim marker)
//   build   claimed → its PR opens
//   review  PR opens → it merges (review, checks, the merge)
// Lead time is created → merged. The bottleneck is the station with the longest median. Pure: data in, numbers out.
import { parseMarkers } from './issues.js';
import { linkedIssue } from './guard.js';

export const STATIONS = ['queue', 'build', 'review'];

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const ms = (t) => (t ? Date.parse(t) : NaN);
const ok = (x) => Number.isFinite(x) && x >= 0;

/**
 * issues: [{ number, createdAt, closedAt, state, labels:[{name}], comments }], prs: [{ number, createdAt, mergedAt,
 * isDraft, state, body }], days: the window. → { window_days, merged, throughput_per_week, lead_ms, stations,
 * bottleneck, wip, bypassed, items }
 */
export function flow({ issues = [], prs = [], now = Date.now(), days = 14 } = {}) {
  const since = now - days * 86_400_000;
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const merged = prs.filter((p) => p.mergedAt && ms(p.mergedAt) >= since);
  const items = [];
  const bypassed = [];
  for (const p of merged) {
    const n = linkedIssue(p.body);
    const issue = n ? byNumber.get(n) : null;
    if (!n) { bypassed.push(p.number); continue; }
    if (!issue) continue;
    const claim = parseMarkers(issue.comments ?? []).find((m) => m.kind === 'claim');
    const t = { created: ms(issue.createdAt), claimed: ms(claim?.createdAt), opened: ms(p.createdAt), merged: ms(p.mergedAt) };
    const span = (a, b) => (ok(t[b] - t[a]) ? t[b] - t[a] : null);
    items.push({
      issue: n, pr: p.number,
      queue: span('created', 'claimed'), build: span('claimed', 'opened'), review: span('opened', 'merged'), lead: span('created', 'merged'),
    });
  }
  const stations = Object.fromEntries(STATIONS.map((s) => {
    const xs = items.map((i) => i[s]).filter((x) => x != null);
    return [s, { median_ms: median(xs), n: xs.length }];
  }));
  const ranked = STATIONS.filter((s) => stations[s].median_ms != null).sort((a, b) => stations[b].median_ms - stations[a].median_ms);
  // work in progress now, by the status label of open tasks, and open PRs
  const wip = {};
  for (const i of issues.filter((x) => !x.closedAt && String(x.state ?? 'OPEN').toUpperCase() === 'OPEN')) {
    const status = (i.labels ?? []).map((l) => l.name ?? l).find((l) => String(l).startsWith('status:'));
    if (status) wip[status] = (wip[status] ?? 0) + 1;
  }
  const open = prs.filter((p) => !p.mergedAt && String(p.state ?? 'OPEN').toUpperCase() === 'OPEN');
  wip['pr:open'] = open.filter((p) => !p.isDraft).length;
  wip['pr:draft'] = open.filter((p) => p.isDraft).length;
  return {
    window_days: days,
    merged: merged.length,
    throughput_per_week: Math.round((merged.length / days) * 7 * 10) / 10,
    lead_ms: median(items.map((i) => i.lead).filter((x) => x != null)),
    stations,
    bottleneck: ranked[0] ?? null,
    wip,
    bypassed,
    items,
  };
}
