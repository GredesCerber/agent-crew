// crew worker — the agent runs the task loop on its own, without a UI.
// task next → task claim → headless agent in the task worktree → check the issue status → next task.
// A new agent process per task = a context reset at the phase boundary.
// Started by a human (agent: false): the agent does not need to be able to spawn other agents via MCP.
import { spawn as nodeSpawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ok, warn, fail, CrewError } from '../core/output.js';
import { run as exec } from '../core/exec.js';
import { killTree } from '../core/proc.js';
import { recordCommand } from '../core/metrics.js';
import { loadConfig, machineName } from '../core/config.js';
import { viewIssue, labelValue, TIERS } from '../core/issues.js';
import { loadAdapter } from './adapters.js';
import taskCommands from './task.js';

const WAIT_MS = 5 * 60_000;
const SUCCESS = ['review', 'done'];
const HANDOFF = ['blocked', 'needs-spec'];

/**
 * Prompt for a single task. One line, without the characters " & | < > ^ % —
 * on Windows the argument goes through cmd /c, where a newline and these characters break the command.
 */
export function taskPrompt({ id, branch }) {
  return [
    `You are an agent of a crew team. Task issue #${id} is already claimed by you: status claimed, branch ${branch ?? `crew/${id}-...`}, the current folder is its worktree.`,
    `Work only on issue #${id} and only in this folder, strictly following the crew-workflow skill, starting with the Understand step: gh issue view ${id}.`,
    'Do not call crew task next or crew task claim — the worker will hand out the next task.',
    `For long work, run crew task heartbeat ${id} about every 30 minutes.`,
    `Finish with exactly one of: crew pr open — the task goes to review; crew task status ${id} blocked --note with a description; crew task status ${id} needs-spec --note with a question.`,
    'Then end your work.',
  ].join(' ');
}

/** Call a crew command as a function: CrewError → a crew/v1 result, not an exception. */
async function call(fn, opts) {
  try {
    return await fn(opts);
  } catch (e) {
    return e instanceof CrewError ? e.toResult() : fail('internal', e.message, { stop_when: 'it keeps happening — tell the human' });
  }
}

const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};


/** Run the agent: stdout/stderr → log file, prompt → stdin, killed on timeout. */
export function spawnAgent(spec, { cwd, env, timeoutMs, logFile }) {
  return new Promise((done) => {
    let out = 'ignore';
    if (logFile) {
      mkdirSync(dirname(logFile), { recursive: true });
      out = createWriteStream(logFile);
    }
    let child;
    try {
      child = nodeSpawn(spec.cmd, spec.args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: [spec.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32', // own process group → the whole tree can be killed
      });
    } catch (e) {
      done({ code: -1, timedOut: false, error: e.message });
      return;
    }
    if (out !== 'ignore') { child.stdout.pipe(out, { end: false }); child.stderr.pipe(out, { end: false }); }
    else { child.stdout.resume(); child.stderr.resume(); }
    if (spec.input != null) child.stdin.end(spec.input);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (out !== 'ignore') out.end();
      done(r);
    };
    child.on('error', (e) => finish({ code: -1, timedOut, error: e.message }));
    child.on('close', (code, signal) => finish({ code: code ?? -1, signal, timedOut }));
  });
}

/**
 * A crew command as a function + recording the event in .crew/metrics.jsonl (as in the CLI and MCP).
 * Without this, the worker claim/release are invisible in crew metrics and the completion rate of worker agents is wrong.
 */
export function recorded(cmd) {
  return async (o) => {
    const started = Date.now();
    try {
      const result = await cmd.run(o);
      recordCommand({ command: cmd.name, opts: o, result, started });
      return result;
    } catch (e) {
      const result = e instanceof CrewError ? e.toResult() : fail('internal', e.message);
      recordCommand({ command: cmd.name, opts: o, result, started });
      throw e;
    }
  };
}

function defaultDeps() {
  const byName = Object.fromEntries(taskCommands.map((c) => [c.name, c]));
  return {
    next: recorded(byName['task next']),
    claim: recorded(byName['task claim']),
    release: recorded(byName['task release']),
    viewIssue,
    spawn: spawnAgent,
    adapters: { load: loadAdapter },
    loadConfig,
    gitCommonDir: (cwd) => {
      const r = exec('git', ['rev-parse', '--git-common-dir'], { cwd, allowFail: true });
      return r.code === 0 && r.stdout ? resolve(cwd, r.stdout) : null;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => process.stderr.write(`[crew worker] ${line}\n`),
    now: () => Date.now(),
  };
}

async function getAdapter(adapters, host) {
  if (!adapters) return null;
  if (typeof adapters.load === 'function') return adapters.load(host);
  return adapters[host] ?? null;
}

/** The worker loop. deps are stubbed in tests: { next, claim, release, viewIssue, spawn, adapters, ... }. */
export async function runWorker(opts, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const {
    host, area, tier = 'high', dry_run, wait,
    max_tasks = 5, max_failures = 3, task_timeout_min = 60,
  } = opts;

  const adapter = await getAdapter(d.adapters, host);
  if (!adapter?.headless) {
    return fail('unknown_host', `No adapter with headless() for: ${host}`, {
      cause_hint: 'adapters live in adapters/<host>/adapter.js',
      retry: 'crew worker --host codex  (or claude)',
      stop_when: 'the required host is not among the adapters',
    });
  }
  const { config, root } = d.loadConfig();
  const model = opts.model || config.tiers?.[tier]?.[host] || undefined;
  const agent = `${host}/${model || 'default'}`;

  const done = [];
  const failed = [];
  const handed = [];
  let failStreak = 0;
  let conflicts = 0;
  let stopped_reason = null;
  let started = 0;

  const prevAgent = process.env.CREW_AGENT;
  const prevAgentId = process.env.CREW_AGENT_ID;
  process.env.CREW_AGENT = agent; // the worker claim/release run as the same agent as the child process
  // Unique id: two workers of the same model on one machine are different agents (lease, review).
  const agentUid = `${agent}@${machineName()}-w${process.pid}`;
  process.env.CREW_AGENT_ID = agentUid;
  const result = (extra = {}) => ({ done, failed, blocked: handed, stopped_reason, agent, ...extra });

  try {
    while (started < max_tasks) {
      const nx = await call(d.next, { area, tier, tasks_only: true });
      if (nx.status === 'error') {
        if (nx.error?.code === 'paused') { stopped_reason = 'paused'; break; }
        return fail(nx.error?.code ?? 'next_failed', `Worker stopped: ${nx.summary}`, {
          ...(nx.error ?? {}),
          artifacts: result({ stopped_reason: 'next_failed' }),
        });
      }
      if (nx.status === 'warning' || !nx.artifacts?.issue) {
        if (wait) {
          d.log(`queue is empty, waiting ${WAIT_MS / 60_000} min`);
          await d.sleep(WAIT_MS);
          continue;
        }
        stopped_reason = 'no_tasks';
        break;
      }
      const id = nx.artifacts.issue;

      if (dry_run) {
        const spec = adapter.headless({ prompt: taskPrompt({ id }), model, cwd: '<worktree>', writableDirs: [] });
        return ok(`Dry run: would take #${id} and start ${host}`, {
          artifacts: { issue: id, agent, command: [spec.cmd, ...spec.args].join(' '), prompt: taskPrompt({ id }) },
          next_actions: [`crew worker --host ${host}${area ? ` --area ${area}` : ''} — run for real`],
        });
      }

      const cl = await call(d.claim, { id });
      if (cl.status === 'error') {
        const code = cl.error?.code;
        if (code === 'paused') { stopped_reason = 'paused'; break; }
        if (code === 'claim_conflict' || code === 'not_ready') {
          if (++conflicts >= 3) { stopped_reason = 'claim_conflicts'; break; }
          d.log(`#${id}: ${cl.summary} — taking the next one`);
          continue;
        }
        if (code === 'workspace_failed') {
          // the claim has already been rolled back (the task is ready again) — we count it as a failure and do not stop the worker.
          failed.push(id);
          failStreak++;
          d.log(`#${id}: ✖ ${cl.summary}, failures in a row: ${failStreak}/${max_failures}`);
          if (failStreak >= max_failures) { stopped_reason = 'max_failures'; break; }
          continue;
        }
        return fail(code ?? 'claim_failed', `Worker stopped: ${cl.summary}`, {
          ...(cl.error ?? {}),
          artifacts: result({ stopped_reason: 'claim_failed', issue: id }),
        });
      }
      conflicts = 0;
      started++;
      const worktree = cl.artifacts?.worktree ?? root;
      const commonDir = d.gitCommonDir?.(worktree);
      const spec = adapter.headless({
        prompt: taskPrompt({ id, branch: cl.artifacts?.branch }),
        model,
        cwd: worktree,
        writableDirs: commonDir ? [commonDir] : [],
      });
      const logFile = join(root, '.crew', 'logs', `worker-${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      d.log(`#${id}: starting ${agent} in ${worktree}`);
      const t0 = d.now();
      const res = await d.spawn(spec, {
        cwd: worktree,
        env: { ...spec.env, CREW_AGENT: agent, CREW_AGENT_ID: agentUid },
        timeoutMs: task_timeout_min * 60_000,
        logFile,
      });
      const took = fmtDuration(d.now() - t0);

      if (res.error) {
        await call(d.release, { id, note: `crew worker: could not start ${host}: ${res.error}` });
        failed.push(id);
        d.log(`#${id}: ✖ agent failed to start (${res.error})`);
        return fail('tool_missing', `Could not start ${host}: ${res.error}`, {
          cause_hint: `${spec.cmd} was not found or does not start; task #${id} was returned to the queue`,
          retry: 'crew doctor',
          stop_when: `${host} is not installed`,
          artifacts: result({ stopped_reason: 'spawn_failed' }),
        });
      }

      const issue = await call(d.viewIssue, id);
      const state = issue?.labels ? labelValue(issue, 'status') : null;
      const closed = issue?.state === 'CLOSED';

      if (closed || SUCCESS.includes(state)) {
        done.push(id);
        failStreak = 0;
        d.log(`#${id}: ✔ ${closed ? 'closed' : state} in ${took}`);
      } else if (HANDOFF.includes(state)) {
        handed.push({ issue: id, status: state });
        failStreak = 0;
        d.log(`#${id}: ! ${state} in ${took} — handoff to the issue`);
      } else {
        const why = res.timedOut ? `timeout ${task_timeout_min} min` : `agent exited with code ${res.code}, status ${state ?? 'unknown'}`;
        if (state === 'claimed') await call(d.release, { id, note: `crew worker: ${why}. Log: ${logFile}` });
        failed.push(id);
        failStreak++;
        d.log(`#${id}: ✖ ${why} (${took}), failures in a row: ${failStreak}/${max_failures}`);
        if (failStreak >= max_failures) { stopped_reason = 'max_failures'; break; }
      }
    }
    if (!stopped_reason) stopped_reason = 'max_tasks';
  } finally {
    if (prevAgent === undefined) delete process.env.CREW_AGENT;
    else process.env.CREW_AGENT = prevAgent;
    if (prevAgentId === undefined) delete process.env.CREW_AGENT_ID;
    else process.env.CREW_AGENT_ID = prevAgentId;
  }

  const reasonText = {
    paused: 'paused (issue crew:pause)',
    no_tasks: 'queue is empty',
    max_tasks: `task limit reached (${max_tasks})`,
    max_failures: `${max_failures} failures in a row`,
    claim_conflicts: '3 claim conflicts in a row',
  }[stopped_reason];
  const summary = `Worker ${agent} stopped: ${reasonText}. Delivered: ${done.length}, failures: ${failed.length}, handoffs: ${handed.length}`;
  const next_actions = {
    paused: ['wait until crew:pause is lifted and run crew worker again'],
    no_tasks: ['crew status — what is blocked', `crew worker --host ${host} --wait — wait for new tasks`],
    max_tasks: [`crew worker --host ${host} — next batch`],
    max_failures: ['read the logs in .crew/logs/worker-*.log and the comments on the tasks', 'crew status'],
    claim_conflicts: ['crew status — who else is claiming tasks', 'tell the human'],
  }[stopped_reason];
  const bad = stopped_reason === 'max_failures' || stopped_reason === 'claim_conflicts';
  return (bad ? warn : ok)(summary, { artifacts: result(), next_actions });
}

export default {
  name: 'worker',
  summary: 'Run an agent (claude/codex) without a UI: it takes tasks one at a time, a new session per task',
  agent: false,
  args: [
    { name: 'host', type: 'string', required: true, description: 'which agent: claude, codex' },
    { name: 'area', type: 'string', description: 'task area: web, api, ... (empty = any)' },
    { name: 'tier', type: 'string', enum: TIERS, description: 'model tier (default high); the model comes from crew.config.json → tiers' },
    { name: 'model', type: 'string', description: 'a specific model (overrides tier)' },
    { name: 'max_tasks', type: 'number', description: 'maximum number of tasks to take (default 5)' },
    { name: 'max_failures', type: 'number', description: 'stop after N failures in a row (default 3)' },
    { name: 'task_timeout_min', type: 'number', description: 'kill the agent after N minutes on a task (default 60)' },
    { name: 'wait', type: 'boolean', description: 'if the queue is empty — wait for new tasks (polls every 5 min)' },
    { name: 'dry_run', type: 'boolean', description: 'only show which task it would take and with which command' },
  ],
  run(opts) {
    return runWorker(opts);
  },
};
