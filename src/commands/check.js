// crew check — runs the check steps from crew.config.json and reports errors concisely;
// the full log goes to .crew/logs/, the result to .crew/last-check.json (required by crew pr open).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, fail } from '../core/output.js';
import { runShell, run, git, currentBranch } from '../core/exec.js';
import { loadConfig, agentId } from '../core/config.js';
import { checkLease } from '../core/lease.js';

const tail = (s, n = 20) => s.trim().split('\n').slice(-n).join('\n');

/** Default step timeout, in seconds (step field timeout_s). */
export const DEFAULT_TIMEOUT_S = 600;

/** Default test file names: pytest, jest/vitest/playwright, node --test. */
export const DEFAULT_TESTS_PATTERN = '(^test_.*\\.py$)|(_test\\.py$)|(\\.(test|spec)\\.[cm]?[jt]sx?$)';

/** How many test files are in a folder (recursive, excluding node_modules). */
export function countTests(dir, pattern = DEFAULT_TESTS_PATTERN) {
  if (!existsSync(dir)) return 0;
  const re = new RegExp(pattern);
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const parent = (e.parentPath ?? e.path ?? '').replace(/\\/g, '/');
    if (e.isFile() && re.test(e.name) && !parent.includes('/node_modules')) n++;
  }
  return n;
}

/**
 * Whether the run counts for crew pr open: all config steps passed (or were skipped by the rules).
 * A partial run (--only) does not count as green.
 */
/**
 * Is a command-line tool installed (docker, uv, go, ...)? Only plain names are checked.
 * Present = it starts at all: a non-zero exit (go and java reject --version) still means installed; only
 * "not found" means missing. On Windows npm/pnpm/yarn are .cmd shims that spawn without a shell cannot see,
 * so `where` is asked as well.
 */
export function hasTool(name, { exec = run, platform = process.platform } = {}) {
  if (!/^[\w.-]+$/.test(String(name))) return false;
  const r = exec(name, ['--version'], { allowFail: true });
  if (r.code !== -1 || !/ENOENT|not found|cannot find/i.test(r.stderr ?? '')) return true;
  return platform === 'win32' && exec('where', [name], { allowFail: true }).code === 0;
}

export function isFullRun(results = [], steps = []) {
  const names = new Set(results.map((r) => r.name));
  return steps.length > 0 && steps.every((s) => names.has(s.name)) && results.every((r) => r.ok);
}

export default {
  name: 'check',
  summary: 'Run the checks (linter, types, tests) from crew.config.json',
  usesCwd: true,
  args: [{ name: 'only', type: 'string', description: 'run only the step with this name' }],
  run({ only, cwd }, deps = {}) {
    const { config, root } = loadConfig(cwd);
    const all = config.check ?? [];
    const steps = all.filter((s) => !only || s.name === only);
    if (!steps.length) {
      return fail('no_checks', 'No check list is defined in crew.config.json', {
        cause_hint: 'the project is not configured yet',
        retry: 'add steps to "check": [{ "name": "test", "run": "npm test" }]',
        stop_when: 'you do not own the config — tell a human',
      });
    }
    const dir = join(root, '.crew', 'logs');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(dir, `check-${stamp}.txt`);
    // #13 (H5): we extend the lease BEFORE the steps too — a long check (up to timeout_s per step) could otherwise outlive the lease,
    // and sweep would return the task to the queue midway. After the steps — once more (at most once per 5 minutes).
    const id = Number(/^(?:crew|hk)\/(\d+)-/.exec(currentBranch(root))?.[1]) || null;
    const leaseCheck = deps.checkLease ?? checkLease;
    if (id) leaseCheck({ id, me: agentId() });
    const results = [];
    let log = '';
    for (const s of steps) {
      // when_exists: the step only makes sense if that part of the project already exists (web/package.json etc.)
      if (s.when_exists && !existsSync(join(root, s.when_exists))) {
        results.push({ name: s.name, ok: true, skipped: true, exit: 0, excerpt: '' });
        continue;
      }
      // requires: tools the step needs (e.g. docker). At the hackathon a Docker test in main blocked every
      // member without Docker. Locally a missing tool skips the step with a note; in CI (CI=true) it fails.
      const missing = (s.requires ?? []).filter((t) => !(deps.hasTool ?? hasTool)(t));
      if (missing.length) {
        if (process.env.CI) {
          results.push({ name: s.name, ok: false, exit: -1, missing_tools: missing, excerpt: `CI is missing required tools: ${missing.join(', ')}` });
          if (s.stop_on_fail !== false) break;
        } else {
          results.push({ name: s.name, ok: true, skipped: true, missing_tools: missing, exit: 0, excerpt: '' });
        }
        continue;
      }
      // tests_dir: a mandatory set (acceptance tests). While there are no tests (the very start) — skipped;
      // once there is at least one, the step must pass with exit code 0 ("no tests found" does not count).
      // An agent cannot delete existing acceptance tests — crew-guard catches that.
      const tests = s.tests_dir ? countTests(join(root, s.tests_dir), s.tests_pattern) : null;
      if (s.tests_dir && tests === 0) {
        results.push({ name: s.name, ok: true, skipped: true, no_tests: true, exit: 0, excerpt: '' });
        continue;
      }
      const timeout_s = Number(s.timeout_s) > 0 ? Number(s.timeout_s) : DEFAULT_TIMEOUT_S;
      const r = runShell(s.run, { cwd: join(root, s.cwd ?? '.'), timeout_s });
      const okCodes = s.tests_dir ? [0] : (s.ok_exit_codes ?? [0]);
      const passed = !r.timedOut && okCodes.includes(r.code);
      log += `\n===== ${s.name}: ${s.run} (${r.timedOut ? `timeout ${timeout_s} s` : `exit ${r.code}`})\n${r.stdout}\n${r.stderr}\n`;
      const output = tail(r.stdout + '\n' + r.stderr, r.timedOut ? 10 : 20);
      const excerpt = passed
        ? ''
        : r.timedOut
          ? `timeout: step "${s.name}" did not finish within ${timeout_s} s (timeout_s) and was stopped — is a test hung, waiting for input, or running a dev server?${output ? '\n' + output : ''}`
          : output;
      results.push({ name: s.name, ok: passed, exit: r.code, ...(tests !== null ? { tests } : {}), ...(r.timedOut ? { timed_out: true, timeout_s } : {}), excerpt });
      if (!passed && s.stop_on_fail !== false) break;
    }
    writeFileSync(logPath, log);
    const sha = git(['rev-parse', 'HEAD'], { cwd: root, allowFail: true }).stdout;
    const dirty = git(['status', '--porcelain'], { cwd: root, allowFail: true }).stdout !== '';
    const partial = !!only;
    const passedSteps = results.every((r) => r.ok) && results.length === steps.length;
    // green — only a full run of all config steps: `--only` does not unlock crew pr open.
    const green = !partial && isFullRun(results, all);
    writeFileSync(join(root, '.crew', 'last-check.json'), JSON.stringify({ sha, dirty, green, partial, at: new Date().toISOString(), results }, null, 2));

    // On a task branch, check also counts as activity: we extend the lease (at most once per 5 minutes).
    const lease = id ? leaseCheck({ id, me: agentId() }) : null;
    const leaseNote = lease?.state === 'lost' ? [`⚠ task #${id} is no longer yours (${lease.owner ?? 'returned to the queue'}) — crew commit and crew pr open will refuse; crew task claim ${id} if it is ready again`] : [];

    if (passedSteps) {
      const ran = results.filter((r) => !r.skipped).map((r) => r.name);
      const skipped = results.filter((r) => r.skipped).map((r) => (r.no_tests ? `${r.name} (no tests yet)` : r.missing_tools ? `${r.name} (needs ${r.missing_tools.join(', ')}: skipped here, CI runs it)` : r.name));
      const noTests = results.filter((r) => r.no_tests).map((r) => r.name);
      // Every step skipped (a fresh project, no tests yet): nothing failed, but nothing was verified either. Say so
      // instead of "green", so nobody reads it as "the code passes".
      const nothingRan = !ran.length;
      const headline = partial ? `Step ${only} is green (partial run — crew pr open needs a full crew check)`
        : nothingRan ? 'Nothing was verified: every check step was skipped' : 'All checks green';
      return ok(`${headline} (${ran.length ? ran.join(', ') : 'ran: none'}${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''})`, {
        status: partial || nothingRan || leaseNote.length ? 'warning' : 'success',
        artifacts: { log: logPath, sha, partial, green, verified: !nothingRan, ...(lease ? { lease: lease.state } : {}) },
        next_actions: [
          ...leaseNote,
          ...(nothingRan && !partial ? ['nothing ran: add tests (and code) for at least one step in crew.config.json → checks, then crew check again'] : []),
          ...(noTests.length ? [`no acceptance tests yet (${noTests.join(', ')}) — per AGENTS.md they are written in the task first commit`] : []),
          ...(partial ? ['crew check (full run)'] : dirty ? ['crew commit -m "..."', 'crew check (again, after the commit)', 'crew pr open'] : ['crew pr open']),
        ],
      });
    }
    const failed = results.filter((r) => !r.ok);
    const timedOut = failed.filter((f) => f.timed_out).map((f) => f.name);
    return fail('ci_red', `Failed: ${failed.map((f) => (f.timed_out ? `${f.name} (timeout)` : f.name)).join(', ')}`, {
      cause_hint: failed[0].excerpt,
      retry: 'fix and run crew check again',
      stop_when: 'the same error 3 times in a row → crew task status <id> blocked --note "..."',
      artifacts: { log: logPath, failed: failed.map((f) => f.name), ...(timedOut.length ? { timed_out: timedOut } : {}) },
    });
  },
};
