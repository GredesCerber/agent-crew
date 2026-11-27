// crew flow [--days 14] — how work flows through the stations (queue → build → review), team-wide from GitHub:
// throughput, lead time, the median time at each station, the bottleneck, work in progress, and merged PRs that
// closed no task (work that went around crew).
import { ok, warn, fail } from '../core/output.js';
import { ghJson } from '../core/exec.js';
import { loadConfig, requireProject } from '../core/config.js';
import { humanMs } from '../core/metrics.js';
import { flow, STATIONS } from '../core/flow.js';

const HINT = {
  queue: 'tasks wait for an agent: start more workers (crew worker) or claim with crew task next',
  build: 'tasks take long to build: split them smaller (crew task lint flags big ones) or check crew pr logs for red checks',
  review: 'PRs wait for review and merge: run a reviewer (crew task next hands out reviews) and keep checks green; with Actions down, crew tick',
};

/** The flow numbers for the last `days`, read from GitHub (j: gh → JSON, stubbed in tests). */
export function flowFromGithub({ j = (args) => ghJson(args), now = Date.now(), days = 14 } = {}) {
  const from = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const prs = [
    ...(j(['pr', 'list', '--state', 'merged', '--search', `merged:>=${from}`, '--limit', '300', '--json', 'number,createdAt,mergedAt,body,isDraft,state']) ?? []),
    ...(j(['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,createdAt,mergedAt,body,isDraft,state']) ?? []),
  ];
  const issues = [
    ...(j(['issue', 'list', '--state', 'closed', '--search', `closed:>=${from}`, '--limit', '300', '--json', 'number,createdAt,closedAt,state,labels,comments']) ?? []),
    ...(j(['issue', 'list', '--state', 'open', '--limit', '300', '--json', 'number,createdAt,closedAt,state,labels,comments']) ?? []),
  ];
  return flow({ issues, prs, now, days });
}

export default {
  name: 'flow',
  summary: 'Flow through the stations (queue → build → review): throughput, lead time, time per station, the bottleneck, WIP',
  args: [{ name: 'days', type: 'number', description: 'the window in days (default 14)' }],
  run({ days = 14 } = {}, deps = {}) {
    const loaded = loadConfig();
    const notProject = requireProject(loaded);
    if (notProject) return notProject;
    const window = Number(days);
    if (!(window > 0 && window <= 365)) return fail('bad_input', `--days must be 1..365, not "${days}"`, { retry: 'crew flow --days 14' });
    const f = flowFromGithub({ j: deps.j, now: deps.now ?? Date.now(), days: window });
    const at = (s) => `${s} ${humanMs(f.stations[s].median_ms) ?? '—'}`;
    const summary = `${f.merged} merged in ${window} days (${f.throughput_per_week}/week); lead time ${humanMs(f.lead_ms) ?? '—'} (median): ${STATIONS.map(at).join(' → ')}${f.bottleneck ? `; bottleneck: ${f.bottleneck}` : ''}`;
    const { items, ...rest } = f;
    const opts = {
      artifacts: { ...rest, items: items.slice(0, 50) },
      next_actions: [
        ...(f.bottleneck ? [HINT[f.bottleneck]] : []),
        ...(f.bypassed.length ? [`${f.bypassed.length} merged PR(s) closed no task (${f.bypassed.slice(0, 8).map((n) => `#${n}`).join(', ')}): work went around crew, so nobody claimed, checked or reviewed it the crew way`] : []),
        `work in progress now: ${Object.entries(f.wip).map(([k, v]) => `${k} ${v}`).join(', ')}`,
      ],
    };
    return f.bypassed.length > f.merged / 2 || !f.merged ? warn(summary, opts) : ok(summary, opts);
  },
};
