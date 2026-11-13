// crew eval — compare agents (Claude, Codex, and their models) on the same tasks.
// The task format is close to agent-eval (name, description, repo, files, prompt, judge, commit), but in JSON —
// with no YAML dependency. The format mapping is in evals/README.md.
//
// For each task × agent × run: a fresh copy of the repo fixture in a temp folder →
// adapter.headless({ prompt, model, cwd }) → deterministic judges (command / grep) → pass/fail,
// time, cost (if the agent reports it). Report: pass@1, pass@k, consistency, average time.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { ok, warn, fail } from '../core/output.js';
import { run } from '../core/exec.js';
import { runSupervised } from '../core/proc.js';
import { loadConfig, HARNESS_ROOT } from '../core/config.js';
import { humanMs, table } from '../core/metrics.js';
import { loadAdapter } from './adapters.js';

export const JUDGE_TYPES = ['command', 'grep', 'pytest']; // pytest is a synonym for command, as in agent-eval
export const JUDGE_DIR = '.crew-eval'; // where the hidden judge files (judge_files) are placed after the agent finishes
export const BASE_TAG = 'crew-eval-base'; // git tag of the initial state of the working copy
const DEFAULT_TIMEOUT_S = 900;
const JUDGE_TIMEOUT_S = 300;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

// ---------- tasks ----------

/** Validate one task. Returns a list of errors (empty — the task is valid). */
export function validateTask(t, { dir = '.' } = {}) {
  const errs = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['a task must be a JSON object'];
  if (typeof t.name !== 'string' || !NAME_RE.test(t.name)) errs.push('name: a string of a-z, 0-9, ".", "_", "-"');
  if (typeof t.prompt !== 'string' || !t.prompt.trim()) errs.push('prompt: a non-empty string');
  if (t.description !== undefined && typeof t.description !== 'string') errs.push('description: a string');
  if (typeof t.repo !== 'string' || !t.repo) errs.push('repo: path to the repo fixture (relative to the task file)');
  else if (!existsSync(resolve(dir, t.repo))) errs.push(`repo: folder ${t.repo} does not exist`);
  if (t.commit !== undefined && t.commit !== null && !(typeof t.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(t.commit))) {
    errs.push('commit: a sha (7–40 hex) or absent');
  }
  if (t.files !== undefined && !(Array.isArray(t.files) && t.files.every((f) => typeof f === 'string'))) errs.push('files: an array of strings');
  if (t.judge_files !== undefined) {
    if (!(Array.isArray(t.judge_files) && t.judge_files.every((f) => typeof f === 'string'))) errs.push('judge_files: an array of strings');
    else for (const f of t.judge_files) if (!existsSync(resolve(dir, f))) errs.push(`judge_files: file ${f} does not exist`);
  }
  if (t.timeout_s !== undefined && !(Number.isFinite(t.timeout_s) && t.timeout_s > 0)) errs.push('timeout_s: a number > 0');
  if (!Array.isArray(t.judge) || !t.judge.length) errs.push('judge: a non-empty array of judges');
  else {
    t.judge.forEach((j, i) => {
      const at = `judge[${i}]`;
      if (j?.type === 'llm') return errs.push(`${at}.type: llm judges are not deterministic and not supported — use command or grep`);
      if (!j || !JUDGE_TYPES.includes(j.type)) return errs.push(`${at}.type: one of ${JUDGE_TYPES.join(', ')}`);
      if (j.type !== 'grep' && (typeof j.command !== 'string' || !j.command.trim())) errs.push(`${at}.command: a string`);
      if (j.expect_exit !== undefined && !Number.isInteger(j.expect_exit)) errs.push(`${at}.expect_exit: an integer`);
      if (j.type === 'grep') {
        if (typeof j.pattern !== 'string' || !j.pattern) errs.push(`${at}.pattern: a string (regular expression)`);
        else {
          try {
            new RegExp(j.pattern, j.flags ?? '');
          } catch (e) {
            errs.push(`${at}.pattern: ${e.message}`);
          }
        }
        const files = j.files ?? t.files;
        if (!(Array.isArray(files) ? files.length && files.every((f) => typeof f === 'string') : typeof files === 'string')) {
          errs.push(`${at}.files: a string or an array (or files on the task)`);
        }
      }
    });
  }
  return errs;
}

/** Find and validate tasks: a folder with *.json or a single file. → { tasks, errors } */
export function loadTasks(path, { only } = {}) {
  if (!existsSync(path)) return { tasks: [], errors: [{ file: path, errors: ['no such file or folder'] }] };
  const files = statSync(path).isDirectory()
    ? readdirSync(path).filter((f) => f.endsWith('.json')).sort().map((f) => join(path, f))
    : [path];
  const tasks = [];
  const errors = [];
  const seen = new Set();
  for (const file of files) {
    let t;
    try {
      t = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push({ file, errors: [`not JSON: ${e.message}`] });
      continue;
    }
    const dir = dirname(file);
    const errs = validateTask(t, { dir });
    if (!errs.length && seen.has(t.name)) errs.push(`name: "${t.name}" already exists in another file`);
    if (errs.length) {
      errors.push({ file, errors: errs });
      continue;
    }
    seen.add(t.name);
    if (only && !only.includes(t.name)) continue;
    tasks.push({ ...t, file, dir, repoPath: resolve(dir, t.repo) });
  }
  return { tasks, errors };
}

/** "claude,codex:gpt-5,claude:opus" → [{ key, host, model }] */
export function parseAgents(spec) {
  return String(spec ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((key) => {
      const [host, ...rest] = key.split(':');
      return { key, host, model: rest.join(':') || undefined };
    });
}

// ---------- run ----------

const gitq = (args, cwd) => run('git', ['-c', 'user.email=crew-eval@localhost', '-c', 'user.name=crew eval', '-c', 'core.autocrlf=false', ...args], { cwd });

/**
 * A fresh copy of the repo fixture. With commit — a clone of the repo containing the fixture, at that commit;
 * without commit — a copy of the current folder state + git init (agents need a clean git repo).
 * → { workdir, tmp, cleanup }
 */
export function prepareRepo(task, { keep = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), `crew-eval-${task.name}-`));
  const cleanup = () => {
    if (!keep) rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    const dest = join(tmp, 'repo');
    let workdir = dest;
    if (task.commit) {
      const top = run('git', ['rev-parse', '--show-toplevel'], { cwd: task.repoPath }).stdout;
      gitq(['clone', '-q', '--no-checkout', top, dest], tmp);
      gitq(['checkout', '-q', '--detach', task.commit], dest);
      workdir = join(dest, relative(realpathSync.native(top), realpathSync.native(task.repoPath))); // Windows: 8.3 names
    } else {
      cpSync(task.repoPath, dest, { recursive: true, filter: (src) => !['node_modules', '.git', JUDGE_DIR].includes(basename(src)) });
      gitq(['init', '-q'], dest);
      gitq(['add', '-A'], dest);
      gitq(['commit', '-q', '--no-verify', '-m', `eval: ${task.name}`], dest);
    }
    // judges compare against the initial state: git diff crew-eval-base -- <path> (also sees what the agent committed)
    gitq(['tag', BASE_TAG], dest);
    return { workdir, tmp, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Environment for the agent and judges: without NODE_TEST_CONTEXT (otherwise a nested node --test is always "green"). */
function cleanEnv(extra = {}) {
  const env = { ...process.env, CREW_METRICS: 'off', ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Judges and the agent run through a supervisor: on timeout the whole process tree is killed.
const shellRun = (line, cwd, timeoutS) => {
  const r = runSupervised({ cmd: line, shell: true, cwd, env: cleanEnv(), timeoutMs: timeoutS * 1000 });
  return { code: r.code, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim(), timedOut: !!r.timedOut };
};

const lastLines = (s, n = 8) => s.split(/\r?\n/).slice(-n).join('\n');

/** Glob to regex: ** — any folders, * and ? — within a single name. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Working copy files (paths with /) matching the glob; excluding .git and node_modules. */
function globFiles(workdir, glob) {
  const re = globToRegExp(glob.replaceAll('\\', '/'));
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(workdir, rel), { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (re.test(p)) out.push(p);
    }
  };
  walk('');
  return out.sort();
}

/** Run the task judges in the working copy. → [{ type, pass, detail }] */
export function runJudges(task, workdir) {
  if (task.judge_files?.length) {
    mkdirSync(join(workdir, JUDGE_DIR), { recursive: true });
    for (const f of task.judge_files) cpSync(resolve(task.dir, f), join(workdir, JUDGE_DIR, basename(f)));
  }
  return task.judge.map((j) => {
    if (j.type !== 'grep') {
      const r = shellRun(j.command, workdir, j.timeout_s ?? JUDGE_TIMEOUT_S);
      const pass = r.code === (j.expect_exit ?? 0);
      return { type: j.type, command: j.command, pass, detail: r.timedOut ? 'timeout' : pass ? `exit ${r.code}` : `exit ${r.code}: ${lastLines(r.out)}` };
    }
    const files = [].concat(j.files ?? task.files).flatMap((f) => (/[*?]/.test(f) ? globFiles(workdir, f) : [f]));
    const re = new RegExp(j.pattern, j.flags ?? '');
    const hits = files.filter((f) => {
      try {
        return re.test(readFileSync(join(workdir, f), 'utf8'));
      } catch {
        return false; // no file = no match
      }
    });
    const pass = j.absent ? hits.length === 0 : hits.length > 0;
    return { type: 'grep', pattern: j.pattern, pass, detail: hits.length ? `found in ${hits.join(', ')}` : 'not found' };
  });
}

/** Cost from the agent output (claude --output-format json → total_cost_usd). None — null. */
export function extractCost(stdout) {
  const pick = (o) => {
    if (!o || typeof o !== 'object') return null;
    for (const k of ['total_cost_usd', 'cost_usd', 'costUsd']) if (Number.isFinite(o[k])) return o[k];
    return pick(o.usage) ?? pick(o.result && typeof o.result === 'object' ? o.result : null);
  };
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    const whole = JSON.parse(text);
    const c = Array.isArray(whole) ? whole.map(pick).filter((x) => x !== null).at(-1) ?? null : pick(whole);
    if (c !== null) return c;
  } catch {
    /* not a single JSON — try JSONL */
  }
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const c = pick(JSON.parse(line));
      if (c !== null) return c;
    } catch {
      /* not a JSON line */
    }
  }
  return null;
}

/** Run the agent in the working copy as described by the adapter. */
function runAgent(agent, task, workdir) {
  const spec = agent.adapter.headless({ prompt: task.prompt, model: agent.model, cwd: workdir });
  const timeoutS = task.timeout_s ?? DEFAULT_TIMEOUT_S;
  const r = runSupervised({
    cmd: spec.cmd,
    args: spec.args ?? [],
    shell: false,
    cwd: spec.cwd ?? workdir,
    env: cleanEnv(spec.env ?? {}),
    input: spec.input,
    timeoutMs: timeoutS * 1000,
  });
  if (r.error && !r.timedOut) {
    return { spawnError: `${spec.cmd}: ${r.error}`, exit: -1, stdout: '' };
  }
  return { exit: r.code, timedOut: !!r.timedOut, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Run: tasks × agents × runs. agents: [{ key, model?, adapter }] — an adapter with headless().
 * If the agent fails to start (no binary), its remaining runs are skipped with the same error.
 * → [{ task, agent, run, pass, judges, duration_ms, cost_usd, exit, error }]
 */
export function runEval({ tasks, agents, runs = 1, keep = false, log = () => {} }) {
  const results = [];
  for (const agent of agents) {
    let broken = null;
    for (const task of tasks) {
      for (let i = 1; i <= runs; i++) {
        const base = { task: task.name, agent: agent.key, run: i };
        if (broken) {
          results.push({ ...base, pass: false, judges: [], duration_ms: null, cost_usd: null, exit: null, error: broken });
          continue;
        }
        log(`→ ${agent.key} · ${task.name} · run ${i}/${runs}`);
        let repo;
        try {
          repo = prepareRepo(task, { keep });
        } catch (e) {
          results.push({ ...base, pass: false, judges: [], duration_ms: null, cost_usd: null, exit: null, error: `prepare: ${e.message}` });
          continue;
        }
        try {
          const t0 = Date.now();
          const r = runAgent(agent, task, repo.workdir);
          const duration_ms = Date.now() - t0;
          if (r.spawnError) {
            broken = `agent_failed: ${r.spawnError}`;
            results.push({ ...base, pass: false, judges: [], duration_ms, cost_usd: null, exit: -1, error: broken });
            continue;
          }
          const judges = runJudges(task, repo.workdir);
          const pass = !r.timedOut && judges.every((j) => j.pass);
          results.push({
            ...base,
            pass,
            judges,
            duration_ms,
            cost_usd: extractCost(r.stdout),
            exit: r.exit,
            error: r.timedOut ? `timeout: ${task.timeout_s ?? DEFAULT_TIMEOUT_S}s` : null,
            ...(keep ? { workdir: repo.workdir } : {}),
          });
          log(`  ${pass ? 'PASS' : 'FAIL'} in ${humanMs(duration_ms)}`);
        } finally {
          repo.cleanup();
        }
      }
    }
  }
  return results;
}

// ---------- scoring ----------

/** Unbiased pass@k estimate (Chen et al., 2021): n runs, c successful. */
export function passAtK(n, c, k) {
  if (!n || k <= 0) return null;
  k = Math.min(k, n);
  if (n - c < k) return 1;
  let miss = 1;
  for (let i = n - c + 1; i <= n; i++) miss *= 1 - k / i;
  return 1 - miss;
}

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/**
 * Pure scoring of the run results.
 *   pass_at_1    share of successful runs
 *   pass_at_k    at least one success out of k = number of runs (unbiased estimate)
 *   consistency  share of runs matching the majority (1 — the agent behaves identically)
 * → { by_task: [{ agent, task, ... }], by_agent: [{ agent, ... }] }
 */
export function score(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.agent}\u0000${r.task}`;
    if (!groups.has(key)) groups.set(key, { agent: r.agent, task: r.task, list: [] });
    groups.get(key).list.push(r);
  }
  const by_task = [...groups.values()].map(({ agent, task, list }) => {
    const n = list.length;
    const c = list.filter((r) => r.pass).length;
    const times = list.map((r) => r.duration_ms).filter(Number.isFinite);
    const costs = list.map((r) => r.cost_usd).filter(Number.isFinite);
    return {
      agent,
      task,
      runs: n,
      passes: c,
      k: n,
      pass_at_1: r2(c / n),
      pass_at_k: r2(passAtK(n, c, n)),
      consistency: r2(Math.max(c, n - c) / n),
      avg_time_ms: times.length ? Math.round(mean(times)) : null,
      avg_cost_usd: costs.length ? Math.round(mean(costs) * 10_000) / 10_000 : null,
      errors: list.filter((r) => r.error).length,
    };
  });
  const agents = [...new Set(by_task.map((t) => t.agent))];
  const by_agent = agents.map((agent) => {
    const rows = by_task.filter((t) => t.agent === agent);
    const runsOf = results.filter((r) => r.agent === agent);
    const times = runsOf.map((r) => r.duration_ms).filter(Number.isFinite);
    const costs = runsOf.map((r) => r.cost_usd).filter(Number.isFinite);
    return {
      agent,
      tasks: rows.length,
      runs: runsOf.length,
      // the per-task average is computed from exact values, not rounded ones
      pass_at_1: r2(mean(rows.map((t) => t.passes / t.runs))),
      pass_at_k: r2(mean(rows.map((t) => passAtK(t.runs, t.passes, t.k)))),
      consistency: r2(mean(rows.map((t) => Math.max(t.passes, t.runs - t.passes) / t.runs))),
      avg_time_ms: times.length ? Math.round(mean(times)) : null,
      total_cost_usd: costs.length ? Math.round(costs.reduce((s, x) => s + x, 0) * 10_000) / 10_000 : null,
    };
  });
  return { by_task, by_agent };
}

const fmt = (x) => (x == null ? null : x.toFixed(2));
const usd = (x) => (x == null ? null : `$${x}`);

export function reportTable({ by_task, by_agent }) {
  const k = by_task[0]?.k ?? 1;
  const tasks = table(
    ['agent', 'task', 'pass@1', `pass@${k}`, 'consistency', 'time', 'cost'],
    by_task.map((t) => [t.agent, t.task, fmt(t.pass_at_1), fmt(t.pass_at_k), fmt(t.consistency), humanMs(t.avg_time_ms), usd(t.avg_cost_usd)]),
  );
  const agents = table(
    ['agent', 'tasks', 'pass@1', `pass@${k}`, 'consistency', 'avg time', 'total $'],
    by_agent.map((a) => [a.agent, a.tasks, fmt(a.pass_at_1), fmt(a.pass_at_k), fmt(a.consistency), humanMs(a.avg_time_ms), usd(a.total_cost_usd)]),
  );
  return `${tasks}\n\nTotals per agent:\n${agents}`;
}

// ---------- command ----------

/** Path to the tasks: as given (relative to cwd), otherwise inside the harness (the built-in evals/tasks). */
function resolveTasksPath(p) {
  const own = resolve(p);
  if (existsSync(own)) return own;
  const inHarness = resolve(HARNESS_ROOT, p);
  return existsSync(inHarness) ? inHarness : own;
}

export default {
  name: 'eval',
  summary: 'Compare agents on reference tasks: pass@1, pass@k, consistency, time, cost',
  agent: false,
  args: [
    { name: 'agents', type: 'string', description: 'who to compare: claude,codex or with a model claude:opus,codex:gpt-5 (default — hosts from the config)' },
    { name: 'tasks', type: 'string', description: 'folder with *.json tasks or a single file (default evals/tasks)' },
    { name: 'task', type: 'string', description: 'only these tasks (comma-separated)' },
    { name: 'runs', type: 'number', description: 'runs per task and agent (default 3)' },
    { name: 'dry_run', type: 'boolean', description: 'only validate tasks and show the plan; do not run agents' },
    { name: 'keep', type: 'boolean', description: 'do not delete working copies (for analyzing failures)' },
  ],
  async run({ agents: agentSpec, tasks: tasksPath = 'evals/tasks', task, runs = 3, dry_run, keep } = {}) {
    const { config, root } = loadConfig();
    if (!Number.isInteger(runs) || runs < 1) {
      return fail('bad_input', '--runs: an integer ≥ 1', { retry: 'crew eval --runs 3' });
    }
    const dir = resolveTasksPath(tasksPath);
    const only = task ? String(task).split(',').map((s) => s.trim()).filter(Boolean) : null;
    const { tasks, errors } = loadTasks(dir, { only });
    if (errors.length) {
      return fail('bad_task', `Errors in eval tasks: ${errors.length}`, {
        cause_hint: errors.map((e) => `${relative(process.cwd(), e.file) || e.file}: ${e.errors.join('; ')}`).join(' | '),
        retry: 'fix the task files and run crew eval --dry-run again',
        stop_when: 'the format is unclear — see evals/README.md',
        artifacts: { errors },
      });
    }
    if (!tasks.length) {
      return fail('no_tasks', only ? `No tasks named: ${only.join(', ')}` : `No *.json tasks in ${dir}`, {
        cause_hint: 'wrong folder or --task filter',
        retry: 'crew eval --tasks evals/tasks --dry-run',
      });
    }

    const agentList = parseAgents(agentSpec === undefined || agentSpec === true ? (config.hosts ?? []).join(',') : agentSpec);
    if (!agentList.length) return fail('bad_input', 'No agents specified', { retry: 'crew eval --agents claude,codex' });
    const missing = [];
    for (const a of agentList) {
      a.adapter = await loadAdapter(a.host);
      if (typeof a.adapter?.headless !== 'function') missing.push(a.host);
    }
    if (missing.length) {
      return fail('unknown_agent', `No adapter with headless() for: ${[...new Set(missing)].join(', ')}`, {
        cause_hint: 'the host is written as a folder name in adapters/: claude, codex',
        retry: 'crew eval --agents claude,codex --dry-run',
        stop_when: 'a new host is needed — add adapters/<host>/adapter.js',
      });
    }

    const total = tasks.length * agentList.length * runs;
    if (dry_run) {
      const plan = tasks.map((t) => ({
        task: t.name,
        repo: (relative(process.cwd(), t.repoPath) || '.').replaceAll('\\', '/'),
        commit: t.commit ?? 'current state',
        judges: t.judge.map((j) => (j.type !== 'grep' ? `${j.type}: ${j.command}` : `grep${j.absent ? ' (absent)' : ''}: ${j.pattern}`)),
      }));
      const t = table(['task', 'repo', 'commit', 'judges'], plan.map((p) => [p.task, p.repo, p.commit, p.judges.length]));
      return ok(`Eval plan: ${tasks.length} tasks × ${agentList.length} agents × ${runs} runs = ${total} launches (tasks are valid)\n${t}`, {
        artifacts: { tasks: plan, agents: agentList.map((a) => a.key), runs, total },
        next_actions: [`crew eval --agents ${agentList.map((a) => a.key).join(',')} --runs ${runs}`],
      });
    }

    const results = runEval({ tasks, agents: agentList, runs, keep, log: (s) => process.stderr.write(s + '\n') });
    const scored = score(results);
    const outDir = join(root, '.crew', 'evals');
    mkdirSync(outDir, { recursive: true });
    const report = join(outDir, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), runs, agents: agentList.map((a) => a.key), ...scored, raw: results }, null, 2));

    const broken = [...new Set(results.filter((r) => r.error?.startsWith('agent_failed')).map((r) => r.agent))];
    const summary = `Eval: ${total} launches, ${results.filter((r) => r.pass).length} successful\n${reportTable(scored)}`;
    const artifacts = { results: scored.by_task, agents: scored.by_agent, report };
    if (broken.length) {
      return warn(summary, {
        artifacts,
        next_actions: [
          `failed to start: ${broken.join(', ')} — check crew doctor and that the binary is on PATH`,
          'on Windows .cmd wrappers (npm i -g) do not run without a shell — a native binary or WSL/CI is needed',
        ],
      });
    }
    return ok(summary, { artifacts, next_actions: [`analyze the failures: ${report}`, 'crew eval --keep --task <name> — keep the working copies'] });
  },
};
