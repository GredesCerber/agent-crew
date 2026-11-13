// Metrics log: every crew command appends an event to <project root>/.crew/metrics.jsonl.
// Event: { command, issue, agent, status, error_code, duration_ms, at }.
// Writing never throws: metrics must not break the agent's work.
// The root is shared by all worktrees of one repo (otherwise claim and pr open would land in different files).
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, agentId } from './config.js';

export const METRICS_FILE = join('.crew', 'metrics.jsonl');

const readText = (p) => {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
};

/** Project git dir: .git is a folder (regular repo) or a "gitdir: ..." file (worktree). */
function gitDir(root) {
  const dotgit = join(root, '.git');
  try {
    if (statSync(dotgit).isDirectory()) return dotgit;
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+)$/m.exec(readText(dotgit) ?? '');
  return m ? resolve(root, m[1].trim()) : null;
}

/**
 * Where to write metrics: for a worktree, the main repo root (via commondir),
 * for a regular repo and a folder without git, root itself. No git invocation, only file reads.
 */
export function metricsRoot(root) {
  try {
    const dotgit = join(root, '.git');
    if (!existsSync(dotgit) || statSync(dotgit).isDirectory()) return root;
    const gd = gitDir(root);
    const common = gd && readText(join(gd, 'commondir'));
    return common ? dirname(resolve(gd, common)) : root;
  } catch {
    return root;
  }
}

/** Task number from the current branch crew/<id>-... (reads HEAD directly, without git). */
export function branchIssue(root) {
  try {
    const gd = gitDir(root);
    const head = gd && readText(join(gd, 'HEAD'));
    return Number(/^ref:\s*refs\/heads\/crew\/(\d+)-/.exec(head ?? '')?.[1]) || null;
  } catch {
    return null;
  }
}

/** Append an event. Returns true if written; false on any error. */
export function recordEvent(root, event = {}) {
  try {
    if (!root || ['0', 'off', 'false'].includes(String(process.env.CREW_METRICS ?? '').toLowerCase())) return false;
    const e = {
      command: event.command ?? null,
      issue: event.issue ?? null,
      agent: event.agent ?? null,
      status: event.status ?? null,
      error_code: event.error_code ?? null,
      duration_ms: Number.isFinite(event.duration_ms) ? Math.round(event.duration_ms) : null,
      at: event.at ?? new Date().toISOString(),
    };
    const p = join(metricsRoot(root), METRICS_FILE);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(e) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** Event from a crew/v1 command result (for bin/crew.js and the MCP server). */
export function eventFromResult({ command, opts = {}, result, root, agent, started }) {
  const fromArtifacts = Number(result?.artifacts?.issue) || null;
  const fromOpts = typeof opts.id === 'number' && Number.isFinite(opts.id) ? opts.id : null;
  return {
    command,
    issue: fromOpts ?? fromArtifacts ?? (root ? branchIssue(root) : null),
    agent,
    status: result?.status ?? 'error',
    error_code: result?.error?.code ?? null,
    duration_ms: started === undefined ? null : Date.now() - started,
    at: new Date().toISOString(),
  };
}

/**
 * Record a command's outcome. Shared entry point for the CLI (bin/crew.js) and MCP (callTool).
 * Only writes into a real project (crew.config.json found), so as not to litter arbitrary folders.
 * opts.cwd (if the command supports it) is the folder where the command actually ran.
 */
export function recordCommand({ command, opts = {}, result, started }) {
  try {
    const { root, path } = loadConfig(typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : process.cwd());
    if (!path) return false;
    return recordEvent(root, eventFromResult({ command, opts, result, root, agent: agentId(), started }));
  } catch {
    return false;
  }
}

/** Read the log. Corrupt lines are skipped (the file may have been cut off mid-write). */
export function readEvents(root) {
  const text = readText(join(metricsRoot(root), METRICS_FILE));
  if (!text) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object') out.push(e);
    } catch {
      /* skip the corrupt line */
    }
  }
  return out;
}

/** "2026-11-01", ISO, or relative "30m" / "6h" / "2d" -> epoch milliseconds. null if not recognized. */
export function parseSince(since, now = Date.now()) {
  if (since === undefined || since === null || since === '') return null;
  const rel = /^(\d+)\s*([mhd])$/.exec(String(since).trim());
  if (rel) return now - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]];
  const t = Date.parse(since);
  return Number.isFinite(t) ? t : null;
}

/** Agent match: exact or by vendor ("codex" matches "codex/gpt-5"). */
export const agentMatches = (agent, filter) =>
  !filter || agent === filter || String(agent ?? '').startsWith(filter + '/') || String(agent ?? '').startsWith(filter + '@');

export function filterEvents(events, { agent, sinceMs } = {}) {
  return events.filter((e) => agentMatches(e.agent, agent) && (sinceMs == null || Date.parse(e.at) >= sinceMs));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * Pure aggregation of events per agent:
 *   completion_rate      successful `pr open` / successful `task claim`
 *   retries_per_task     average number of `check` runs per task (over tasks where check ran)
 *   median_claim_to_pr_ms median time from a successful claim to the first successful pr open on the same task
 * plus the top 5 error codes across all events.
 */
export function aggregate(events) {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const agents = new Map();
  const errors = new Map();
  const get = (id) => {
    if (!agents.has(id)) agents.set(id, { claims: 0, prs: 0, checks: new Map(), check_failures: 0, claimedAt: new Map(), durations: [], errors: 0, events: 0 });
    return agents.get(id);
  };
  for (const e of sorted) {
    const a = get(e.agent ?? 'unknown');
    a.events++;
    const success = e.status === 'success' || e.status === 'warning';
    if (e.status === 'error') {
      a.errors++;
      const code = e.error_code ?? 'unknown';
      errors.set(code, (errors.get(code) ?? 0) + 1);
    }
    if (e.command === 'task claim' && success) {
      a.claims++;
      if (e.issue != null && !a.claimedAt.has(e.issue)) a.claimedAt.set(e.issue, Date.parse(e.at));
    } else if (e.command === 'pr open' && success) {
      a.prs++;
      const t0 = e.issue != null ? a.claimedAt.get(e.issue) : undefined;
      if (t0 !== undefined) {
        a.durations.push(Date.parse(e.at) - t0);
        a.claimedAt.delete(e.issue); // a repeated pr open on the same task is not counted
      }
    } else if (e.command === 'check') {
      const key = e.issue ?? 'no task';
      a.checks.set(key, (a.checks.get(key) ?? 0) + 1);
      if (e.status === 'error') a.check_failures++;
    }
  }
  const rows = [...agents.entries()]
    .map(([agent, a]) => {
      const perTask = [...a.checks.entries()].filter(([k]) => k !== 'no task').map(([, n]) => n);
      return {
        agent,
        events: a.events,
        errors: a.errors,
        claims: a.claims,
        prs: a.prs,
        completion_rate: a.claims ? round(a.prs / a.claims) : null,
        checks: [...a.checks.values()].reduce((s, n) => s + n, 0),
        check_failures: a.check_failures,
        retries_per_task: perTask.length ? round(perTask.reduce((s, n) => s + n, 0) / perTask.length) : null,
        median_claim_to_pr_ms: median(a.durations),
      };
    })
    .sort((x, y) => x.agent.localeCompare(y.agent));
  const top_errors = [...errors.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((x, y) => y.count - x.count || x.code.localeCompare(y.code))
    .slice(0, 5);
  return { total: events.length, agents: rows, top_errors };
}

/** Human-readable duration: 95000 -> "1m 35s". */
export function humanMs(ms) {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Simple plain-text table (monospaced). */
export function table(headers, rows) {
  const cells = [headers, ...rows].map((r) => r.map((c) => (c == null ? '-' : String(c))));
  const w = headers.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
  return [line(cells[0]), w.map((n) => '-'.repeat(n)).join('  '), ...cells.slice(1).map(line)].join('\n');
}
