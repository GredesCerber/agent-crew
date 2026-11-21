// crew task lint | crew kickoff [--apply] — tasks and epics in Issues from docs/prd.md (deterministic).
// The core is the pure functions in src/core/prd.js; gh and sleep are passed in as dependencies (tests run without a network).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ok, warn, fail } from '../core/output.js';
import { run } from '../core/exec.js';
import { loadConfig, agentId, requireProject } from '../core/config.js';
import { hasCaptainPowers } from '../core/captain.js';
import { loadActingCaptain } from './captain.js';
import { loadDiscoveryStatus, mainDoc } from './discover.js';

/** The phase in main's crew.config.json (the local one is the fallback when main has none or it is unreadable). */
export function mainPhase(root, localConfig = {}) {
  try {
    const text = mainDoc(root, 'crew.config.json');
    if (text) return phaseOf(JSON.parse(text));
  } catch { /* unreadable main config: fall back to the local one */ }
  return phaseOf(localConfig);
}
import { phaseOf } from '../core/discovery.js';
import {
  DEFAULT_PRD, parsePrd, lintPrd, planKickoff, prdApproval, renderTaskBody, renderEpicBody, formatLintItem,
} from '../core/prd.js';

const FILE_ARG = { name: 'file', type: 'string', description: `path to the PRD from the project root (default ${DEFAULT_PRD})` };
const APPROVE_LINE = '<!-- crew:prd status: approved by: <login|auto-timeout> at: <ISO> -->';

/** Pause between gh issue create calls and retry pauses on rate limit (ms). */
export const CREATE_DELAY_MS = 1000;
export const RATE_LIMIT_BACKOFF_MS = [10_000, 30_000, 60_000];
const RATE_LIMIT_RE = /secondary rate limit|rate limit|abuse|HTTP 403/i;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultGh = (root) => (args, { input } = {}) => run('gh', args, { cwd: root, allowFail: true, input });

/** Read and validate the PRD. → { text, parsed, lint } or fail(...). */
export function loadPrd({ file = DEFAULT_PRD, root, areas }) {
  const path = resolve(root, file);
  if (!existsSync(path)) {
    return {
      result: fail('prd_missing', `File ${file} not found`, {
        cause_hint: `expected a PRD with crew-task blocks: ${path}`,
        retry: `write ${file} following skills/crew-kickoff/task-format.md and run crew task lint again`,
        stop_when: 'the file is missing and it is unclear where the PRD is — ask the human',
      }),
    };
  }
  const text = readFileSync(path, 'utf8');
  const parsed = parsePrd(text);
  const lint = lintPrd(parsed, { areas });
  if (lint.errors.length) {
    return {
      result: fail('prd_invalid', `PRD ${file}: errors ${lint.errors.length}${lint.warnings.length ? `, warnings ${lint.warnings.length}` : ''}`, {
        cause_hint: lint.errors.slice(0, 3).map(formatLintItem).join(' | '),
        retry: `fix ${file} and run crew task lint again`,
        stop_when: 'the same errors after two fixes in a row — show the human',
        artifacts: { errors: lint.errors, warnings: lint.warnings },
      }),
    };
  }
  return { text, parsed, lint };
}

const taskLint = {
  name: 'task lint',
  summary: 'Validate docs/prd.md: crew-task/crew-epic blocks, acceptance criteria, areas, dependencies (no network)',
  args: [FILE_ARG],
  run({ file = DEFAULT_PRD }) {
    const loaded = loadConfig();
    const outside = requireProject(loaded);
    if (outside) return outside;
    const { config, root } = loaded;
    const r = loadPrd({ file, root, areas: config.areas });
    if (r.result) return r.result;
    const { parsed, lint, text } = r;
    const approval = prdApproval(text);
    const artifacts = { tasks: parsed.tasks.length, epics: parsed.epics.length, order: lint.order, warnings: lint.warnings, approved: approval.approved };
    const next_actions = [approval.approved ? 'crew kickoff — plan (dry-run), then crew kickoff --apply' : `show the PRD and crew kickoff (dry-run) to the product lead; once approved, put this in the ${file} header: ${APPROVE_LINE}`];
    const summary = `PRD ${file}: tasks ${parsed.tasks.length}, epics ${parsed.epics.length}`;
    return lint.warnings.length
      ? warn(`${summary}, warnings ${lint.warnings.length}`, { artifacts, next_actions: [...lint.warnings.map(formatLintItem), ...next_actions] })
      : ok(`${summary} — no errors`, { artifacts, next_actions });
  },
};

const LIST_ARGS = ['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,title,body,labels,state,stateReason'];

/** Plan documents: after kickoff --apply they must be in main, otherwise the team works without the PRD. */
export const PLAN_DOCS = ['docs/brief.md', 'docs/brief-analysis.md', DEFAULT_PRD];

/**
 * Publish the plan to main: commit the changed plan documents (with the Agent trailer) and push.
 * The captain is a repo admin; main protection lets them through. → { state: 'done'|'clean'|'failed', note }
 */
export function publishPlan({ root, me, files = PLAN_DOCS, sh = (cmd, args) => run(cmd, args, { cwd: root, allowFail: true }) }) {
  const first = (r) => (r.stderr || r.stdout || '').split('\n')[0];
  // We push to main only from main and only the plan documents: an admin bypasses protection, so other code would reach main without review.
  const branch = sh('git', ['branch', '--show-current']).stdout.trim();
  if (branch !== 'main') return { state: 'failed', note: `kickoff was run on branch ${branch || '?'}, not main — plan not published; captain: go to the main project folder (main) and re-run crew kickoff --apply` };
  const changed = sh('git', ['status', '--porcelain', '--', ...files]).stdout.split('\n').filter(Boolean);
  if (changed.length) {
    // Fresh clone without user.name/email: the commit would fail. Same as crew up — a noreply identity from the gh account, in this repo only.
    if (!sh('git', ['config', 'user.email']).stdout.trim() || !sh('git', ['config', 'user.name']).stdout.trim()) {
      const [login, id] = sh('gh', ['api', 'user', '--jq', '.login + " " + (.id|tostring)']).stdout.trim().split(/\s+/);
      if (!login || !id) return { state: 'failed', note: 'git has no user.name/user.email and the GitHub login could not be determined — captain: set git config user.name/user.email and re-run crew kickoff --apply' };
      if (!sh('git', ['config', 'user.name']).stdout.trim()) sh('git', ['config', 'user.name', login]);
      if (!sh('git', ['config', 'user.email']).stdout.trim()) sh('git', ['config', 'user.email', `${id}+${login}@users.noreply.github.com`]);
    }
    sh('git', ['add', '--', ...files]);
    const c = sh('git', ['commit', '-q', '-m', 'docs: project plan (brief, analysis, PRD)', '-m', `Agent: ${me}`, '--', ...files]);
    if (c.code !== 0) return { state: 'failed', note: `could not commit the plan: ${first(c)}` };
  }
  const pull = sh('git', ['pull', '--rebase', '-q', 'origin', 'main']);
  if (pull.code !== 0) return { state: 'failed', note: `could not pull main before publishing the plan: ${first(pull)} — captain: run git status, resolve, then git push origin HEAD:main` };
  const ahead = sh('git', ['diff', '--name-only', 'origin/main..HEAD']).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!ahead.length) return { state: 'clean', note: 'the plan is already in main' };
  const foreign = ahead.filter((f) => !files.includes(f));
  if (foreign.length) return { state: 'failed', note: `local main has unpushed changes that are not part of the plan (${foreign.slice(0, 3).join(', ')}) — not pushing; the captain sorts it out` };
  const p = sh('git', ['push', 'origin', 'HEAD:main']);
  if (p.code !== 0) return { state: 'failed', note: `plan committed but not pushed to main: ${(p.stderr || p.stdout).split('\n')[0]} — captain: git push origin HEAD:main` };
  return { state: 'done', note: 'brief, analysis and PRD pushed to main — the team can see them' };
}

/**
 * Execute the plan: check labels, create tasks in order, then epics. Existing issues are left untouched.
 * gh(args, { input }) → { code, stdout, stderr }; sleep(ms) → Promise. Both are stubbed in tests.
 * A failure midway → kickoff_partial (a retry is idempotent — created issues are found by their markers).
 * → { created, map } on success or a fail(...) result (status: 'error').
 */
export async function applyKickoff(plan, { parsed, prd = DEFAULT_PRD, gh, sleep = realSleep }) {
  const creates = plan.ops.filter((o) => o.op === 'create');
  const needed = [...new Set(creates.flatMap((o) => o.labels))];
  const lr = gh(['label', 'list', '--limit', '500', '--json', 'name']);
  if (lr.code !== 0) {
    return fail('gh_failed', 'Could not read the repo labels', {
      cause_hint: (lr.stderr || lr.stdout).split('\n')[0],
      retry: 'crew doctor, then crew kickoff --apply',
      stop_when: 'gh is not authenticated or there is no repo — tell the human',
    });
  }
  const have = new Set((JSON.parse(lr.stdout || '[]') ?? []).map((l) => l.name));
  const missing = needed.filter((l) => !have.has(l));
  if (missing.length) {
    return fail('labels_missing', `The repo is missing labels: ${missing.join(', ')}`, {
      cause_hint: 'labels are created by crew labels sync (status:*, area:*, tier:*, risk:*, epic)',
      retry: 'crew labels sync, then crew kickoff --apply',
      stop_when: 'crew labels sync is unavailable to the agent — ask the human',
      artifacts: { missing },
    });
  }

  const map = { ...plan.map };
  const created = [];
  const skeletonId = parsed.tasks.find((t) => t.fields.skeleton === true)?.id ?? null;
  const blocks = new Map([...parsed.tasks, ...parsed.epics].map((b) => [b.id, b]));
  let first = true;
  for (const op of creates) {
    const block = blocks.get(op.id);
    const body = op.kind === 'task'
      ? renderTaskBody(block, { issueOf: map, prd, skeletonId, epics: parsed.epics, tasks: parsed.tasks })
      : renderEpicBody(block, parsed.tasks, { issueOf: map, prd });
    const args = ['issue', 'create', '--title', op.title, '--label', op.labels.join(','), '--body-file', '-', ...(op.assignee ? ['--assignee', op.assignee] : [])];
    if (!first) await sleep(CREATE_DELAY_MS); // avoid hitting the GitHub secondary rate limit
    first = false;
    let r = gh(args, { input: body });
    for (let attempt = 0; r.code !== 0 && attempt < RATE_LIMIT_BACKOFF_MS.length && RATE_LIMIT_RE.test(`${r.stderr}\n${r.stdout}`); attempt++) {
      await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
      r = gh(args, { input: body });
    }
    const number = Number(/\/issues\/(\d+)/.exec(r.stdout ?? '')?.[1]);
    if (r.code !== 0 || !Number.isFinite(number)) {
      const limited = RATE_LIMIT_RE.test(`${r.stderr}\n${r.stdout}`);
      return fail('kickoff_partial', `Created ${created.length} of ${creates.length}, failed on ${op.id} "${op.title}"`, {
        cause_hint: limited ? 'GitHub rate limit persisted after 3 retries' : (r.stderr || r.stdout || 'gh did not return an issue link').split('\n')[0],
        retry: limited ? 'wait 5–10 minutes and run crew kickoff --apply again (created issues will be skipped)' : 'crew kickoff --apply (created issues are skipped by their markers)',
        stop_when: 'fails on the same task twice — tell the human',
        artifacts: { created, failed: op.id, map },
      });
    }
    map[op.id] = number;
    created.push({ id: op.id, number });
  }
  return { created, map };
}

/**
 * crew kickoff: lint → existing issues → plan → (with --apply and an approved PRD) creation.
 * deps: { gh, sleep, root, areas } — for tests.
 */
export async function runKickoff({ file = DEFAULT_PRD, apply = false, skip_discovery = false } = {}, deps = {}) {
  const cfg = deps.root ? null : loadConfig();
  const root = deps.root ?? cfg.root;
  const r = loadPrd({ file, root, areas: deps.areas ?? cfg?.config.areas });
  if (r.result) return r.result;
  const { parsed, lint, text } = r;
  const approval = prdApproval(text);
  // The approval gate comes before any GitHub calls.
  if (apply && !approval.approved) {
    return fail('plan_not_approved', `PRD ${file} is not approved — not creating issues`, {
      cause_hint: approval.status ? `PRD header says status: ${approval.status}` : `${file} has no approval header ${APPROVE_LINE}`,
      retry: 'show the PRD and crew kickoff (dry-run) to the product lead, once approved set status: approved and run crew kickoff --apply again',
      stop_when: 'no answer from the product lead for 20 minutes — the planner sets status: approved by: auto-timeout; do not run --apply without the header',
      next_actions: ['crew kickoff (dry-run) — show the plan to the human', `after approval: ${APPROVE_LINE} at the top of ${file}`, 'crew kickoff --apply'],
      artifacts: { approval },
    });
  }
  const gh = deps.gh ?? defaultGh(root);
  const warnings = lint.warnings.map(formatLintItem);
  let existing = [];
  const lr = gh(LIST_ARGS);
  if (lr.code === 0) existing = JSON.parse(lr.stdout || '[]') ?? [];
  else if (apply) {
    return fail('gh_failed', 'Could not read the repo issues', {
      cause_hint: (lr.stderr || lr.stdout).split('\n')[0],
      retry: 'crew doctor, then crew kickoff --apply',
      stop_when: 'gh is not authenticated or there is no repo — tell the human',
    });
  } else warnings.push(`could not read issues (${(lr.stderr || lr.stdout).split('\n')[0]}) — the plan ignores existing ones`);

  const plan = planKickoff(parsed, existing, { prd: file });
  warnings.push(...plan.warnings);
  const count = (op) => plan.ops.filter((o) => o.op === op).length;
  const planView = plan.ops.map(({ op, kind, id, title, labels, after, tasks, number, assignee }) => ({ op, kind, id, title, ...(number ? { number } : {}), ...(assignee ? { assignee } : {}), ...(labels ? { labels } : {}), ...(after?.length ? { after } : {}), ...(tasks ? { tasks } : {}) }));

  if (!apply) {
    const artifacts = { apply: false, approved: approval.approved, approval, plan: planView, map: plan.map, warnings };
    const summary = `Kickoff plan: create ${count('create')}, skip ${count('skip') + count('changed')}${count('orphan') ? `, orphans ${count('orphan')}` : ''} (dry-run)`;
    const next_actions = approval.approved
      ? ['crew kickoff --apply']
      : ['show the PRD and this plan to the product lead', `once approved: ${APPROVE_LINE} at the top of ${file}`, 'crew kickoff --apply'];
    return warnings.length ? warn(summary, { artifacts, next_actions }) : ok(summary, { artifacts, next_actions });
  }

  // One person drives the plan — the captain (crew.config.json → captain, written by crew up). Members do not plan.
  const captain = deps.captain !== undefined ? deps.captain : cfg?.config.captain ?? null;
  if (captain) {
    const who = gh(['api', 'user', '--jq', '.login']);
    const me = who.code === 0 ? who.stdout.trim() : null;
    // the acting captain (a handover by the captain, or the automatic fallback) may plan too, if the project allows it
    const acting = deps.acting !== undefined ? deps.acting : cfg ? loadActingCaptain(cfg.root, { ...cfg.config, captain }) : null;
    if (!hasCaptainPowers(me, { captain }, acting)) {
      return fail('not_captain', `Only the captain ${captain}${acting?.login && acting.why !== 'captain' ? ` (or @${acting.login}, acting now)` : ''} creates the plan and tasks${me ? `, and you are ${me}` : ''}`, {
        cause_hint: 'the team has one plan: a second kickoff creates duplicate tasks and a foreign skeleton',
        retry: 'members: do not plan, work through the crew-workflow cycle (crew task next)',
        stop_when: 'immediately: tell the human that the captain makes the plan',
        artifacts: { captain, me },
      });
    }
  }
  // Kickoff runs from main: otherwise the issues get created but the plan does not reach main (or another branch does).
  const branch = deps.branch !== undefined ? deps.branch : deps.gh ? 'main' : run('git', ['branch', '--show-current'], { cwd: root, allowFail: true }).stdout.trim();
  if (branch !== 'main') {
    return fail('not_main', `crew kickoff --apply must be run on main, but the current branch is ${branch || '?'}`, {
      cause_hint: 'the plan is published to main together with the tasks; this is not possible from a task branch (worktree)',
      retry: 'go to the main project folder (git switch main) and run crew kickoff --apply again',
      stop_when: 'there is no main folder on main — tell the human',
    });
  }
  // Discovery first: research done, human questions answered, decisions recorded, the PRD reviewed on main.
  // The phase as main has it: a local "build" left by a kickoff whose push failed must not skip the gate or the config publish.
  const phase = deps.phase !== undefined ? deps.phase : mainPhase(root, cfg?.config ?? {});
  if (phase === 'discovery' && !skip_discovery) {
    const status = deps.discovery ?? loadDiscoveryStatus(root);
    if (!status.ready) {
      return fail('discovery_not_done', `The project is in the discovery phase and it is not done: ${status.missing.length} item(s) left`, {
        cause_hint: status.missing[0],
        retry: 'crew discover status — finish the list, then crew kickoff --apply',
        stop_when: 'the human decides to plan anyway: crew kickoff --apply --skip_discovery (say so in the PR/plan)',
        next_actions: status.missing,
        artifacts: { missing: status.missing },
      });
    }
  }
  const assignees = [...new Set(plan.ops.filter((o) => o.op === 'create' && o.assignee).map((o) => o.assignee))];
  const outsiders = assignees.filter((l) => gh(['api', `repos/{owner}/{repo}/collaborators/${l}`]).code !== 0);
  if (outsiders.length) {
    return fail('team_not_collaborator', `crew-team contains people who are not repo members: ${outsiders.join(', ')}`, {
      cause_hint: 'a task can only be assigned to a member with access (the invitation must be accepted)',
      retry: `fix the logins in the crew-team block or invite them: crew up --repo <owner/name> --invite ${outsiders.join(',')}; then crew kickoff --apply`,
      stop_when: 'the login is correct but the invitation is not accepted — ask the human to accept it',
      artifacts: { outsiders },
    });
  }

  const res = await applyKickoff(plan, { parsed, prd: file, gh, sleep: deps.sleep ?? realSleep });
  if (res.status === 'error') return res;
  // In tests (gh is stubbed) we do not touch git unless publishing is stubbed explicitly.
  // The plan is in: the project leaves discovery. The phase change is published to main together with the plan.
  let planFiles = PLAN_DOCS;
  if (phase === 'discovery' && !deps.gh) {
    const cfgPath = join(root, 'crew.config.json');
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, 'utf8')), phase: 'build' }, null, 2) + '\n');
    planFiles = [...PLAN_DOCS, 'crew.config.json'];
  }
  const pub = deps.publish ? deps.publish() : deps.gh ? { state: 'skipped' } : publishPlan({ root, me: agentId(), files: planFiles });
  if (pub.state === 'failed') warnings.push(pub.note);
  const artifacts = { apply: true, created: res.created, map: res.map, skipped: plan.ops.filter((o) => o.op === 'skip' || o.op === 'changed').map((o) => o.id), warnings, plan_published: pub.state };
  const summary = `Kickoff: created ${res.created.length}, skipped ${artifacts.skipped.length}`;
  const next_actions = ['crew status', 'briefly tell the humans (in their language): how many tasks, who owns what, what is on the demo path, what was cut; members start the cycle: /loop 10m Work through the crew-workflow cycle'];
  return warnings.length ? warn(summary, { artifacts, next_actions: [...warnings, ...next_actions] }) : ok(summary, { artifacts, next_actions });
}

const kickoff = {
  name: 'kickoff',
  summary: 'Tasks and epics in Issues from docs/prd.md: plan (dry-run) by default, --apply to create (the PRD must be approved)',
  args: [
    FILE_ARG,
    { name: 'apply', type: 'boolean', description: 'create issues (only if the PRD header says status: approved)' },
    { name: 'skip_discovery', type: 'boolean', description: 'kick off although the discovery exit criteria are not met; only when a human said so (not enforced: say it in the plan)' },
  ],
  run(opts) {
    return runKickoff(opts);
  },
};

export default [taskLint, kickoff];
