// crew up — set everything up with one command (run by an agent following docs/AGENT-SETUP.md).
//   Captain:   crew up <dir> --repo owner/name [--stack web-node] [--public] [--invite a,b] [--start ISO --end ISO]
//              project → event.json → first commit → GitHub repo → invitations → main protection, labels, CREW_HARNESS.
//              --check: only look (gh, the owner, the plan, main protection, agents) and say what would block; writes nothing.
//   Member:    crew up --join owner/name [<dir>]
//              accept the invitation → clone → agent configs → check the machine.
// Every step first checks whether it is already done, so a re-run continues from the point of failure.
// What needs a human (account sign-in, CI access to the package) the command does not do — it returns it in human_steps.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { HARNESS_ROOT } from '../core/config.js';
import { join, resolve } from 'node:path';
import { ok, warn, fail } from '../core/output.js';
import { run } from '../core/exec.js';
import { loadConfig } from '../core/config.js';
import init from './init.js';
import adapters, { loadAdapter } from './adapters.js';
import github, { DEFAULT_HARNESS, REPO_RE } from './github.js';
import { mainProtected } from './pr.js';
import { policyFrom } from './captain.js';
import { explainPolicy } from '../core/captain.js';
import { LOCAL_VERSION, compareVersions } from '../core/version.js';
import { pinnedVersion } from '../core/guard.js';

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
  if (hosts.includes('antigravity')) out.push(`Antigravity: Projects → New Project → ${root}, then a new conversation (the crew tools come from .agents/plugins/crew; if they are missing, restart Antigravity once)`);
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

/** Is this agent host installed? A CLI host answers --version; an app with no CLI (Antigravity) says itself. */
export async function hostInstalled(sh, h, exists = existsSync) {
  const a = await loadAdapter(h);
  if (a && typeof a.installed === 'function') return a.installed({ exists });
  return tool(sh, h, ['--version']).code === 0;
}

async function checkHosts(j, sh, hosts) {
  const ok = [];
  for (const h of hosts) if (await hostInstalled(sh, h)) ok.push(h);
  const missing = hosts.filter((h) => !ok.includes(h));
  if (missing.length === hosts.length) j.manual('agents', `no agent found (${hosts.join(', ')}) — install at least one`);
  else if (missing.length) j.add('agents', 'skipped', `found: ${hosts.filter((h) => !missing.includes(h)).join(', ')}; missing: ${missing.join(', ')}`);
  else j.add('agents', 'skipped', `found: ${hosts.join(', ')}`);
  return hosts.filter((h) => !missing.includes(h));
}

/** --hosts: only hosts crew has an adapter for (the names also reach a command line on Windows, so nothing else). */
export function hostList(value = 'claude,codex') {
  const known = readdirSync(join(HARNESS_ROOT, 'adapters'));
  const all = String(value ?? 'claude,codex').split(',').map((h) => h.trim()).filter(Boolean);
  return { hosts: all.filter((h) => known.includes(h)), bad: all.filter((h) => !known.includes(h)), known };
}

const PAID_PLANS = ['pro', 'team', 'business', 'enterprise', 'business_plus', 'enterprise_cloud'];

/**
 * What GitHub will allow, read before anything is written. → { blockers, warnings, facts }.
 * protection: available (public, or a paid plan), unavailable (a private repo on the free plan: main cannot be
 * protected, so PR rules and checks bind nobody), unverified (the plan could not be read).
 */
export function preflight(o, sh, me, { installed = (h) => tool(sh, h, ['--version']).code === 0 } = {}) {
  const blockers = [];
  const warnings = [];
  const repo = o.repo;
  const [owner] = repo.split('/');
  const view = sh('gh', ['repo', 'view', repo, '--json', 'visibility,viewerPermission'], { allowFail: true });
  let existing = null;
  try { existing = view.code === 0 ? JSON.parse(view.stdout || 'null') : null; } catch { existing = null; }
  const absent = view.code !== 0 && /Could not resolve to a Repository|Not Found|HTTP 404/i.test(`${view.stderr}\n${view.stdout}`);
  if (!existing && !absent) warnings.push(`could not check whether ${repo} exists (${firstLine(view) || 'no answer'}): crew up will find out when it creates it`);
  const mine = owner.toLowerCase() === me.login.toLowerCase();
  const visibility = existing?.visibility ? String(existing.visibility).toLowerCase() : o.public ? 'public' : 'private';
  if (existing) {
    if (existing.viewerPermission && existing.viewerPermission !== 'ADMIN') {
      blockers.push(`you are ${existing.viewerPermission} on ${repo}: main protection, labels and invitations need admin rights (the repo owner runs crew up, or gives you admin)`);
    }
  } else if (absent && !mine) {
    // membership alone is not enough: an organization can forbid members to create repos of this visibility
    const m = sh('gh', ['api', `orgs/${owner}/memberships/${me.login}`], { allowFail: true });
    let ms = null;
    try { ms = m.code === 0 ? JSON.parse(m.stdout || 'null') : null; } catch { ms = null; }
    if (!ms || (ms.state && ms.state !== 'active')) blockers.push(`${repo} does not exist and you cannot create repos under ${owner}: it is not you (${me.login}) and not an organization you are an active member of — check --repo`);
    else if (ms.role !== 'admin') {
      const org = sh('gh', ['api', `orgs/${owner}`, '--jq', `.members_can_create_${visibility}_repositories`], { allowFail: true });
      const can = org.code === 0 ? String(org.stdout ?? '').trim() : '';
      if (can === 'false') blockers.push(`${owner} does not let members create ${visibility} repos: an owner of ${owner} creates ${repo}, or changes that setting`);
      else if (can !== 'true') warnings.push(`could not read whether ${owner} lets members create ${visibility} repos: crew up will find out when it creates ${repo}`);
    }
  }
  let protection = 'available';
  let plan = null;
  if (visibility !== 'public') {
    const p = sh('gh', ['api', mine ? 'user' : `orgs/${owner}`, '--jq', '.plan.name'], { allowFail: true });
    plan = p.code === 0 ? String(p.stdout || '').trim().toLowerCase() : '';
    protection = plan === 'free' ? 'unavailable' : PAID_PLANS.includes(plan) ? 'available' : 'unverified';
  }
  const why = `${visibility} repo${plan ? ` on the ${plan} plan` : ''}`;
  if (protection === 'unavailable') {
    const msg = `main protection is unavailable (${why}): PRs could merge without review or checks. Use ${existing ? 'a public repo' : '--public'}, or a paid GitHub plan, or pass --no_protection to set up anyway and accept that`;
    if (o.no_protection) warnings.push(msg);
    else blockers.push(msg);
  } else if (protection === 'unverified') {
    warnings.push(`could not read the GitHub plan of ${owner}: main protection on a private repo needs a paid plan; crew up will check again after it tries`);
  }
  if (tool(sh, 'crew', ['--version']).code !== 0) warnings.push('crew is not on PATH: the agents\' MCP config will not start (npm install -g @gredescerber/agent-crew)');
  const hosts = hostList(o.hosts).hosts;
  const found = hosts.filter((h) => installed(h));
  if (!found.length) warnings.push(`no agent found (${hosts.join(', ')}): install at least one before the team starts`);
  return { blockers, warnings, facts: { repo, exists: !!existing, visibility, plan, protection, agents: found } };
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
  if (o.hosts !== undefined) {
    const h = hostList(o.hosts);
    if (h.bad.length || !h.hosts.length) return fail('bad_input', `--hosts: unknown host ${h.bad.join(', ') || '(none)'}`, { retry: `crew up ... --hosts ${h.known.join(',')}` });
  }
  // The captain handover rule is the repo owner's choice (asked before crew up, see docs/AGENT-SETUP.md).
  // solo: one person, nobody to hand the captain role to
  const handover = policyFrom({ mode: o.solo ? 'off' : o.handover ?? (o.deputies ? 'deputies' : 'off'), deputies: o.solo ? '' : o.deputies, fallback_hours: o.solo ? 0 : o.fallback_hours });
  if (handover.error) return fail('bad_input', `captain handover: ${handover.error}`, { retry: 'crew up ... --handover off|deputies|team [--deputies alice,bob] [--fallback_hours 3]' });
  const root = resolve(o.dir ?? repo.split('/')[1]);

  const me = checkMachine(j, sh);
  if (me.status === 'error') return me;

  // 1b. Look before writing: a team must not learn after setup that main cannot be protected.
  // app hosts with no CLI (Antigravity) say themselves whether they are installed: ask the adapters first
  const present = new Set();
  for (const h of hostList(o.hosts).hosts) if (await hostInstalled(sh, h)) present.add(h);
  const pre = preflight(o, sh, me, { installed: (h) => present.has(h) });
  if (o.check) {
    const opts = { artifacts: { ...pre.facts, blockers: pre.blockers, warnings: pre.warnings, steps: j.steps }, next_actions: pre.blockers.length ? pre.blockers : [`crew up ${o.dir ?? repo.split('/')[1]} --repo ${repo}${o.public ? ' --public' : ''} (the same command without --check)`] };
    if (pre.blockers.length) return fail('preflight', `crew up would stop: ${pre.blockers.length} problem(s) to fix first`, { cause_hint: pre.blockers[0], retry: `fix it, then crew up ... --check again`, stop_when: 'a blocker only a person can change (plan, rights, repo name): tell them', ...opts });
    return (pre.warnings.length ? warn : ok)(`Ready to set up ${repo}: ${pre.facts.visibility}, main protection ${pre.facts.protection}${pre.warnings.length ? `, ${pre.warnings.length} warning(s)` : ''} (nothing was changed)`, opts);
  }
  if (pre.blockers.length) {
    return stop(j, 'preflight', `Not starting: ${pre.blockers[0]}`, {
      cause_hint: pre.blockers.join(' | '),
      retry: 'fix it and run the same crew up command (crew up ... --check shows the problems without changing anything)',
      stop_when: 'a blocker only a person can change (plan, rights, repo name): tell them',
    });
  }
  for (const w of pre.warnings) j.add('preflight', 'skipped', w);

  // 2. Project
  if (existsSync(join(root, 'crew.config.json'))) j.add('init', 'skipped', `${root} already exists`);
  else {
    const r = await init.run({ dir: root, stack, hosts: o.hosts, solo: !!o.solo });
    if (r.status === 'error') return stop(j, r.error.code, `crew init: ${r.summary}`, r.error);
    j.add('init', 'done', r.summary);
  }

  // 3. Event rules — only before the first commit: afterwards main is protected and changes go through PRs.
  // Before the commit the file is rewritten, so a re-run with corrected dates/members applies them.
  const eventAbs = join(root, EVENT_PATH);
  const committed = sh('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, allowFail: true }).code === 0;
  if (committed) {
    j.add('event', 'skipped', existsSync(eventAbs) ? `${EVENT_PATH} is already in the repo` : `commits already exist — not creating ${EVENT_PATH}`);
    if (o.handover || o.deputies || o.fallback_hours !== undefined) j.human.push('the captain handover rule is changed now with crew captain policy (crew.config.json is already committed)');
    if (o.start || !existsSync(eventAbs)) j.human.push(`event rules are changed through a PR: ${EVENT_PATH} (start/end, team_members) and "event": "${EVENT_PATH}" in crew.config.json`);
  } else {
    const team = [me.login, ...invite];
    writeFileSync(eventAbs, JSON.stringify(eventFile({ name: o.event_name ?? repo.split('/')[1], start: o.start, end: o.end, team }), null, 2) + '\n');
    // The captain is whoever sets the project up: only they run kickoff (protection against a second plan).
    const cfgPath = join(root, 'crew.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, captain: me.login, captain_handover: handover.value, ...(o.start ? { event: EVENT_PATH } : {}) }, null, 2) + '\n');
    // The README's first line tells a newcomer what to say to their agent: put the real repo name in it.
    const readme = join(root, 'README.md');
    if (existsSync(readme)) writeFileSync(readme, readFileSync(readme, 'utf8').replaceAll('{{repo}}', repo));
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
  const g = await github.run({ repo, harness, apply: true, cwd: root, no_protection: !!o.no_protection || pre.facts.protection === 'unavailable' }, { run: sh });
  if (g.status === 'error') return stop(j, g.error.code, `crew github setup: ${g.summary}`, g.error);
  j.add('github-setup', 'done', g.summary);
  // A private repo on the free plan: there is no main protection, so the checks affect nothing.
  if (!mainProtected(root, (args) => sh('gh', args, { cwd: root, allowFail: true }))) {
    j.manual('main-protection', `main protection is unavailable (private repo on the free plan): PRs can merge without review and checks. Make the repo public (Settings → General → Change visibility) or get GitHub Pro, then run crew github setup --repo ${repo} --apply`);
  }

  checkHkOnPath(j, sh);
  const finalConfig = loadConfig(root).config;
  const hosts = finalConfig.hosts ?? [];
  await checkHosts(j, sh, hosts);
  // The repo owner should know who decides and whether that role can be handed over: say it in plain words.
  const captainRule = explainPolicy(finalConfig);

  const failed = j.steps.filter((s) => s.state === 'failed');
  return (failed.length ? warn : ok)(`Project ${repo} set up in ${root}${failed.length ? `, but with errors: ${failed.map((s) => s.id).join(', ')}` : ''}`, {
    artifacts: { root, repo, steps: j.steps, human_steps: j.human, captain_rule: captainRule },
    next_actions: [
      `explain the captain rule to the repo owner, in their language: ${captainRule.join(' ')}`,
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
  await checkHosts(j, sh, hosts);
  if (hosts.includes('codex')) j.human.push('Codex: on the first run in the project folder confirm trust (otherwise it will not read .codex/config.toml)');

  // 5. The crew version this repo pins: an older one opens PRs that crew-guard fails (outdated_crew).
  const pinSpec = (sh('gh', ['variable', 'get', 'CREW_HARNESS', '-R', repo], { allowFail: true }).stdout || '').trim();
  const pinned = pinnedVersion(pinSpec);
  const versionCmp = pinned ? compareVersions(LOCAL_VERSION, pinned) : 0;
  if (!pinned) j.add('version', 'skipped', 'the repo pins no crew version (CREW_HARNESS)');
  else if (versionCmp < 0) {
    j.add('version', 'failed', `your crew is ${LOCAL_VERSION}, the repo pins ${pinned}`);
    j.human.push(`update crew to the version this repo uses: npm install -g ${pinSpec} (then crew up --join ${repo} again)`);
  } else j.add('version', 'done', versionCmp === 0 ? `crew ${LOCAL_VERSION}, as the repo pins` : `crew ${LOCAL_VERSION} (the repo pins ${pinned}; newer is fine)`);

  const failed = j.steps.filter((s) => s.state === 'failed');
  return (failed.length ? warn : ok)(`Done: ${repo} in ${root}, you are ${me.login}${failed.length ? ` (with errors: ${failed.map((s) => s.id).join(', ')})` : ''}`, {
    artifacts: { root, repo, steps: j.steps, human_steps: j.human, login: me.login },
    next_actions: [
      // No restart needed: the CLI works in this very session; the MCP tools come with a restart inside the folder.
      `start now, in this session: cd ${root}, then crew task next and do what its next_actions say (rules: AGENTS.md there); until the captain gives you an area you take free tasks from anyone`,
      ...j.human.map((h) => `for the human: ${h}`),
      'optional: restarting the agent inside the project folder adds the crew MCP tools',
      ...launchHints(hosts, root),
    ],
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
    { name: 'public', type: 'boolean', description: 'captain: public repo (private by default; a private repo on the free GitHub plan cannot protect main)' },
    { name: 'check', type: 'boolean', description: 'captain: only check what would block the setup (plan, rights, main protection, agents); changes nothing' },
    { name: 'no_protection', type: 'boolean', description: 'captain: set up a private repo on the free plan anyway, knowing main stays unprotected' },
    { name: 'invite', type: 'string', description: 'captain: GitHub logins, comma-separated — invite with write access' },
    { name: 'start', type: 'string', description: 'captain: event start, ISO (together with --end enables the compliance check)' },
    { name: 'end', type: 'string', description: 'captain: event end, ISO' },
    { name: 'event_name', type: 'string', description: 'captain: event name for events/event.json' },
    { name: 'hosts', type: 'string', description: 'captain: agent hosts, comma-separated: claude, codex, antigravity (default claude,codex)' },
    { name: 'harness', type: 'string', description: `captain: CREW_HARNESS value (default ${DEFAULT_HARNESS})` },
    { name: 'solo', type: 'boolean', description: 'captain: one person with one agent (no second-agent review, no discovery phase, no handover)' },
    { name: 'handover', type: 'string', enum: ['off', 'deputies', 'team'], description: 'captain: may the captain role be handed over? off (no), deputies (only to --deputies), team (anyone with write access); ask the repo owner' },
    { name: 'deputies', type: 'string', description: 'captain: GitHub logins who may act as captain, comma-separated (the first one is the automatic fallback)' },
    { name: 'fallback_hours', type: 'number', description: 'captain: hours of captain silence before the first deputy acts automatically (0 = never)' },
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
