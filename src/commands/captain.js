// crew captain | crew captain handoff @login [--hours 6] | crew captain back | crew captain policy --mode ...
// Who acts as captain, handing the role over for a while (when the captain or the captain's agent is away), and the
// rule the repo owner chose for it (crew.config.json → captain_handover; see src/core/captain.js).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, fail } from '../core/output.js';
import { gh, ghJson, run } from '../core/exec.js';
import { loadConfig, requireProject } from '../core/config.js';
import {
  CAPTAIN_LABEL, CAPTAIN_TITLE, HANDOVER_MODES, handoverPolicy, explainPolicy, handoffProblem, handoffMarker,
  handbackMarker, actingCaptain,
} from '../core/captain.js';

const myLogin = () => {
  const r = run('gh', ['api', 'user', '--jq', '.login'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() || null : null;
};
const lc = (s) => String(s ?? '').toLowerCase();

/** The handover log issue (number and comments), or null. */
function captainIssue(root) {
  return (ghJson(['issue', 'list', '--state', 'open', '--label', CAPTAIN_LABEL, '--limit', '1', '--json', 'number,comments'], { cwd: root, allowFail: true }) ?? [])[0] ?? null;
}

/** The captain's last activity in this repo: the newer of their last commit and their last issue/PR comment. */
function captainActiveAt(root, login) {
  const commit = gh(['api', `repos/{owner}/{repo}/commits?author=${encodeURIComponent(login)}&per_page=1`, '--jq', '.[0].commit.author.date // empty'], { cwd: root, allowFail: true }).stdout?.trim();
  const comment = gh(['api', 'repos/{owner}/{repo}/issues/comments?sort=updated&direction=desc&per_page=100', '--jq', `[.[] | select(.user.login == "${login}")][0].updated_at // empty`], { cwd: root, allowFail: true }).stdout?.trim();
  const times = [commit, comment].filter((t) => t && Number.isFinite(Date.parse(t)));
  return times.length ? times.sort().pop() : null;
}

const members = (root) => (gh(['api', 'repos/{owner}/{repo}/collaborators', '--paginate', '--jq', '.[].login'], { cwd: root, allowFail: true }).stdout || '').split('\n').filter(Boolean);

/**
 * Who acts as captain now, from GitHub. With handover off it costs no calls: the captain acts.
 * -> { login, why, until? }
 */
export function loadActingCaptain(root, config, { now = Date.now() } = {}) {
  const p = handoverPolicy(config);
  if (!config.captain || p.mode === 'off') return { login: config.captain ?? null, why: 'captain' };
  const issue = captainIssue(root);
  return actingCaptain({
    config,
    comments: issue?.comments ?? [],
    captainActiveAt: p.fallback_hours ? captainActiveAt(root, config.captain) : null,
    members: p.mode === 'team' ? members(root) : [],
    now,
  });
}

const notTheCaptain = (captain, login, what) => fail('not_captain', `Only the captain ${captain} can ${what}${login ? `, and you are ${login}` : ''}`, {
  cause_hint: 'the captain role is handed over by the captain, and the rule is the repo owner\'s choice',
  retry: 'ask the captain',
  stop_when: 'immediately: tell the human',
});

const status = {
  name: 'captain',
  summary: 'Who is the captain, who acts as captain now, and the handover rule of this project',
  args: [],
  run(_ = {}, deps = {}) {
    const loaded = deps.config ? { config: deps.config, root: '.', path: 'deps' } : loadConfig();
    const outside = requireProject(loaded);
    if (outside) return outside;
    const { config, root } = loaded;
    const acting = deps.acting ?? loadActingCaptain(root, config);
    const p = handoverPolicy(config);
    const now = acting.why === 'captain' ? `@${acting.login ?? 'nobody'} (the captain)`
      : acting.why === 'handoff' ? `@${acting.login} (handed over until ${acting.until})` : `@${acting.login} (the captain has been quiet for over ${p.fallback_hours} h)`;
    return ok(`Acting captain: ${config.captain ? now : 'no captain in crew.config.json: anyone may decide'}`, {
      artifacts: { captain: config.captain ?? null, acting, policy: p, rule: explainPolicy(config) },
      next_actions: explainPolicy(config),
    });
  },
};

const handoff = {
  name: 'captain handoff',
  summary: 'Captain: hand the captain role to someone for a while (as the project rule allows)',
  args: [
    { name: 'to', type: 'string', positional: true, required: true, description: '@login of the deputy' },
    { name: 'hours', type: 'number', description: 'for how long (default 6, at most 72)' },
  ],
  run({ to, hours = 6 } = {}, deps = {}) {
    const loaded = deps.config ? { config: deps.config, root: '.', path: 'deps' } : loadConfig();
    const outside = requireProject(loaded);
    if (outside) return outside;
    const { config, root } = loaded;
    const login = deps.login !== undefined ? deps.login : myLogin();
    if (!config.captain) return fail('no_captain', 'This project has no captain in crew.config.json', { retry: 'crew up sets it' });
    if (lc(login) !== lc(config.captain)) return notTheCaptain(config.captain, login, 'hand over the captain role');
    const target = String(to).replace(/^@/, '');
    const problem = handoffProblem(target, config, { members: deps.members ?? (handoverPolicy(config).mode === 'team' ? members(root) : []) });
    if (problem) return fail('handoff_not_allowed', `Cannot hand the captain role to @${target}: ${problem}`, { retry: 'crew captain (shows the rule)', stop_when: 'the rule does not allow it: the repo owner changes it with crew captain policy' });
    const h = Math.min(Math.max(Number(hours) || 6, 1), 72);
    const until = new Date((deps.now ?? Date.now()) + h * 3_600_000).toISOString();
    const call = deps.gh ?? gh;
    let number = (deps.issue !== undefined ? deps.issue : captainIssue(root))?.number;
    if (!number) {
      const r = call(['issue', 'create', '--title', CAPTAIN_TITLE, '--label', CAPTAIN_LABEL, '--body', 'Who acts as captain: `crew captain handoff` / `crew captain back` comment here. Only the captain\'s own comments count.'], { cwd: root, allowFail: true });
      number = Number(/\/issues\/(\d+)/.exec(r.stdout ?? '')?.[1]);
      if (r.code !== 0 || !number) return fail('gh_failed', 'Could not create the captain log issue', { cause_hint: (r.stderr || r.stdout || '').split('\n')[0], retry: 'crew labels sync (the crew:captain label may be missing), then again' });
    }
    const c = call(['issue', 'comment', String(number), '--body', `${handoffMarker({ to: target, until })}\n👑 @${target} acts as captain until ${until} (handed over by @${login}).`], { cwd: root, allowFail: true });
    if (c.code !== 0) return fail('gh_failed', 'Could not record the handover', { cause_hint: (c.stderr || c.stdout || '').split('\n')[0], retry: 'crew captain handoff again' });
    return ok(`@${target} acts as captain until ${until}`, {
      artifacts: { to: target, until, log: number },
      next_actions: [`tell @${target}: you act as captain until ${until} (kickoff, ideas, questions for a human)`, 'back earlier: crew captain back'],
    });
  },
};

const back = {
  name: 'captain back',
  summary: 'Captain: end a handover now',
  args: [],
  run(_ = {}, deps = {}) {
    const loaded = deps.config ? { config: deps.config, root: '.', path: 'deps' } : loadConfig();
    const outside = requireProject(loaded);
    if (outside) return outside;
    const { config, root } = loaded;
    const login = deps.login !== undefined ? deps.login : myLogin();
    if (lc(login) !== lc(config.captain)) return notTheCaptain(config.captain, login, 'end a handover');
    const number = (deps.issue !== undefined ? deps.issue : captainIssue(root))?.number;
    if (!number) return ok('No handover to end', { next_actions: ['crew captain'] });
    const c = (deps.gh ?? gh)(['issue', 'comment', String(number), '--body', `${handbackMarker()}\n👑 @${login} is back as captain.`], { cwd: root, allowFail: true });
    if (c.code !== 0) return fail('gh_failed', 'Could not record it', { cause_hint: (c.stderr || c.stdout || '').split('\n')[0], retry: 'crew captain back again' });
    return ok(`@${login} acts as captain again`, { next_actions: ['crew task next'] });
  },
};

/** The new captain_handover object from flags (pure). -> { value } or { error } */
export function policyFrom({ mode, deputies, fallback_hours } = {}, current = {}) {
  const cur = handoverPolicy({ captain_handover: current });
  const m = mode ?? cur.mode;
  if (!HANDOVER_MODES.includes(m)) return { error: `--mode must be one of ${HANDOVER_MODES.join(', ')}` };
  const list = deputies !== undefined ? String(deputies).split(',').map((d) => d.trim().replace(/^@/, '')).filter(Boolean) : cur.deputies;
  if (list.some((d) => !/^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/.test(d))) return { error: '--deputies: GitHub logins, comma-separated' };
  const fh = fallback_hours !== undefined ? Number(fallback_hours) : cur.fallback_hours;
  if (!Number.isFinite(fh) || fh < 0 || fh > 168) return { error: '--fallback_hours: 0 (off) to 168' };
  if (fh > 0 && !list.length) return { error: 'automatic fallback needs at least one deputy (--deputies)' };
  if (m === 'deputies' && !list.length) return { error: 'mode deputies needs at least one deputy (--deputies)' };
  return { value: { mode: m, deputies: list, fallback_hours: m === 'off' ? 0 : fh } };
}

const policy = {
  name: 'captain policy',
  summary: 'Captain: change who the captain role may be handed to (off | deputies | team) and the automatic fallback',
  args: [
    { name: 'mode', type: 'string', enum: HANDOVER_MODES, description: 'off: nobody; deputies: listed people; team: anyone with write access' },
    { name: 'deputies', type: 'string', description: 'GitHub logins, comma-separated (the first one is the automatic fallback)' },
    { name: 'fallback_hours', type: 'number', description: 'hours of captain silence before the first deputy acts (0 = never)' },
  ],
  run(opts = {}, deps = {}) {
    const { config, root, path } = deps.config ? { config: deps.config, root: '.', path: null } : loadConfig();
    if (!deps.config) { const outside = requireProject({ path, root }); if (outside) return outside; }
    const login = deps.login !== undefined ? deps.login : myLogin();
    if (config.captain && lc(login) !== lc(config.captain)) return notTheCaptain(config.captain, login, 'change the handover rule');
    const p = policyFrom(opts, config.captain_handover);
    if (p.error) return fail('bad_input', p.error, { retry: 'crew captain policy --mode deputies --deputies alice,bob --fallback_hours 3' });
    const next = { ...config, captain_handover: p.value };
    if (!deps.config) {
      const file = path ?? join(root, 'crew.config.json');
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...raw, captain_handover: p.value }, null, 2) + '\n');
    }
    return ok(`Captain handover: ${p.value.mode}`, {
      artifacts: { captain_handover: p.value, rule: explainPolicy(next) },
      next_actions: [
        ...explainPolicy(next).map((l) => `explain to the team: ${l}`),
        'crew.config.json is a protected file: commit it on a branch and open a PR; crew-guard fails it on purpose and a human merges it (or the captain, as admin, pushes it to main)',
      ],
    });
  },
};

export default [status, handoff, back, policy];
