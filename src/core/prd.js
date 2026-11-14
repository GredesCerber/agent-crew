// docs/prd.md -> tasks and epics. Pure functions, no network: parser, linter, ordering, plan, issue bodies.
// The LLM writes only the PRD with ```crew-task / ```crew-epic blocks, this code does everything else (crew task lint, crew kickoff).
// Format: skills/crew-kickoff/task-format.md.
import { createHash } from 'node:crypto';
import { TIERS, parseMarkers } from './issues.js';

export const RISKS = ['low', 'med', 'high'];
export const DEFAULT_RISK = 'med';
export const TEST_KINDS = ['unit', 'contract', 'e2e'];
/** Areas where a mistake is expensive: risk: low is forbidden there. */
export const HIGH_STAKES_AREAS = ['contracts', 'infra'];
export const MAX_TASKS = 25;
export const DEFAULT_PRD = 'docs/prd.md';

const TASK_KEYS = ['id', 'title', 'epic', 'area', 'tier', 'risk', 'after', 'paths', 'contract', 'goal', 'acceptance', 'out_of_scope', 'tests', 'req', 'changes_acceptance', 'tests_for', 'skeleton', 'ready', 'independent'];
/**
 * Areas whose tasks do not wait for the skeleton (no code: mockups, research, docs). At the hackathon the
 * designer idled until the skeleton merged. A task elsewhere can opt out with `independent: true`.
 */
export const INDEPENDENT_AREAS = ['design', 'research'];
const EPIC_KEYS = ['id', 'title', 'scenario', 'demo'];
const TASK_REQUIRED = ['id', 'title', 'area', 'tier', 'goal', 'acceptance'];
const EPIC_REQUIRED = ['id', 'title', 'scenario'];
const LIST_KEYS = ['acceptance', 'after', 'paths', 'out_of_scope', 'tests', 'req', 'changes_acceptance'];
const BOOL_KEYS = ['skeleton', 'ready', 'independent'];

const err = (line, id, rule, message) => ({ line, id: id ?? null, rule, message });

const unquote = (s) => {
  const t = s.trim();
  return t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'")) ? t.slice(1, -1) : t;
};

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) return { error: 'list is not closed: missing "]"' };
    return { value: v.slice(1, -1).split(',').map(unquote).filter((x) => x !== '') };
  }
  return { value: unquote(v) };
}

/** Body of one block (lines without fences) -> { fields, lines, errors }. */
function parseBlock(kind, body, firstLine) {
  const allowed = kind === 'task' ? TASK_KEYS : EPIC_KEYS;
  const fields = {};
  const lines = {};
  const errors = [];
  let listKey = null;
  body.forEach((text, k) => {
    const lineNo = firstLine + k;
    if (!text.trim() || /^\s*#/.test(text)) return;
    const item = /^\s*-\s+(.*)$/.exec(text) ?? (/^\s*-$/.test(text) ? [text, ''] : null);
    if (item) {
      if (!listKey) return errors.push(err(lineNo, fields.id, 'syntax', 'list item "- ..." without a key above (needs "key:" on its own line)'));
      const v = unquote(item[1].replace(/^\[[ xX]\]\s+/, ''));
      if (v) fields[listKey].push(v);
      return;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(text);
    if (!kv) {
      listKey = null;
      return errors.push(err(lineNo, fields.id, 'syntax', `cannot parse line: "${text.trim()}" (expected "key: value", "key: [a, b]" or "  - item")`));
    }
    const key = kv[1];
    listKey = null;
    if (!allowed.includes(key)) return errors.push(err(lineNo, fields.id, 'unknown_key', `unknown key "${key}" in crew-${kind} (allowed: ${allowed.join(', ')})`));
    if (key in fields) return errors.push(err(lineNo, fields.id, 'duplicate_key', `key "${key}" is repeated`));
    lines[key] = lineNo;
    const raw = kv[2]?.trim() ?? '';
    if (raw === '') {
      fields[key] = [];
      listKey = key;
      return;
    }
    const pv = parseValue(raw);
    if (pv.error) return errors.push(err(lineNo, fields.id, 'syntax', `${key}: ${pv.error}`));
    fields[key] = pv.value;
  });
  // Type normalization: lists are always arrays, flags are boolean, the rest are strings.
  for (const [key, v] of Object.entries(fields)) {
    if (LIST_KEYS.includes(key)) {
      if (!Array.isArray(v)) fields[key] = [v];
    } else if (BOOL_KEYS.includes(key)) {
      if (v === 'true' || v === 'false') fields[key] = v === 'true';
      else errors.push(err(lines[key], fields.id, 'type', `${key}: only true or false`));
    } else if (Array.isArray(v)) {
      if (v.length === 0) delete fields[key]; // "key:" without items = empty
      else if (key === 'area') errors.push(err(lines[key], fields.id, 'one_area', 'one task, one area: area must be a single string'));
      else errors.push(err(lines[key], fields.id, 'type', `${key}: expected a single string, not a list`));
    }
  }
  return { fields, lines, errors };
}

/**
 * Markdown -> { tasks, epics, errors }. Only fenced ```crew-task and ```crew-epic blocks count, the rest is text.
 * Block: { kind, line (line of the opening ```), id, fields, lines: { key: line number } }.
 */
export function parsePrd(text = '') {
  const src = text.split(/\r?\n/);
  const tasks = [];
  const epics = [];
  const errors = [];
  let team = null;
  for (let i = 0; i < src.length; i++) {
    if (/^\s*```crew-team\s*$/.test(src[i])) {
      let end = i + 1;
      while (end < src.length && !/^\s*```\s*$/.test(src[end])) end++;
      if (end >= src.length) {
        errors.push(err(i + 1, null, 'syntax', 'crew-team block is not closed with a ``` line'));
        break;
      }
      if (team) errors.push(err(i + 1, null, 'team_many', `only one crew-team block is allowed (already one on line ${team.line})`));
      else team = parseTeam(src.slice(i + 1, end), i + 2, errors);
      i = end;
      continue;
    }
    const open = /^\s*```crew-(task|epic)\s*$/.exec(src[i]);
    if (!open) continue;
    const kind = open[1];
    let end = i + 1;
    while (end < src.length && !/^\s*```\s*$/.test(src[end])) end++;
    if (end >= src.length) {
      errors.push(err(i + 1, null, 'syntax', `crew-${kind} block is not closed with a \`\`\` line`));
      break;
    }
    const { fields, lines, errors: e } = parseBlock(kind, src.slice(i + 1, end), i + 2);
    errors.push(...e);
    const block = { kind, line: i + 1, id: typeof fields.id === 'string' ? fields.id : null, fields, lines };
    (kind === 'task' ? tasks : epics).push(block);
    i = end;
  }
  return { tasks, epics, errors, team };
}

/** GitHub login: letters, digits, hyphens (no -- and no hyphen at the ends). */
export const LOGIN_RE = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;
/** Special "area" in crew-team: this person (their agent) reviews PRs before their own tasks. */
export const REVIEW_ROLE = 'review';

/**
 * Team block: who is responsible for which areas. Lines `login: area1, area2  # role/note`.
 * The `review` area is the team reviewer (usually the captain).
 * -> { line, members: [{ login, areas, review, note, line }] }
 */
function parseTeam(body, firstLine, errors) {
  const members = [];
  body.forEach((raw, k) => {
    const line = firstLine + k;
    const [main, ...rest] = raw.split('#');
    const note = rest.join('#').trim();
    if (!main.trim()) return;
    const m = /^\s*@?([^\s:]+)\s*:\s*(.*)$/.exec(main);
    if (!m) {
      errors.push(err(line, null, 'team_syntax', `expected "login: area1, area2", not "${raw.trim()}"`));
      return;
    }
    const all = m[2].trim().replace(/^\[|\]$/g, '').split(',').map((a) => unquote(a)).filter(Boolean);
    members.push({ login: m[1], areas: all.filter((a) => a !== REVIEW_ROLE), review: all.includes(REVIEW_ROLE), note, line });
  });
  return { line: firstLine - 1, members };
}

/** Area owner from the crew-team block: { web: 'alice', ... }. */
export function areaOwners(team) {
  const out = {};
  for (const m of team?.members ?? []) for (const a of m.areas) out[a] ??= m.login;
  return out;
}

/** Team reviewers (review area in crew-team). */
export const teamReviewers = (team) => (team?.members ?? []).filter((m) => m.review).map((m) => m.login);

/** PRD approval header: <!-- crew:prd status: approved by: <login|auto-timeout> at: ISO -->. */
export const PRD_HEADER_RE = /^\s*<!--\s*(?:crew|hk):prd\s+status:\s*([\w-]+)(?:\s+by:\s*(\S+))?(?:\s+at:\s*(\S+))?\s*-->\s*$/m;

export function prdApproval(text = '') {
  const m = PRD_HEADER_RE.exec(text);
  if (!m) return { status: null, by: null, at: null, approved: false };
  return { status: m[1], by: m[2] ?? null, at: m[3] ?? null, approved: m[1] === 'approved' };
}

// Keywords as standalone words (Unicode: \b in JS does not work with Cyrillic).
const kw = (w) => `(?<![\\p{L}\\p{N}_])${w}(?![\\p{L}\\p{N}_])[\\s:,—-]*\\S`;
const GWT = [
  new RegExp(`^${kw('given')}.*?${kw('when')}.*?${kw('then')}`, 'iu'),
  new RegExp(`^${kw('дано')}.*?${kw('когда')}.*?${kw('тогда')}`, 'iu'),
];
/** Acceptance criterion: Given ... When ... Then ... or its Russian equivalent (case-insensitive, order matters). */
export const isAcceptance = (s) => GWT.some((re) => re.test(String(s).trim()));

/**
 * Definition of Ready, checked by code so any team member (agent included) may set status:ready, not only a
 * product lead who may be away or out of usage. -> list of problems (empty = ready). issue: { labels, body }.
 */
export function readyProblems(issue) {
  const labels = (issue?.labels ?? []).map((l) => l.name);
  const problems = [];
  if (labels.includes('epic')) problems.push('an epic is not taken by agents: split it into tasks');
  if (!labels.some((l) => l.startsWith('area:'))) problems.push('no area:* label (whose area is it?)');
  const criteria = String(issue?.body ?? '').split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, '').trim())
    .filter((l) => isAcceptance(l) && !/\.\.\./.test(l));
  if (!criteria.length) problems.push('no acceptance criterion in the body ("- [ ] Given … When … Then …", each verifiable by a test)');
  return problems;
}

const riskOf = (t) => t.fields.risk ?? DEFAULT_RISK;
const skeletonOf = (tasks) => tasks.find((t) => t.fields.skeleton === true) ?? null;

/**
 * Task dependencies: explicit after + implicit on the skeleton (for all except the skeleton itself)
 * + the task for its acceptance tests (tests_for: <this task>), since tests are written before code.
 */
export function depsOf(task, skeletonId, tasks = []) {
  const out = [...(task.fields.after ?? [])];
  const independent = task.fields.independent === true || INDEPENDENT_AREAS.includes(task.fields.area);
  if (skeletonId && task.id !== skeletonId && !independent && !out.includes(skeletonId)) out.unshift(skeletonId);
  for (const t of tasks) if (t.fields.tests_for === task.id && t.id && !out.includes(t.id)) out.push(t.id);
  return out;
}

/** Folder where a tests task puts tests for task <id>: code does not see them yet, CI does not run them. */
export const pendingDir = (id) => `tests/pending/${id}/`;

/** Cycle in explicit after -> path ['T2', 'T4', 'T2'] or null. */
export function findCycle(tasks) {
  const byId = new Map(tasks.filter((t) => t.id).map((t) => [t.id, t]));
  const state = new Map(); // 1 = on the stack, 2 = done
  const stack = [];
  const dfs = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id).fields.after ?? []) {
      if (!byId.has(d)) continue;
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.get(d)) {
        const c = dfs(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of byId.keys()) {
    if (!state.get(id)) {
      const c = dfs(id);
      if (c) return c;
    }
  }
  return null;
}

/**
 * Topological order of tasks (dependency before dependent), ties keep PRD order.
 * Unknown dependencies are ignored (the linter catches them). On a cycle: { order: partial, cycle: [...] }.
 */
export function topoOrder(tasks) {
  const skel = skeletonOf(tasks)?.id ?? null;
  const ids = new Set(tasks.map((t) => t.id));
  const placed = new Set();
  const order = [];
  let progress = true;
  while (order.length < tasks.length && progress) {
    progress = false;
    for (const t of tasks) {
      if (placed.has(t.id)) continue;
      if (depsOf(t, skel, tasks).every((d) => !ids.has(d) || d === t.id || placed.has(d))) {
        order.push(t);
        placed.add(t.id);
        progress = true;
        break; // restart from the beginning to keep PRD order
      }
    }
  }
  return { order, cycle: order.length < tasks.length ? findCycle(tasks) ?? tasks.filter((t) => !placed.has(t.id)).map((t) => t.id) : null };
}

/** Path inside an area: the static path prefix starts with the static prefix of one of the area's globs. */
export function pathInArea(path, globs = []) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const p = norm(path);
  return globs.some((g0) => {
    const g = norm(g0);
    const wild = g.search(/[*?[{]/);
    if (wild === -1) return p === g || p.startsWith(g.replace(/\/$/, '') + '/');
    const prefix = g.slice(0, wild);
    if (!prefix) return true;
    return p.startsWith(prefix) || (prefix.endsWith('/') && p === prefix.slice(0, -1));
  });
}

/**
 * PRD check. Collects ALL errors at once. -> { errors, warnings, order } (item: { line, id, rule, message }).
 * areas is crew.config.json -> areas ({ web: ['web/**'], ... }).
 */
export function lintPrd(parsed, { areas = {} } = {}) {
  const errors = [...parsed.errors];
  const warnings = [];
  const { tasks, epics } = parsed;
  if (!tasks.length) errors.push(err(1, null, 'no_blocks', 'the PRD has no ```crew-task block'));

  const seen = new Map();
  const checkId = (b, re, what) => {
    const id = b.fields.id;
    if (typeof id !== 'string' || !id) return;
    if (!re.test(id)) errors.push(err(b.lines.id, id, 'bad_id', `id "${id}": expected ${what}`));
    else if (seen.has(id)) errors.push(err(b.lines.id, id, 'duplicate_id', `id ${id} already exists (line ${seen.get(id)})`));
    else seen.set(id, b.lines.id);
  };
  const required = (b, keys) => {
    for (const k of keys) {
      const v = b.fields[k];
      if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) errors.push(err(b.line, b.id, 'required', `missing required field "${k}"`));
    }
  };

  for (const e of epics) {
    checkId(e, /^E\d+$/, 'E<number>, e.g. E1');
    required(e, EPIC_REQUIRED);
  }
  const taskIds = new Set();
  const epicIds = new Set(epics.map((e) => e.id).filter(Boolean));
  for (const t of tasks) {
    checkId(t, /^T\d+$/, 'T<number>, e.g. T2');
    if (t.id) taskIds.add(t.id);
  }

  const skeletons = tasks.filter((t) => t.fields.skeleton === true);
  if (tasks.length && tasks[0].fields.skeleton !== true) {
    errors.push(err(tasks[0].line, tasks[0].id, 'skeleton_first', 'the first crew-task block must be the skeleton: skeleton: true'));
  }
  for (const s of skeletons.slice(1)) errors.push(err(s.lines.skeleton ?? s.line, s.id, 'skeleton_many', `only one skeleton is allowed (already ${skeletons[0].id})`));
  const skel = skeletons[0] ?? null;
  if (skel) {
    if (skel.fields.tier !== 'high') errors.push(err(skel.lines.tier ?? skel.line, skel.id, 'skeleton_tier', 'the skeleton must be tier: high'));
    if (riskOf(skel) !== 'high') errors.push(err(skel.lines.risk ?? skel.line, skel.id, 'skeleton_risk', 'the skeleton must be risk: high'));
    if ((skel.fields.after ?? []).length) errors.push(err(skel.lines.after, skel.id, 'skeleton_after', 'the skeleton cannot have after: it comes first'));
  }

  const titles = new Map();
  const byId = new Map(tasks.filter((t) => t.id).map((t) => [t.id, t]));
  const testsFor = new Map(); // target -> tests task
  for (const t of tasks) {
    const f = t.fields;
    const L = (k) => t.lines[k] ?? t.line;
    // A tests task takes its target and criteria from the tests_for task.
    required(t, f.tests_for ? TASK_REQUIRED.filter((k) => !['goal', 'acceptance'].includes(k)) : TASK_REQUIRED);
    if (f.tests_for !== undefined) {
      const target = byId.get(f.tests_for);
      if (f.tests_for === t.id) errors.push(err(L('tests_for'), t.id, 'self_ref', 'tests_for refers to the task itself'));
      else if (!target) errors.push(err(L('tests_for'), t.id, 'unknown_ref', `tests_for: no task ${f.tests_for}`));
      else {
        if (target === skel) errors.push(err(L('tests_for'), t.id, 'tests_for_skeleton', 'the skeleton comes first, so a separate tests task for it is impossible; the skeleton writes its own tests'));
        if (target.fields.tests_for) errors.push(err(L('tests_for'), t.id, 'tests_for_tests', `${f.tests_for} is itself a tests task`));
        if ((f.after ?? []).includes(f.tests_for)) errors.push(err(L('after'), t.id, 'cycle', `tests are written BEFORE ${f.tests_for}, not after: remove ${f.tests_for} from after`));
        if (testsFor.has(f.tests_for)) errors.push(err(L('tests_for'), t.id, 'tests_for_duplicate', `${f.tests_for} already has tests task ${testsFor.get(f.tests_for)}`));
        else testsFor.set(f.tests_for, t.id);
      }
      if (typeof f.area === 'string' && areas[f.area] && !pathInArea(`${pendingDir(f.tests_for)}x`, areas[f.area])) {
        errors.push(err(L('area'), t.id, 'tests_area', `area ${f.area} does not include tests/pending/**: a tests task needs an area with tests (e.g. e2e)`));
      }
    }
    if (typeof f.area === 'string' && f.area) {
      if (!(f.area in areas)) errors.push(err(L('area'), t.id, 'unknown_area', `area "${f.area}" is not in crew.config.json -> areas (${Object.keys(areas).join(', ')})`));
    }
    if (f.tier !== undefined && !TIERS.includes(f.tier)) errors.push(err(L('tier'), t.id, 'enum', `tier: one of ${TIERS.join(', ')}`));
    if (f.risk !== undefined && !RISKS.includes(f.risk)) errors.push(err(L('risk'), t.id, 'enum', `risk: one of ${RISKS.join(', ')}`));
    for (const k of f.tests ?? []) if (!TEST_KINDS.includes(k)) errors.push(err(L('tests'), t.id, 'enum', `tests: "${k}" is not valid, allowed: ${TEST_KINDS.join(', ')}`));
    for (const r of f.req ?? []) if (!/^R\d+$/.test(r)) errors.push(err(L('req'), t.id, 'req_format', `req: "${r}": expected R<number> from docs/brief-analysis.md`));
    for (const p of f.changes_acceptance ?? []) {
      if (!/^tests\/acceptance\/\S+$/.test(p)) errors.push(err(L('changes_acceptance'), t.id, 'changes_acceptance_path', `changes_acceptance: "${p}": expected a path inside tests/acceptance/`));
    }
    for (const a of f.acceptance ?? []) {
      if (!isAcceptance(a)) errors.push(err(L('acceptance'), t.id, 'acceptance_format', `criterion does not match "Given ... When ... Then ..." (or its Russian equivalent): "${a}"`));
    }
    for (const d of f.after ?? []) {
      if (d === t.id) errors.push(err(L('after'), t.id, 'self_ref', 'after refers to the task itself'));
      else if (!taskIds.has(d)) errors.push(err(L('after'), t.id, 'unknown_ref', `after: no task ${d}`));
    }
    if (f.epic !== undefined && !epicIds.has(f.epic)) errors.push(err(L('epic'), t.id, 'unknown_ref', `epic: no epic ${f.epic}`));
    if (f.risk === 'low' && t !== skel && HIGH_STAKES_AREAS.includes(f.area)) {
      errors.push(err(L('risk'), t.id, 'risk_too_low', `risk: low is not allowed for area ${f.area}: minimum is med`));
    }
    if (t !== skel && typeof f.area === 'string' && areas[f.area]) {
      const outside = (f.paths ?? []).filter((p) => !pathInArea(p, areas[f.area]));
      if (outside.length) {
        errors.push(err(L('paths'), t.id, 'paths_outside_area', `one task, one area: paths outside ${f.area} (${areas[f.area].join(', ')}): ${outside.join(', ')}. Only the skeleton may go beyond its area`));
      }
    }
    if (riskOf(t) === 'high' && !(f.tests ?? []).includes('e2e')) {
      warnings.push(err(L('risk'), t.id, 'high_without_e2e', 'risk: high without e2e in tests: E2E is mandatory for high'));
    }
    if (typeof f.title === 'string' && f.title) {
      const key = f.title.trim().toLowerCase();
      if (titles.has(key)) warnings.push(err(L('title'), t.id, 'duplicate_title', `same title as ${titles.get(key)}`));
      else titles.set(key, t.id);
    }
  }
  // risk:high (except the skeleton): acceptance tests are written by another agent, as a separate tests_for task.
  for (const t of tasks) {
    if (t !== skel && !t.fields.tests_for && riskOf(t) === 'high' && t.id && !testsFor.has(t.id)) {
      errors.push(err(t.lines.risk ?? t.line, t.id, 'high_without_tests_task', `risk: high needs a separate acceptance tests task: a crew-task block with tests_for: ${t.id} (tests and code are written by different agents)`));
    }
  }
  const cycle = findCycle(tasks.filter((t) => t.id && taskIds.has(t.id)));
  if (cycle) {
    const first = tasks.find((t) => t.id === cycle[0]);
    errors.push(err(first?.lines.after ?? first?.line ?? 1, cycle[0], 'cycle', `dependency cycle: ${cycle.join(' -> ')}`));
  }
  if (tasks.length > MAX_TASKS) warnings.push(err(1, null, 'too_many_tasks', `${tasks.length} tasks > ${MAX_TASKS}: cut the scope`));
  for (const e of epics) {
    if (e.id && !tasks.some((t) => t.fields.epic === e.id)) warnings.push(err(e.line, e.id, 'empty_epic', `epic ${e.id} contains no tasks`));
  }
  lintTeam(parsed, { areas, errors, warnings });
  errors.sort((a, b) => a.line - b.line);
  return { errors, warnings, order: cycle ? [] : topoOrder(tasks).order.map((t) => t.id) };
}

/** crew-team block: every area with tasks has exactly one owner, every member has work. */
function lintTeam({ tasks, team }, { areas, errors, warnings }) {
  if (!team) {
    if (tasks.length) warnings.push(err(1, null, 'no_team', 'no crew-team block: tasks will not be assigned to people (who owns which area, who reviews)'));
    return;
  }
  if (!team.members.length) errors.push(err(team.line, null, 'team_empty', 'the crew-team block is empty: lines "login: area1, area2"'));
  const owner = new Map();
  const logins = new Set();
  for (const m of team.members) {
    if (!LOGIN_RE.test(m.login)) errors.push(err(m.line, null, 'team_login', `"${m.login}" does not look like a GitHub login`));
    const key = m.login.toLowerCase();
    if (logins.has(key)) errors.push(err(m.line, null, 'team_duplicate', `${m.login} is already in the crew-team block: put all of a person's areas on one line`));
    logins.add(key);
    if (!m.areas.length && !m.review) errors.push(err(m.line, null, 'team_no_areas', `${m.login} has no areas: at least one (or review)`));
    for (const a of m.areas) {
      if (!(a in areas)) errors.push(err(m.line, null, 'unknown_area', `area "${a}" is not in crew.config.json -> areas (${Object.keys(areas).join(', ')}) or review`));
      else if (owner.has(a)) errors.push(err(m.line, null, 'area_two_owners', `area ${a} already has owner ${owner.get(a)}: an area has one owner`));
      else owner.set(a, m.login);
    }
  }
  if (team.members.length && !team.members.some((m) => m.review)) {
    warnings.push(err(team.line, null, 'no_reviewer', 'crew-team has no reviewer (review area, usually the captain): PRs will wait for a random review'));
  }
  const load = new Map(team.members.map((m) => [m.login, 0]));
  const noOwner = new Map();
  for (const t of tasks) {
    const a = t.fields.area;
    if (typeof a !== 'string' || !(a in areas)) continue;
    if (owner.has(a)) load.set(owner.get(a), load.get(owner.get(a)) + 1);
    else if (!noOwner.has(a)) noOwner.set(a, t);
  }
  for (const [a, t] of noOwner) errors.push(err(t.lines.area ?? t.line, t.id, 'area_no_owner', `area ${a} has no owner in the crew-team block: assign it to someone on the team`));
  for (const m of team.members) {
    if (load.get(m.login) === 0 && !m.review) warnings.push(err(m.line, null, 'member_idle', `${m.login} has no tasks in their areas (${m.areas.join(', ') || '-'}): give them an area with tasks`));
  }
  // Nobody should wait for someone else's task at the start: each member needs a task that is ready right after kickoff.
  const skel = tasks.find((t) => t.fields.skeleton === true);
  const startable = new Map(team.members.map((m) => [m.login, 0]));
  for (const t of tasks) {
    const o = owner.get(t.fields.area);
    // ready at kickoff, or right after the skeleton (which everyone waits for briefly)
    if (o && (t === skel || depsOf(t, skel?.id ?? null, tasks).every((d) => d === skel?.id))) startable.set(o, startable.get(o) + 1);
  }
  for (const m of team.members) {
    if (load.get(m.login) > 0 && startable.get(m.login) === 0) {
      warnings.push(err(m.line, null, 'member_waits', `every task of ${m.login} waits for other people's tasks: add one that can start right away (area ${INDEPENDENT_AREAS.join('/')}, docs, or independent: true)`));
    }
  }
  const counts = [...load.values()].filter((n) => n > 0);
  if (counts.length > 1 && Math.max(...counts) >= 3 && Math.max(...counts) > 2 * Math.min(...counts)) {
    warnings.push(err(team.line, null, 'team_imbalance', `uneven load: ${[...load].map(([l, n]) => `${l} ${n}`).join(', ')}: redistribute areas or tasks`));
  }
}

/** Stable content hash of a block (12 hex): changes when fields change, not whitespace. */
export function taskHash(block) {
  const canon = Object.fromEntries(Object.keys(block.fields).sort().map((k) => [k, block.fields[k]]));
  return createHash('sha256').update(JSON.stringify({ kind: block.kind, ...canon })).digest('hex').slice(0, 12);
}

const ref = (n) => (n ? `#${n}` : '#?');
const section = (title, body) => `### ${title}\n\n${body}\n`;

/**
 * Task issue body: the same sections as .github/ISSUE_TEMPLATE/task.yml, plus dependencies and markers.
 * issueOf: { T1: 12, E1: 30 } are the numbers of already created issues.
 */
export function renderTaskBody(task, { issueOf = {}, prd = DEFAULT_PRD, skeletonId = null, epics = [], tasks = [] } = {}) {
  const f = task.fields;
  const deps = depsOf(task, skeletonId, tasks);
  const target = f.tests_for ? tasks.find((t) => t.id === f.tests_for) : null;
  const testsTask = tasks.find((t) => t.fields.tests_for === task.id) ?? null;
  const parts = [section('Goal', f.goal ?? (f.tests_for ? `Acceptance tests for ${f.tests_for}${target?.fields.title ? ` - ${target.fields.title}` : ''}` : ''))];
  const criteria = f.tests_for && !(f.acceptance ?? []).length ? target?.fields.acceptance ?? [] : f.acceptance ?? [];
  parts.push(section(f.tests_for ? `Criteria of task ${f.tests_for}: cover each with a test` : 'Acceptance criteria', criteria.map((a) => `- [ ] ${a}`).join('\n')));
  if (f.tests_for) {
    parts.push(section('Tests task', [
      `Write acceptance tests for ${ref(issueOf[f.tests_for])} (${f.tests_for}) **only** in \`${pendingDir(f.tests_for)}\`. Do not write product code.`,
      'The tests must fail on code without the implementation and pass once the criteria are met. CI does not run them yet.',
      `The code for ${f.tests_for} is written by **another agent**: they will move these files to \`tests/acceptance/\` unchanged (crew-guard checks this).`,
    ].join('\n')));
  }
  if (testsTask) {
    parts.push(section('Acceptance tests', [
      `Written by a separate task ${ref(issueOf[testsTask.id])} (${testsTask.id}) by another agent, before you. You do not take it.`,
      `Move them unchanged in the first commit: \`git mv ${pendingDir(task.id)}* tests/acceptance/\`. Do not edit these tests: the PR will not pass crew-guard.`,
    ].join('\n')));
  }
  if (f.contract) parts.push(section('Contract', f.contract));
  if (f.paths?.length) parts.push(section('Allowed paths', f.paths.map((p) => `\`${p}\``).join(', ')));
  if (f.out_of_scope?.length) parts.push(section('Out of scope', f.out_of_scope.map((x) => `- ${x}`).join('\n')));
  parts.push(section('Risk', riskOf(task)));
  if (f.tests?.length) parts.push(section('Required tests', f.tests.map((x) => `- [ ] ${x}`).join('\n')));
  if (f.req?.length) parts.push(section('Brief requirements', f.req.map((r) => `- ${r}`).join('\n')));
  // Read by crew guard: the task's PR may change only the existing acceptance tests listed here.
  if (f.changes_acceptance?.length) parts.push(section('Changes acceptance', f.changes_acceptance.map((p) => `- \`${p}\``).join('\n')));
  if (f.epic) {
    const e = epics.find((x) => x.id === f.epic);
    parts.push(section('Epic', `${issueOf[f.epic] ? `#${issueOf[f.epic]} ` : ''}${f.epic}${e?.fields.title ? ` - ${e.fields.title}` : ''}`));
  }
  if (deps.length) parts.push(section('Dependencies', `After ${deps.map((d) => ref(issueOf[d])).join(', ')} (${deps.join(', ')})`));
  if (f.ready === false) parts.push('> ⚠ Marked `ready: false` in the PRD: the spec needs more work, agents do not take it.\n');
  const markers = [`<!-- crew:task id=${task.id} hash=${taskHash(task)} prd=${prd} -->`];
  if (deps.length) markers.push(`<!-- crew:after issues=${deps.map((d) => issueOf[d] ?? '?').join(',')} -->`);
  // Read by crew guard (what may be touched) and crew task claim (tests and code are by different agents).
  if (f.tests_for) markers.push(`<!-- crew:tests-for task=${f.tests_for} -->`);
  if (testsTask) markers.push(`<!-- crew:tests issue=${issueOf[testsTask.id] ?? '?'} task=${testsTask.id} -->`);
  return `${parts.join('\n')}\n${markers.join('\n')}\n`;
}

/** Epic body: scenario, demo, task list with numbers, marker. */
export function renderEpicBody(epic, tasks, { issueOf = {}, prd = DEFAULT_PRD } = {}) {
  const members = tasks.filter((t) => t.fields.epic === epic.id);
  const parts = [section('User scenario', epic.fields.scenario ?? '')];
  parts.push(section('Tasks', members.length ? members.map((t) => `- [ ] ${ref(issueOf[t.id])} ${t.fields.title} (${t.id})`).join('\n') : '-'));
  if (epic.fields.demo) parts.push(section('How to demo', epic.fields.demo));
  return `${parts.join('\n')}\n<!-- crew:epic id=${epic.id} hash=${epicHash(epic, members)} prd=${prd} -->\n`;
}

const epicHash = (epic, members) => taskHash({ kind: 'epic', fields: { ...epic.fields, tasks: members.map((t) => t.id) } });

/** Task labels. Status: ready: false -> needs-spec; open dependencies -> waiting; otherwise ready. */
export function taskLabels(task, { waiting }) {
  const status = task.fields.ready === false ? 'needs-spec' : waiting ? 'waiting' : 'ready';
  return [`status:${status}`, `area:${task.fields.area}`, `tier:${task.fields.tier}`, `risk:${riskOf(task)}`];
}

/** crew:task / crew:epic markers in the bodies of existing issues -> Map(id -> { number, hash, state, prd }). */
export function indexExisting(existing = []) {
  const tasks = new Map();
  const epics = new Map();
  const dropped = [];
  for (const i of existing) {
    // Closed as "not planned" (the plan was replaced): the task is gone, so create it anew.
    if (String(i.state ?? '').toUpperCase() === 'CLOSED' && String(i.stateReason ?? '').toUpperCase() === 'NOT_PLANNED') {
      for (const m of parseMarkers([{ body: i.body ?? '' }])) if (m.id && (m.kind === 'task' || m.kind === 'epic')) dropped.push({ id: m.id, number: i.number });
      continue;
    }
    for (const m of parseMarkers([{ body: i.body ?? '' }])) {
      const entry = { number: i.number, hash: m.hash ?? null, prd: m.prd ?? null, state: String(i.state ?? 'OPEN').toUpperCase(), title: i.title };
      if (m.kind === 'task' && m.id && !tasks.has(m.id)) tasks.set(m.id, entry);
      if (m.kind === 'epic' && m.id && !epics.has(m.id)) epics.set(m.id, entry);
    }
  }
  return { tasks, epics, dropped };
}

/**
 * Kickoff plan (pure function). existing is the repo's issues: [{ number, title, body, labels, state }].
 * -> { ops, warnings, map }. ops in execution order: tasks topologically, epics last.
 *   op: 'create' | 'skip' (marker exists, same block) | 'changed' (marker exists, block changed: report only)
 *       | 'orphan' (issue with a marker that is no longer in the PRD: report only).
 * No syncing: existing issues are not changed (rerun is idempotent).
 */
export function planKickoff(parsed, existing = [], { prd = DEFAULT_PRD } = {}) {
  const { tasks: have, epics: haveEpics, dropped } = indexExisting(existing);
  const skel = skeletonOf(parsed.tasks)?.id ?? null;
  const owners = areaOwners(parsed.team);
  const ops = [];
  const warnings = [];
  const map = {};
  for (const t of topoOrder(parsed.tasks).order) {
    const deps = depsOf(t, skel, parsed.tasks);
    const found = have.get(t.id);
    if (found) {
      map[t.id] = found.number;
      const changed = found.hash && found.hash !== taskHash(t);
      ops.push({ op: changed ? 'changed' : 'skip', kind: 'task', id: t.id, title: t.fields.title, number: found.number, after: deps });
      if (changed) warnings.push(found.state === 'CLOSED'
        ? `${t.id} is already done in closed #${found.number}, but the PRD block differs: give the task a new id (T...) for new work`
        : `${t.id} (#${found.number}) changed in the PRD after the issue was created: leaving the issue alone, edit it by hand`);
      continue;
    }
    map[t.id] = null;
    // The dependency is already closed (repeat kickoff): nothing to wait for.
    const waiting = deps.some((d) => have.get(d)?.state !== 'CLOSED');
    const assignee = owners[t.fields.area] ?? null;
    ops.push({ op: 'create', kind: 'task', id: t.id, title: t.fields.title, labels: taskLabels(t, { waiting }), after: deps, ...(assignee ? { assignee } : {}) });
  }
  for (const e of parsed.epics) {
    const found = haveEpics.get(e.id);
    const members = parsed.tasks.filter((t) => t.fields.epic === e.id).map((t) => t.id);
    if (found) {
      map[e.id] = found.number;
      const changed = found.hash && found.hash !== epicHash(e, parsed.tasks.filter((t) => t.fields.epic === e.id));
      ops.push({ op: changed ? 'changed' : 'skip', kind: 'epic', id: e.id, title: e.fields.title, number: found.number, tasks: members });
      if (changed) warnings.push(`epic ${e.id} (#${found.number}) changed in the PRD: leaving the issue alone, edit it by hand`);
      continue;
    }
    map[e.id] = null;
    ops.push({ op: 'create', kind: 'epic', id: e.id, title: e.fields.title, labels: ['epic'], tasks: members });
  }
  const ids = new Set([...parsed.tasks, ...parsed.epics].map((b) => b.id));
  for (const d of dropped) {
    if (ids.has(d.id) && !have.has(d.id) && !haveEpics.has(d.id)) warnings.push(`${d.id}: the old #${d.number} was closed as "not planned": creating a new issue`);
  }
  for (const [id, found] of [...have, ...haveEpics]) {
    if (ids.has(id) || (found.prd && found.prd !== prd)) continue;
    ops.push({ op: 'orphan', kind: id.startsWith('E') ? 'epic' : 'task', id, title: found.title, number: found.number });
    warnings.push(`${id} (#${found.number}) is in issues but not in the PRD: leaving the issue alone, close it by hand if not needed`);
  }
  return { ops, warnings, map };
}

/** Short linter error text for a human/agent. */
export const formatLintItem = (e) => `line ${e.line}${e.id ? ` [${e.id}]` : ''} ${e.rule}: ${e.message}`;
