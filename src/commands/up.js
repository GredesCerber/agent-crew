// crew up — set everything up with one command (run by an agent following docs/AGENT-SETUP.md).
//   Captain:   crew up <dir> --repo owner/name [--stack web-node] [--public] [--invite a,b] [--start ISO --end ISO]
//              project → event.json → first commit → GitHub repo → invitations → main protection, labels, CREW_HARNESS.
//   Member:    crew up --join owner/name [<dir>]
//              accept the invitation → clone → agent configs → check the machine.
// Every step first checks whether it is already done, so a re-run continues from the point of failure.
// What needs a human (account sign-in, CI access to the package) the command does not do — it returns it in human_steps.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ok, warn, fail } from '../core/output.js';
import { run } from '../core/exec.js';
import { loadConfig } from '../core/config.js';
import init from './init.js';
import adapters from './adapters.js';
import github, { DEFAULT_HARNESS, REPO_RE } from './github.js';
import { mainProtected } from './pr.js';

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const EVENT_PATH = 'events/event.json';

/** «a, b,@c» → { logins: ['a','b','c'], bad: [...] }. */
export function parseInvite(s = '') {
  const all = String(s ?? '').split(/[,\s]+/).map((x) => x.replace(/^@/, '').trim()).filter(Boolean);
  return { logins: [...new Set(all.filter((x) => LOGIN_RE.test(x)))], bad: all.filter((x) => !LOGIN_RE.test(x)) };
}

/** Contents of events/event.json (pure function). */
export function eventFile({ name, start = '', end = '', team = [] }) {
  return {
    name,
    rules_url: '',
    start: start ?? '',
    end: end ?? '',
    ai_allowed: true,
    ai_disclosure_required: true,
    prebuilt_code: 'tooling_only',
    team_members: [...new Set(team)],
  };
}

/** How to start the agent (Codex does not take CREW_AGENT from the MCP config into its shell — without it CLI calls would be human@…). */
export function launchHints(hosts = [], root = '.', platform = process.platform) {
  const out = [];
  if (hosts.includes('claude')) out.push(`Claude Code: open the folder ${root} in the Claude app (Code tab) or cd ${root} && claude — CLAUDE.md and the crew MCP are picked up automatically`);
  if (hosts.includes('codex')) {
    out.push(platform === 'win32'
      ? `Codex: cd ${root}; $env:CREW_AGENT='codex'; codex — and confirm trust for the project`
      : `Codex: cd ${root} && CREW_AGENT=codex codex — and confirm trust for the project`);
  }
  out.push('first message to the agent: "Work through the crew-workflow cycle: take tasks from the queue and do them until they run out."');
  return out;
}

/** Step log: done — done now, skipped — already existed, manual — a human is needed, failed — error. */
function journal() {
  const steps = [];
  const human = [];
  return {
    steps,
    human,
    add: (id, state, note = '') => steps.push({ id, state, note }),
    manual: (id, note) => { steps.push({ id, state: 'manual', note }); human.push(note); },
  };
}

/** CLI tool; on Windows the npm .cmd wrappers (claude, codex, crew) go through cmd /c. */
function tool(sh, name, args, opts = {}) {
  const r = sh(name, args, { ...opts, allowFail: true });
  if (r.code === 0 || process.platform !== 'win32') return r;
  return sh('cmd', ['/c', name, ...args], { ...opts, allowFail: true });
}

/** Does the remote URL (https or ssh) point exactly at owner/name? */
export function sameRepo(url = '', repo = '') {
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(String(url).trim());
  return !!m && m[1].toLowerCase() === String(repo).toLowerCase();
}

const firstLine = (r) => (r.stderr || r.stdout || '').split('\n')[0];

function stop(j, code, summary, recovery = {}) {
  return fail(code, summary, { ...recovery, artifacts: { steps: j.steps, human_steps: j.human } });
}

/** Step 1 of both modes: node, git, gh and the gh login. → { login, id } or a fail result. */
function checkMachine(j, sh) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) return stop(j, 'env_missing', `Node.js 22+ is required, found ${process.version}`, { retry: 'install Node.js 22 LTS and re-run crew up', stop_when: 'no permission to install — call a human' });
  for (const t of ['git', 'gh']) {
    if (tool(sh, t, ['--version']).code !== 0) {
      return stop(j, 'env_missing', `${t} is not installed`, { retry: `install ${t} and re-run the same crew up command`, stop_when: 'no permission to install — call a human' });
    }
  }
  if (sh('gh', ['auth', 'status'], { allowFail: true }).code !== 0) {
    j.manual('gh-login', 'sign in to GitHub: gh auth login (via the browser; a human signs in)');
    return stop(j, 'gh_auth', 'gh is not authenticated', {
      cause_hint: 'the agent does not enter passwords or tokens — a human signs in',
      retry: 'a human runs gh auth login, then the same crew up command',
      stop_when: 'immediately: ask the human to sign in',
    });
  }
  const u = sh('gh', ['api', 'user', '--jq', '.login + " " + (.id|tostring)'], { allowFail: true });
  const [login, id] = u.stdout.trim().split(/\s+/);
  if (u.code !== 0 || !login) return stop(j, 'gh_auth', 'Could not determine your GitHub login', { cause_hint: firstLine(u), retry: 'gh auth refresh, then the same crew up command' });
  j.add('machine', 'done', `node ${process.version}, git, gh (${login})`);
  return { login, id };
}

/** git user.name/email: if not set — locally in the repo, from the GitHub account (noreply email). */
function ensureIdentity(j, sh, root, me) {
  const name = sh('git', ['config', 'user.name'], { cwd: root, allowFail: true }).stdout;
  const email = sh('git', ['config', 'user.email'], { cwd: root, allowFail: true }).stdout;
  if (name && email) return j.add('git-identity', 'skipped', `${name} <${email}>`);
  if (!name) sh('git', ['config', 'user.name', me.login], { cwd: root });
  if (!email) sh('git', ['config', 'user.email', `${me.id}+${me.login}@users.noreply.github.com`], { cwd: root });
  j.add('git-identity', 'done', `local to the repo: ${me.login}`);
}

/** Windows: long paths (task worktrees + node_modules), in this repo only. */
function ensureLongPaths(j, sh, root) {
  if (process.platform !== 'win32') return;
  sh('git', ['config', 'core.longpaths', 'true'], { cwd: root, allowFail: true });
  j.add('longpaths', 'done', 'git core.longpaths=true (local)');
}

/** crew must be on PATH for the agent MCP configs (command: crew). */
function checkHkOnPath(j, sh) {
  if (tool(sh, 'crew', ['--version']).code === 0) return j.add('crew-on-path', 'skipped', 'crew is available on PATH');
  j.manual('crew-on-path', 'crew is not on PATH — the agent MCP will not start: run npm link in the harness folder');
}

function checkHosts(j, sh, hosts) {
  const missing = hosts.filter((h) => tool(sh, h, ['--version']).code !== 0);
  if (missing.length === hosts.length) j.manual('agents', `no agent found (${hosts.join(', ')}) — install at least one`);
  else if (missing.length) j.add('agents', 'skipped', `found: ${hosts.filter((h) => !missing.includes(h)).join(', ')}; missing: ${missing.join(', ')}`);
  else j.add('agents', 'skipped', `found: ${hosts.join(', ')}`);
  return hosts.filter((h) => !missing.includes(h));
}

async function lead(o, sh) {
  const j = journal();
  const { repo, stack = 'web-fastapi', harness = DEFAULT_HARNESS } = o;
  if (!REPO_RE.test(String(repo))) return fail('bad_input', '--repo: expected owner/name', { retry: 'crew up <dir> --repo <owner>/<name>' });
  const { logins: invite, bad } = parseInvite(o.invite);
  if (bad.length) return fail('bad_input', `These do not look like GitHub logins: ${bad.join(', ')}`, { retry: 'crew up ... --invite login1,login2' });
  for (const k of ['start', 'end']) {
    if (o[k] && !Number.isFinite(Date.parse(o[k]))) return fail('bad_input', `--${k}: an ISO date is required, e.g. 2026-11-10T10:00:00+03:00`, { retry: 'crew up ... --start <ISO> --end <ISO>' });
  }
  if (!!o.start !== !!o.end) return fail('bad_input', '--start and --end must be given together', { retry: 'crew up ... --start <ISO> --end <ISO>' });
  const root = resolve(o.dir ?? repo.split('/')[1]);

  const me = checkMachine(j, sh);
  if (me.status === 'error') return me;

  // 2. Project
  if (existsSync(join(root, 'crew.config.json'))) j.add('init', 'skipped', `${root} already exists`);
  else {
    const r = await init.run({ dir: root, stack, hosts: o.hosts });
    if (r.status === 'error') return stop(j, r.error.code, `crew init: ${r.summary}`, r.error);
    j.add('init', 'done', r.summary);
  }

  // 3. Event rules — only before the first commit: afterwards main is protected and changes go through PRs.
  // Before the commit the file is rewritten, so a re-run with corrected dates/members applies them.
  const eventAbs = join(root, EVENT_PATH);
  const committed = sh('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, allowFail: true }).code === 0;
  if (committed) {
    j.add('event', 'skipped', existsSync(eventAbs) ? `${EVENT_PATH} is already in the repo` : `commits already exist — not creating ${EVENT_PATH}`);
    if (o.start || !existsSync(eventAbs)) j.human.push(`event rules are changed through a PR: ${EVENT_PATH} (start/end, team_members) and "event": "${EVENT_PATH}" in crew.config.json`);
  } else {
    const team = [me.login, ...invite];
    writeFileSync(eventAbs, JSON.stringify(eventFile({ name: o.event_name ?? repo.split('/')[1], start: o.start, end: o.end, team }), null, 2) + '\n');
    // The captain is whoever sets the project up: only they run kickoff (protection against a second plan).
    const cfgPath = join(root, 'crew.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, captain: me.login, ...(o.start ? { event: EVENT_PATH } : {}) }, null, 2) + '\n');
    if (o.start) {
      j.add('event', 'done', `${EVENT_PATH}: ${o.start} — ${o.end}, team ${team.join(', ')}; compliance check enabled`);
    } else {
      j.add('event', 'done', `${EVENT_PATH} without times — compliance check disabled`);
      j.human.push(`once the event time is known: a PR with start/end in ${EVENT_PATH} and "event": "${EVENT_PATH}" in crew.config.json`);
    }
  }

  // 4. First commit
  ensureIdentity(j, sh, root, me);
  ensureLongPaths(j, sh, root);
  if (committed) j.add('commit', 'skipped', 'commits already exist');
  else {
    sh('git', ['add', '-A'], { cwd: root });
    sh('git', ['commit', '-q', '-m', `chore: crew init (stack ${stack})`], { cwd: root });
    j.add('commit', 'done', `chore: crew init (stack ${stack})`);
  }

  // 5. GitHub repo + push
  const exists = sh('gh', ['repo', 'view', repo, '--json', 'nameWithOwner'], { allowFail: true }).code === 0;
  if (!exists) {
    const r = sh('gh', ['repo', 'create', repo, o.public ? '--public' : '--private', '--source', root, '--remote', 'origin', '--push'], { cwd: root, allowFail: true });
    if (r.code !== 0) {
      return stop(j, 'repo_create_failed', `Could not create ${repo}`, {
        cause_hint: firstLine(r),
        retry: 'the same crew up command (completed steps are skipped)',
        stop_when: 'no permission to create repos for this owner — call a human',
      });
    }
    j.add('repo', 'done', `created ${repo} (${o.public ? 'public' : 'private'}), main pushed`);
  } else {
    const origin = sh('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFail: true });
    if (origin.code !== 0) sh('git', ['remote', 'add', 'origin', `https://github.com/${repo}.git`], { cwd: root });
    else if (!sameRepo(origin.stdout, repo)) {
      return stop(j, 'remote_mismatch', `origin points at ${origin.stdout}, not ${repo}`, { retry: 'check --repo and the folder', stop_when: 'immediately: we do not overwrite a foreign remote' });
    }
    const heads = sh('git', ['ls-remote', '--heads', 'origin', 'main'], { cwd: root, allowFail: true });
    if (heads.code === 0 && heads.stdout) j.add('repo', 'skipped', `${repo} already exists, main pushed`);
    else {
      const p = sh('git', ['push', '-u', 'origin', 'main'], { cwd: root, allowFail: true });
      if (p.code !== 0) return stop(j, 'push_failed', `Could not push main to ${repo}`, { cause_hint: firstLine(p), retry: 'the same crew up command', stop_when: 'the repo belongs to someone else or already has a different history — call a human' });
      j.add('repo', 'done', `${repo} already existed, main pushed`);
    }
  }

  // 6. Invitations (PUT is idempotent: 201 — invited, 204 — already a member)
  const others = invite.filter((l) => l.toLowerCase() !== me.login.toLowerCase());
  for (const login of others) {
    const r = sh('gh', ['api', '-X', 'PUT', `repos/${repo}/collaborators/${login}`, '-f', 'permission=push'], { allowFail: true });
    if (r.code === 0) j.add(`invite:${login}`, 'done', 'invited with write access (or already a member)');
    else j.add(`invite:${login}`, 'failed', firstLine(r));
  }
  if (others.length) j.human.push(`for the members (${others.join(', ')}): send their agent the member message from docs/AGENT-SETUP.md — crew up --join ${repo} accepts the invitation by itself`);

  // 7. Main protection, labels, CREW_HARNESS
  const g = await github.run({ repo, harness, apply: true, cwd: root }, { run: sh });
  if (g.status === 'error') return stop(j, g.error.code, `crew github setup: ${g.summary}`, g.error);
  j.add('github-setup', 'done', g.summary);
  // A private repo on the free plan: there is no main protection, so the checks affect nothing.
  if (!mainProtected(root, (args) => sh('gh', args, { cwd: root, allowFail: true }))) {
    j.manual('main-protection', `main protection is unavailable (private repo on the free plan): PRs can merge without review and checks. Make the repo public (Settings → General → Change visibility) or get GitHub Pro, then run crew github setup --repo ${repo} --apply`);
  }

  checkHkOnPath(j, sh);
  const hosts = loadConfig(root).config.hosts ?? [];
  checkHosts(j, sh, hosts);

  const failed = j.steps.filter((s) => s.state === 'failed');
  return (failed.length ? warn : ok)(`Project ${repo} set up in ${root}${failed.length ? `, but with errors: ${failed.map((s) => s.id).join(', ')}` : ''}`, {
    artifacts: { root, repo, steps: j.steps, human_steps: j.human },
    next_actions: [
      ...j.human.map((h) => `for the human: ${h}`),
      `after access is granted, check CI: gh run list -R ${repo} -L 3 (a run that failed before access — gh run rerun <id> -R ${repo})`,
      ...launchHints(hosts, root),
      'paste the organizers brief into docs/brief.md as is → tell the agent: "analyze the brief with the crew-brief-analysis skill", then crew-kickoff',
    ],
  });
}

async function member(o, sh) {
  const j = journal();
  const repo = o.join;
  if (!REPO_RE.test(String(repo))) return fail('bad_input', '--join: expected owner/name', { retry: 'crew up --join <owner>/<name>' });
  const root = resolve(o.dir ?? repo.split('/')[1]);

  const me = checkMachine(j, sh);
  if (me.status === 'error') return me;

  // 2. Invitation — to this repo only
  const inv = sh('gh', ['api', 'user/repository_invitations'], { allowFail: true });
  let list = [];
  try { list = inv.code === 0 ? JSON.parse(inv.stdout || '[]') ?? [] : []; } catch { list = []; }
  const pending = list.find((i) => i.repository?.full_name?.toLowerCase() === repo.toLowerCase());
  if (pending) {
    const a = sh('gh', ['api', '-X', 'PATCH', `user/repository_invitations/${pending.id}`], { allowFail: true });
    if (a.code !== 0) return stop(j, 'invite_failed', `Could not accept the invitation to ${repo}`, { cause_hint: firstLine(a), retry: `a human accepts it at https://github.com/${repo}/invitations, then crew up --join ${repo}` });
    j.add('invite', 'done', `invitation to ${repo} accepted`);
  }
  const perm = sh('gh', ['repo', 'view', repo, '--json', 'viewerPermission', '--jq', '.viewerPermission'], { allowFail: true });
  if (perm.code !== 0) {
    return stop(j, 'no_access', `No access to ${repo}`, {
      cause_hint: 'there is no invitation: the captain has not invited you yet, or the repo name has a typo',
      retry: `captain: crew up ... --invite ${me.login}; then run crew up --join ${repo} again`,
      stop_when: 'immediately: ask the captain to invite you',
    });
  }
  if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(perm.stdout.trim())) {
    return stop(j, 'no_write', `Permission on ${repo} is ${perm.stdout.trim() || 'READ'} — the agent will not be able to push`, { retry: `captain: crew up ... --invite ${me.login}`, stop_when: 'immediately: ask the captain to grant write access' });
  }
  if (!pending) j.add('invite', 'skipped', `access already granted (${perm.stdout.trim()})`);

  // 3. Clone
  if (existsSync(join(root, '.git'))) {
    const origin = sh('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFail: true });
    if (!sameRepo(origin.stdout, repo)) {
      return stop(j, 'remote_mismatch', `${root} holds a different repo (origin: ${origin.stdout || 'none'}), not ${repo}`, { retry: `crew up --join ${repo} <other dir>`, stop_when: 'immediately: we do not touch a foreign folder' });
    }
    const pull = sh('git', ['pull', '--ff-only', '-q'], { cwd: root, allowFail: true });
    if (pull.code === 0) j.add('clone', 'skipped', `${root} already exists, updated (git pull --ff-only)`);
    else j.add('clone', 'failed', `${root} already exists, but git pull --ff-only failed: ${firstLine(pull)} — local changes or divergence from origin`);
  } else if (existsSync(root) && readdirSync(root).length) {
    return stop(j, 'dir_not_empty', `${root} is not empty and not a git repo`, { retry: `crew up --join ${repo} <other dir>` });
  } else {
    const c = sh('gh', ['repo', 'clone', repo, root], { allowFail: true });
    if (c.code !== 0) return stop(j, 'clone_failed', `Could not clone ${repo}`, { cause_hint: firstLine(c), retry: `crew up --join ${repo}` });
    j.add('clone', 'done', `${repo} → ${root}`);
  }
  if (!existsSync(join(root, 'crew.config.json'))) {
    return stop(j, 'no_config', `${repo} has no crew.config.json — the captain has not set the project up yet`, { retry: `wait for the captain and re-run crew up --join ${repo}` });
  }
  ensureIdentity(j, sh, root, me);
  ensureLongPaths(j, sh, root);

  // 4. Local agent configs (machine-dependent, not committed)
  const a = await adapters.run({ cwd: root });
  if (a.status === 'error') return stop(j, a.error.code, `crew adapters build: ${a.summary}`, a.error);
  j.add('adapters', 'done', a.summary);

  checkHkOnPath(j, sh);
  const hosts = loadConfig(root).config.hosts ?? [];
  checkHosts(j, sh, hosts);
  if (hosts.includes('codex')) j.human.push('Codex: on the first run in the project folder confirm trust (otherwise it will not read .codex/config.toml)');

  const failed = j.steps.filter((s) => s.state === 'failed');
  return (failed.length ? warn : ok)(`Done: ${repo} in ${root}, you are ${me.login}${failed.length ? ` (with errors: ${failed.map((s) => s.id).join(', ')})` : ''}`, {
    artifacts: { root, repo, steps: j.steps, human_steps: j.human },
    next_actions: [...j.human.map((h) => `for the human: ${h}`), ...launchHints(hosts, root)],
  });
}

export default {
  name: 'up',
  summary: 'Set everything up with one command: captain — project and GitHub repo (--repo), member — join (--join)',
  agent: false,
  args: [
    { name: 'dir', type: 'string', positional: true, description: 'project folder (default — the repo name)' },
    { name: 'repo', type: 'string', description: 'captain: owner/name of the new product repo' },
    { name: 'join', type: 'string', description: 'member: owner/name of the existing repo' },
    { name: 'stack', type: 'string', description: 'captain: stack preset (web-fastapi, web-node)' },
    { name: 'public', type: 'boolean', description: 'captain: public repo (private by default)' },
    { name: 'invite', type: 'string', description: 'captain: GitHub logins, comma-separated — invite with write access' },
    { name: 'start', type: 'string', description: 'captain: event start, ISO (together with --end enables the compliance check)' },
    { name: 'end', type: 'string', description: 'captain: event end, ISO' },
    { name: 'event_name', type: 'string', description: 'captain: event name for events/event.json' },
    { name: 'hosts', type: 'string', description: 'captain: agent hosts, comma-separated (default claude,codex)' },
    { name: 'harness', type: 'string', description: `captain: CREW_HARNESS value (default ${DEFAULT_HARNESS})` },
  ],
  // deps.run — stub for running external commands (tests without a network).
  async run(o, deps = {}) {
    const sh = deps.run ?? run;
    if (o.repo && o.join) return fail('bad_input', '--repo (captain) and --join (member) cannot be used together', { retry: 'crew up <dir> --repo <owner>/<name>  or  crew up --join <owner>/<name>' });
    if (o.join) return member(o, sh);
    if (o.repo) return lead(o, sh);
    return fail('bad_input', 'Pass --repo (create a project) or --join (connect)', {
      retry: 'crew up <dir> --repo <owner>/<name> --invite a,b  or  crew up --join <owner>/<name>',
      stop_when: 'unclear whether you are the captain or a member — ask the human',
    });
  },
};
