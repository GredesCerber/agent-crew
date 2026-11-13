// crew metrics [--agent codex] [--since 2d] — summary of the .crew/metrics.jsonl log:
// completion rate, check reruns per task, median claim→PR per agent, top-5 errors.
import { join } from 'node:path';
import { ok, warn, fail } from '../core/output.js';
import { loadConfig } from '../core/config.js';
import { readEvents, filterEvents, parseSince, aggregate, metricsRoot, humanMs, table, METRICS_FILE } from '../core/metrics.js';

const pct = (x) => (x == null ? null : `${Math.round(x * 100)}%`);

export default {
  name: 'metrics',
  summary: 'Team metrics: share of tasks taken to a PR, check reruns, claim→PR time, frequent errors',
  args: [
    { name: 'agent', type: 'string', description: 'only this agent: codex or codex/gpt-5 (empty = all)' },
    { name: 'since', type: 'string', description: 'since when: 2026-12-05, ISO time or 30m / 6h / 2d' },
  ],
  run({ agent, since } = {}) {
    const { root } = loadConfig();
    const sinceMs = parseSince(since);
    if (since !== undefined && sinceMs === null) {
      return fail('bad_input', `--since: cannot parse "${since}"`, {
        cause_hint: 'expected a date (2026-12-05), ISO time or 30m / 6h / 2d',
        retry: 'crew metrics --since 1d',
      });
    }
    const file = join(metricsRoot(root), METRICS_FILE);
    const events = filterEvents(readEvents(root), { agent, sinceMs });
    if (!events.length) {
      return warn('No events in the metrics log yet', {
        artifacts: { file },
        next_actions: ['work with crew commands (task claim, check, pr open) — events are recorded automatically', 'crew metrics without filters'],
      });
    }
    const agg = aggregate(events);
    const t = table(
      ['agent', 'claim', 'PR', 'completed', 'check/task', 'claim→PR (median)', 'errors'],
      agg.agents.map((a) => [a.agent, a.claims, a.prs, pct(a.completion_rate), a.retries_per_task, humanMs(a.median_claim_to_pr_ms), a.errors]),
    );
    const errs = agg.top_errors.length ? `\nFrequent errors: ${agg.top_errors.map((e) => `${e.code} ×${e.count}`).join(', ')}` : '';
    const weak = agg.agents.filter((a) => a.completion_rate != null && a.completion_rate < 0.5).map((a) => a.agent);
    return ok(`Metrics: ${agg.total} events, agents: ${agg.agents.length}\n${t}${errs}`, {
      artifacts: { file, events: agg.total, agents: agg.agents, top_errors: agg.top_errors },
      next_actions: weak.length
        ? [`find out why ${weak.join(', ')} drop tasks: gh issue list --label status:blocked`, 'crew eval --dry-run — compare agents on reference tasks']
        : ['crew status'],
    });
  },
};
