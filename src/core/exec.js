import { spawnSync } from 'node:child_process';
import { CrewError } from './output.js';
import { runSupervised } from './proc.js';
import { ghViaRest } from './ghrest.js';

/** Use the REST layer for gh issue/pr/repo/label? In Claude Code cloud sessions (GraphQL is blocked there), or on request. */
export const restMode = (env = process.env) => env.CREW_GH_REST === '1' || (env.CLAUDE_CODE_REMOTE === 'true' && env.CREW_GH_REST !== '0');

/**
 * owner/name of the repo for REST paths. gh fills {owner}/{repo} from a github.com remote, but in a cloud session
 * origin may point at a git proxy (…/git/owner/name): its last two path parts are still the repo. GH_REPO wins.
 */
export function repoFromRemote(url = '', env = process.env) {
  if (env.GH_REPO && /^[\w.-]+\/[\w.-]+$/.test(env.GH_REPO)) return env.GH_REPO;
  const m = /([\w.-]+)[/:]([\w.-]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m && !/^\d+$/.test(m[1]) ? `${m[1]}/${m[2]}` : null;
}

/** gh api through the real gh (REST only), for the REST layer: → { code, data, stderr }. */
function restApi(cwd) {
  let repo;
  const resolveRepo = () => {
    if (repo !== undefined) return repo;
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', shell: false, windowsHide: true });
    return (repo = r.status === 0 ? repoFromRemote(r.stdout) : null);
  };
  return (method, rawPath, body) => {
    const own = rawPath.includes('{owner}/{repo}') ? resolveRepo() : null;
    const path = own ? rawPath.replace('{owner}/{repo}', own) : rawPath;
    const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json'];
    if (body !== undefined) args.push('--input', '-');
    const r = spawnSync('gh', args, { cwd, input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { code: -1, data: null, stderr: String(r.error.message) };
    let data = null;
    try { data = r.stdout ? JSON.parse(r.stdout) : null; } catch { data = null; }
    return { code: r.status ?? -1, data, stderr: (r.stderr || r.stdout || '').trim() };
  };
}

/** Run an external command without a shell (cross-platform, no injection). */
export function run(cmd, args = [], { cwd, allowFail = false, input } = {}) {
  // gh issue / gh pr where GraphQL is blocked: the same command over REST, the same JSON back
  const viaRest = cmd === 'gh' && args[0] !== 'api' && restMode() ? ghViaRest(args, { api: restApi(cwd), input }) : null;
  const res = viaRest ? { status: viaRest.code, stdout: viaRest.stdout, stderr: viaRest.stderr } : spawnSync(cmd, args, {
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
    // Claude Code cloud sessions reach GitHub through a proxy that blocks GraphQL (gh issue / gh pr); only gh api (REST)
    // gets through. Say so instead of a bare 403, so the agent does not retry it or work around crew.
    const blocked = graphqlBlocked(cmd, args, out.stderr);
    if (blocked) throw blocked;
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

/** Running inside a Claude Code cloud session (claude.ai/code)? */
export const cloudSession = (env = process.env) => env.CLAUDE_CODE_REMOTE === 'true';

/**
 * A gh failure that is the cloud session's GitHub proxy refusing GraphQL (gh issue / gh pr), not a crew or GitHub
 * problem. → a CrewError saying so, or null.
 */
export function graphqlBlocked(cmd, args = [], stderr = '', env = process.env) {
  if (cmd !== 'gh' || !cloudSession(env) || args[0] === 'api' || !/\b403\b|forbidden/i.test(stderr)) return null;
  return new CrewError('gh_graphql_blocked', `gh ${args.slice(0, 2).join(' ')} is blocked in this cloud session (GitHub GraphQL returns 403 here)`, {
    cause_hint: 'Claude Code on the web allows only REST calls (gh api) through its GitHub proxy; this crew command still uses gh issue / gh pr',
    retry: 'run this step on a machine with crew (crew up --join), or ask the human; do not bypass crew with plain git pushes',
    stop_when: 'immediately: tell the human that crew is not usable in this cloud session yet',
  });
}

export const git = (args, opts) => run('git', args, opts);

/** Current branch; also works in a new repo with no commits (unborn HEAD). */
export const currentBranch = (cwd) => git(['symbolic-ref', '--short', 'HEAD'], { cwd, allowFail: true }).stdout || 'HEAD';
export const gh = (args, opts) => run('gh', args, opts);
export const ghJson = (args, opts) => JSON.parse(gh(args, opts).stdout || 'null');
