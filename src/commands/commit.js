// crew commit — git commit with mandatory trailers (Agent, Issue) so the origin of the code is visible.
// Only on a task branch crew/<id>-*, only while the task is yours (lease), and without secret-looking files.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ok, fail } from '../core/output.js';
import { git, currentBranch } from '../core/exec.js';
import { loadConfig, agentId } from '../core/config.js';
import { checkLease, leaseLostError } from '../core/lease.js';
import { issueFromBranch } from './pr.js';

/** Files that are almost always secrets or dumps (by name). */
const SECRET_FILES = [
  [/(^|\/)\.env(\.[^/]*)?$/i, '.env file'],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, 'key/certificate'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, 'SSH key'],
  [/(^|\/)(credentials|service[-_]?account|secrets?)[^/]*\.(json|ya?ml|toml)$/i, 'credentials file'],
  [/\.(sqlite3?|db|dump)$/i, 'database / dump'],
];
const SECRET_FILE_OK = [/(^|\/)\.env\.(example|sample|template)$/i];

/** Lines that look like tokens and keys (in added diff lines). */
const SECRET_TEXT = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'GitHub token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, 'OpenAI API key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
];

/**
 * Simple index check before committing (pure function).
 * names — paths from `git diff --cached --name-only`; diff — `git diff --cached -U0`.
 * → [{ file, reason }]
 */
export function scanStaged(names = [], diff = '') {
  const hits = [];
  for (const f of names) {
    const p = f.replace(/\\/g, '/');
    if (SECRET_FILE_OK.some((re) => re.test(p))) continue;
    const m = SECRET_FILES.find(([re]) => re.test(p));
    if (m) hits.push({ file: p, reason: m[1] });
  }
  let file = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
    // Template names are allowed, but their contents must still be scanned for credentials.
    else if (line.startsWith('+') && file) {
      const m = SECRET_TEXT.find(([re]) => re.test(line));
      if (m && !hits.some((h) => h.file === file && h.reason === m[1])) hits.push({ file, reason: m[1] });
    }
  }
  return hits;
}

export default {
  name: 'commit',
  summary: 'Commit everything with Agent/Issue trailers (task branch only, no secrets)',
  usesCwd: true,
  args: [{ name: 'm', type: 'string', required: true, description: 'commit message (Conventional Commits: feat: ..., fix: ...)' }],
  run({ m, cwd }, deps = {}) {
    const { root } = loadConfig(cwd);
    const branch = currentBranch(root);
    const id = issueFromBranch(branch);
    if (!id) {
      return fail('not_task_branch', `Branch ${branch} is not a task branch crew/<number>-...`, {
        cause_hint: 'commits to main and to arbitrary branches are forbidden (AGENTS.md): work happens only from a claimed task',
        retry: 'crew task next → crew task claim <id> → work in the issued worktree',
        stop_when: 'this is project setup by a human — then use a plain git commit',
      });
    }
    const me = agentId();
    const lease = (deps.checkLease ?? checkLease)({ id, me });
    if (lease.state === 'lost') return leaseLostError(fail, id, lease, me);

    git(['add', '-A'], { cwd: root });
    // .crew/ is gitignored (local state), but before/after screenshots belong to the PR (crew shots).
    if (existsSync(join(root, '.crew', 'shots'))) git(['add', '-f', '--', '.crew/shots'], { cwd: root });
    const names = git(['diff', '--cached', '--name-only'], { cwd: root }).stdout.split('\n').filter(Boolean);
    if (!names.length) return fail('nothing_to_commit', 'Nothing to commit', { retry: 'crew check' });
    const hits = scanStaged(names, git(['diff', '--cached', '-U0', '--no-color'], { cwd: root }).stdout);
    if (hits.length) {
      git(['reset', '-q'], { cwd: root }); // unstage; leave the files untouched
      return fail('secret_suspected', `Looks like secrets, commit not made: ${hits.map((h) => `${h.file} (${h.reason})`).join(', ')}`, {
        cause_hint: 'secrets belong only in .env (gitignored); the repo holds .env.example with empty values',
        retry: 'remove the file/line (or add the file to .gitignore) and run crew commit -m "..." again',
        stop_when: 'it is definitely not a secret (test fixture) — rename the value so it does not look like a key; do not bypass the check',
        artifacts: { hits },
      });
    }
    const trailers = [`Agent: ${me}`, `Issue: #${id}`];
    git(['commit', '-m', m, '-m', trailers.join('\n')], { cwd: root });
    const sha = git(['rev-parse', '--short', 'HEAD'], { cwd: root }).stdout;
    return ok(`Commit ${sha}: ${m}`, {
      status: lease.state === 'unknown' ? 'warning' : 'success',
      artifacts: { sha, issue: id, lease: lease.state, heartbeat: !!lease.heartbeat },
      next_actions: [
        ...(lease.state === 'unknown' ? [`could not verify the lease (${lease.error}) — extend it manually: crew task heartbeat ${id}`] : []),
        'crew check',
        'crew pr open',
      ],
    });
  },
};
