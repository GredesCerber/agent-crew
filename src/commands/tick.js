// crew tick [--every 15] — run on this machine what the repo's scheduled CI job does, for when GitHub Actions do not
// run (a locked or over-limit account, an outage): return expired leases, recompute crew-guard, merge ready PRs,
// promote waiting tasks, update the digest. Every step goes through gh like CI does, with the caller's account.
// What it cannot replace: a required check counts only from GitHub Actions, so main stays blocked for normal merges.
import { ok, warn } from '../core/output.js';
import { ghJson } from '../core/exec.js';
import { loadConfig } from '../core/config.js';
import taskCmds from './task.js';
import guard from './guard.js';
import mergeReady from './merge-ready.js';
import digest from './digest.js';

const byName = (name) => taskCmds.find((c) => c.name === name);

/**
 * Are GitHub Actions running in this repo? Looks at the latest workflow runs: jobs that failed without running a
 * single step, with GitHub's own annotation saying why (billing, spending limit). → { state: ok|blocked|unknown, reason }
 */
export function actionsHealth({ j = (args) => ghJson(args, { allowFail: true }) } = {}) {
  const runs = j(['run', 'list', '--limit', '5', '--json', 'databaseId,conclusion,status,createdAt']);
  if (!Array.isArray(runs)) return { state: 'unknown', reason: 'gh could not list workflow runs' };
  if (!runs.length) return { state: 'unknown', reason: 'no workflow runs yet' };
  const finished = runs.filter((r) => r.status === 'completed' && r.conclusion !== 'skipped');
  if (finished.some((r) => r.conclusion === 'success')) return { state: 'ok', reason: null };
  const last = finished[0];
  if (!last) return { state: 'unknown', reason: 'no finished runs among the latest' };
  // jobs a workflow skips by its own conditions say nothing; the ones that should have run but ran no step do
  const ran = (j(['run', 'view', String(last.databaseId), '--json', 'jobs'])?.jobs ?? []).filter((x) => x.conclusion !== 'skipped');
  const neverStarted = ran.length > 0 && ran.every((x) => (x.steps ?? []).length === 0);
  if (!neverStarted) return { state: 'unknown', reason: `the latest runs failed (${last.conclusion}); see crew pr logs` };
  const note = j(['api', `repos/{owner}/{repo}/check-runs/${ran[0].databaseId}/annotations`]);
  const said = Array.isArray(note) ? note.map((n) => n.message).find(Boolean) : null;
  return { state: 'blocked', reason: said ?? 'jobs fail without running a step' };
}

/** One pass of the scheduled job. Each step runs on its own: one failing does not stop the others. */
export async function tickOnce({ steps = defaultSteps() } = {}) {
  const out = [];
  for (const [name, fn] of steps) {
    try {
      const r = await fn();
      out.push({ step: name, status: r?.status ?? 'success', summary: r?.summary ?? '' });
    } catch (e) {
      out.push({ step: name, status: 'error', summary: String(e?.message ?? e).split('\n')[0] });
    }
  }
  return out;
}

function defaultSteps() {
  return [
    ['sweep', () => byName('task sweep').run({})],
    ['guard', () => {
      const prs = ghJson(['pr', 'list', '--state', 'open', '--json', 'number'], { allowFail: true }) ?? [];
      for (const p of prs) { try { guard.run({ pr: p.number, report: true }); } catch { /* next PR */ } }
      return { status: 'success', summary: `crew-guard recomputed for ${prs.length} open PR(s)` };
    }],
    ['merge-ready', () => mergeReady.run({})],
    ['promote', () => byName('task promote').run({})],
    ['digest', () => digest.run({ post: true })],
  ];
}

export default {
  name: 'tick',
  summary: 'Run the scheduled CI job on this machine (leases, crew-guard, merges, promote, digest) when GitHub Actions do not run',
  agent: false,
  args: [
    { name: 'every', type: 'number', description: 'repeat every N minutes until Ctrl+C (CI runs every 15)' },
  ],
  async run({ every } = {}, deps = {}) {
    if (!deps.steps) loadConfig();
    const health = (deps.health ?? actionsHealth)();
    const note = health.state === 'blocked'
      ? `GitHub Actions do not run in this repo (${health.reason}): crew tick does their scheduled work, but required checks on main still count only from Actions, so PRs cannot merge normally until the repo owner fixes it or the repo moves to an owner whose Actions run`
      : null;
    const pass = async () => {
      const steps = await tickOnce(deps.steps ? { steps: deps.steps } : {});
      const failed = steps.filter((s) => s.status === 'error');
      if (!deps.quiet) process.stderr.write(`[crew tick] ${new Date().toISOString().slice(0, 16)} ${steps.map((s) => `${s.step}: ${s.status}`).join(', ')}\n`);
      return { steps, failed };
    };
    if (!every) {
      const { steps, failed } = await pass();
      const opts = { artifacts: { actions: health, steps }, next_actions: [...(note ? [note] : []), 'crew tick --every 15 — keep doing it while Actions are down'] };
      return failed.length ? warn(`crew tick: ${failed.length} of ${steps.length} step(s) failed`, opts) : ok(`crew tick: ${steps.length} steps done${health.state === 'blocked' ? ' (Actions are blocked here)' : ''}`, opts);
    }
    const ms = Math.max(1, Number(every)) * 60_000;
    let passes = 0;
    let stop = false;
    process.once('SIGINT', () => { stop = true; });
    while (!stop) {
      await pass();
      passes++;
      const until = Date.now() + ms;
      while (!stop && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
    }
    return ok(`crew tick stopped after ${passes} pass(es)`, { artifacts: { actions: health, passes } });
  },
};
