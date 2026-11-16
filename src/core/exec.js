import { spawnSync } from 'node:child_process';
import { CrewError } from './output.js';
import { runSupervised } from './proc.js';

/** Run an external command without a shell (cross-platform, no injection). */
export function run(cmd, args = [], { cwd, allowFail = false, input } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    if (allowFail) return { code: -1, stdout: '', stderr: String(res.error.message) };
    throw new CrewError('tool_missing', `failed to run ${cmd}`, {
      cause_hint: res.error.message,
      retry: 'crew doctor',
      stop_when: `${cmd} is not installed`,
    });
  }
  const out = { code: res.status ?? -1, stdout: res.stdout?.trim() ?? '', stderr: res.stderr?.trim() ?? '' };
  if (out.code !== 0 && !allowFail) {
    // git and gh both say this when crew is started outside the project folder (a common slip on Windows terminals).
    if (/not a git repository/i.test(out.stderr)) {
      throw new CrewError('not_a_repo', `crew must run inside the project folder (a git clone); here: ${cwd ?? process.cwd()}`, {
        cause_hint: out.stderr.split('\n')[0],
        retry: 'cd into the project folder (PowerShell: cd D:\\path\\to\\project, no /d; cmd: cd /d D:\\path\\to\\project), then run the command again',
        stop_when: 'you do not know where the project is: ask the human',
      });
    }
    // gh says this in a project that was created locally (crew init) but is not on GitHub yet.
    if (/no git remotes found|none of the git remotes configured for this repository point to a known GitHub host/i.test(out.stderr)) {
      throw new CrewError('no_remote', 'This project is not connected to a GitHub repo yet, and crew keeps its tasks and PRs there', {
        cause_hint: out.stderr.split('\n')[0],
        retry: 'connect it: crew up <folder> --repo <owner>/<name> (creates the GitHub repo and pushes), or git remote add origin https://github.com/<owner>/<name>.git',
        stop_when: 'which GitHub repo to use is a human decision: ask them',
      });
    }
    throw new CrewError('command_failed', `${cmd} ${args.join(' ')} exited with code ${out.code}`, {
      cause_hint: out.stderr.split('\n').slice(0, 5).join(' | '),
      stop_when: 'the error repeats twice',
    });
  }
  return out;
}

/**
 * Run a config string (the user's check commands) through the shell.
 * timeout_s is how many seconds to wait; after that the process is killed (SIGKILL), timedOut: true.
 * Without a timeout a hung test or dev server blocks the agent forever.
 */
export function runShell(line, { cwd, timeout_s } = {}) {
  const timeoutMs = Number(timeout_s) > 0 ? Math.round(Number(timeout_s) * 1000) : undefined;
  // Via supervisor: on timeout the whole tree is killed (npm test, dev server), not just the shell.
  const r = runSupervised({ cmd: line, shell: true, cwd, timeoutMs });
  return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr || r.error || '', timedOut: !!r.timedOut };
}

export const git = (args, opts) => run('git', args, opts);

/** Current branch; also works in a new repo with no commits (unborn HEAD). */
export const currentBranch = (cwd) => git(['symbolic-ref', '--short', 'HEAD'], { cwd, allowFail: true }).stdout || 'HEAD';
export const gh = (args, opts) => run('gh', args, opts);
export const ghJson = (args, opts) => JSON.parse(gh(args, opts).stdout || 'null');
