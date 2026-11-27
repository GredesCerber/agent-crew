// crew factory [--days 14] — the line at a glance: each station (queue → build → review) with its work in progress,
// its median time, its skill kit and what the kit lacks; whether GitHub Actions run; the bottleneck and the worker
// to start for it. Read-only: it changes nothing, it says what to run.
import { ok, warn } from '../core/output.js';
import { loadConfig, requireProject } from '../core/config.js';
import { humanMs } from '../core/metrics.js';
import { kitFor, presentSkills } from '../core/stations.js';
import { flowFromGithub } from './flow.js';
import { actionsHealth } from './tick.js';

/** Work in progress at a station, from crew flow's WIP counts (status labels). */
const WIP = {
  queue: (w) => (w['status:ready'] ?? 0) + (w['status:waiting'] ?? 0),
  build: (w) => (w['status:claimed'] ?? 0) + (w['status:blocked'] ?? 0),
  review: (w) => (w['status:review'] ?? 0),
};

/** The worker that staffs a station; the reviewer from another vendor than the builder when the project has two. */
export function staffing(hosts = ['claude']) {
  const builder = hosts?.[0] ?? 'claude';
  const reviewer = (hosts ?? []).find((h) => h !== builder) ?? builder;
  return {
    queue: `crew worker --host ${builder} --station build --wait (more builders drain the queue)`,
    build: `crew worker --host ${builder} --station build --wait`,
    review: `crew worker --host ${reviewer} --station review --wait`,
  };
}

/** Pure: the factory view from flow numbers, kits and the Actions state. */
export function factoryView({ flow, config = {}, present = new Set(), actions = { state: 'unknown' } }) {
  const run = staffing(config.hosts);
  const stations = ['queue', 'build', 'review'].map((name) => {
    const kit = name === 'queue' ? null : kitFor(name, { config, present });
    return {
      station: name,
      wip: WIP[name](flow.wip ?? {}),
      median_ms: flow.stations?.[name]?.median_ms ?? null,
      ...(kit ? { kit: kit.skills, kit_missing: kit.missing } : {}),
      run: run[name],
    };
  });
  const advice = [];
  if (flow.bottleneck) advice.push(`bottleneck: ${flow.bottleneck}. ${run[flow.bottleneck]}`);
  if (actions.state === 'blocked') advice.push(`GitHub Actions do not run (${actions.reason}): crew tick --every 15 on one machine, and an admin runs crew github setup --local_checks --apply`);
  if (flow.bypassed?.length) advice.push(`${flow.bypassed.length} merged PR(s) closed no task: that work skipped the line (no claim, check or review); open agent sessions through crew`);
  const review = flow.stations?.review;
  if (review?.median_ms != null && review.median_ms < 60_000 && (review.n ?? 0) >= 3) advice.push(`review takes ${humanMs(review.median_ms)} at the median: PRs merge without a real review. Staff the review station: ${run.review}`);
  const thin = stations.filter((s) => s.kit && !s.kit.length).map((s) => s.station);
  if (thin.length) advice.push(`no skills in the kit of: ${thin.join(', ')} (crew skills add ecc --preset builder, or reviewer)`);
  return { stations, actions, throughput_per_week: flow.throughput_per_week, lead_ms: flow.lead_ms, bottleneck: flow.bottleneck, advice };
}

export default {
  name: 'factory',
  summary: 'The line at a glance: each station with its work in progress, time, skill kit, the bottleneck and the worker to start',
  args: [{ name: 'days', type: 'number', description: 'the window for the times, in days (default 14)' }],
  run({ days = 14 } = {}, deps = {}) {
    const loaded = loadConfig();
    const notProject = requireProject(loaded);
    if (notProject) return notProject;
    const { config, root } = loaded;
    const flow = (deps.flow ?? (() => flowFromGithub({ days: Number(days) || 14 })))();
    const actions = (deps.health ?? actionsHealth)();
    const v = factoryView({ flow, config, present: deps.present ?? presentSkills(root), actions });
    const line = v.stations.map((s) => `${s.station} ${s.wip} (${humanMs(s.median_ms)})`).join(' → ');
    const summary = `Line: ${line}; ${v.throughput_per_week}/week, lead time ${humanMs(v.lead_ms)}${v.bottleneck ? `; bottleneck: ${v.bottleneck}` : ''}; Actions: ${actions.state}`;
    return (v.advice.length ? warn : ok)(summary, { artifacts: v, next_actions: v.advice.length ? v.advice : ['the line runs: crew flow for the details'] });
  },
};
