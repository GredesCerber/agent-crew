// crew discover plan [--apply] | crew discover status
// The discovery phase (no product code): research questions from docs/discovery.md become tasks for the area owners;
// status checks the exit criteria that crew kickoff --apply waits for. See src/core/discovery.js.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, warn, fail } from '../core/output.js';
import { gh, ghJson, run, git } from '../core/exec.js';
import { loadConfig, requireProject } from '../core/config.js';
import { HUMAN_LABEL, QUESTION_LABEL } from '../core/questions.js';
import { hasCaptainPowers } from '../core/captain.js';
import { loadActingCaptain } from './captain.js';
import {
  RESEARCH_LABEL, DISCOVERY_DOC, DECISIONS_DOC, phaseOf, parseResearch, researchIdOf, researchTitle, researchBody, exitCriteria,
} from '../core/discovery.js';

const read = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '');
const myLogin = () => {
  const r = run('gh', ['api', 'user', '--jq', '.login'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() || null : null;
};

/** Research issues, open and closed (body for the id marker, state for the exit criteria). */
const researchIssues = (root) => ghJson(['issue', 'list', '--state', 'all', '--label', RESEARCH_LABEL, '--limit', '200', '--json', 'number,title,body,state,labels'], { cwd: root, allowFail: true }) ?? [];

/** Everything the exit criteria look at, from this checkout and GitHub. */
export function loadDiscoveryStatus(root) {
  const discoveryText = read(root, DISCOVERY_DOC);
  git(['fetch', '--quiet', 'origin', 'main'], { cwd: root, allowFail: true });
  const prd = git(['show', 'origin/main:docs/prd.md'], { cwd: root, allowFail: true });
  return exitCriteria({
    planned: parseResearch(discoveryText).items,
    research: researchIssues(root),
    humanOpen: (ghJson(['issue', 'list', '--state', 'open', '--label', `${QUESTION_LABEL},${HUMAN_LABEL}`, '--limit', '100', '--json', 'number'], { cwd: root, allowFail: true }) ?? []),
    discoveryText,
    decisionsText: read(root, DECISIONS_DOC),
    prdOnMain: prd.code === 0 ? prd.stdout : null,
  });
}

const plan = {
  name: 'discover plan',
  summary: 'Turn the research questions of docs/discovery.md into research tasks (dry-run; --apply creates them, captain)',
  args: [{ name: 'apply', type: 'boolean', description: 'create the missing research tasks (the captain or the acting captain)' }],
  run({ apply = false } = {}, deps = {}) {
    const loaded = deps.config ? { config: deps.config, root: deps.root ?? '.', path: 'deps' } : loadConfig();
    const outside = requireProject(loaded);
    if (outside) return outside;
    const { config, root } = loaded;
    const text = deps.text ?? read(root, DISCOVERY_DOC);
    if (!text) {
      return fail('no_discovery_doc', `${DISCOVERY_DOC} is missing`, {
        retry: `write ${DISCOVERY_DOC}: crew-research blocks (id, question, area, owner, budget_hours) and an "## Exit criteria" checklist; the template is in a new project`,
        stop_when: 'nobody knows the open questions yet: analyze the brief first (skill crew-brief-analysis)',
      });
    }
    const { items, errors } = parseResearch(text);
    if (errors.length) return fail('bad_discovery_doc', `${DISCOVERY_DOC}: ${errors.join('; ')}`, { retry: `fix ${DISCOVERY_DOC} and run crew discover plan again` });
    const existing = new Set((deps.existing ?? researchIssues(root)).map(researchIdOf).filter(Boolean));
    const todo = items.filter((i) => !existing.has(i.id));
    const view = items.map((i) => ({ id: i.id, title: researchTitle(i), area: i.area, owner: i.owner, budget_hours: i.budget_hours, exists: existing.has(i.id) }));
    if (!apply) {
      return ok(`Research plan: ${todo.length} to create, ${items.length - todo.length} already exist (dry-run)`, {
        artifacts: { research: view, phase: phaseOf(config) },
        next_actions: todo.length ? ['show it to the human; then crew discover plan --apply (captain)'] : ['crew discover status'],
      });
    }
    const login = deps.login !== undefined ? deps.login : myLogin();
    const acting = deps.acting !== undefined ? deps.acting : deps.config ? null : loadActingCaptain(root, config);
    if (!hasCaptainPowers(login, config, acting)) {
      return fail('not_captain', `Only the captain ${config.captain} plans the research${login ? `, and you are ${login}` : ''}`, { retry: 'members: take research tasks from crew task next', stop_when: 'immediately' });
    }
    const call = deps.gh ?? gh;
    const created = [];
    for (const item of todo) {
      const labels = [RESEARCH_LABEL, 'status:ready', ...(config.areas?.[item.area] ? [`area:${item.area}`] : [])];
      const args = ['issue', 'create', '--title', researchTitle(item), '--label', labels.join(','), '--body-file', '-', ...(item.owner ? ['--assignee', item.owner] : [])];
      const r = call(args, { cwd: root, allowFail: true, input: researchBody(item) });
      const number = Number(/\/issues\/(\d+)/.exec(r.stdout ?? '')?.[1]);
      if (r.code !== 0 || !number) {
        return fail('gh_failed', `Created ${created.length} of ${todo.length}, failed on ${item.id}`, { cause_hint: (r.stderr || r.stdout || '').split('\n')[0], retry: 'crew labels sync (crew:research may be missing), then crew discover plan --apply (created ones are skipped)', artifacts: { created } });
      }
      created.push({ id: item.id, number });
    }
    return ok(`Research tasks created: ${created.length}`, {
      artifacts: { created },
      next_actions: ['tell the team: research tasks are in the queue (crew task next); no product code until the plan', 'crew discover status — what is left before the PRD'],
    });
  },
};

const status = {
  name: 'discover status',
  summary: 'Is discovery done? Research tasks, questions for humans, decisions, exit checklist, the reviewed PRD',
  args: [],
  run(_ = {}, deps = {}) {
    const loaded = deps.config ? { config: deps.config, root: deps.root ?? '.', path: 'deps' } : loadConfig();
    const outside = requireProject(loaded);
    if (outside) return outside;
    const { config, root } = loaded;
    const s = deps.status ?? loadDiscoveryStatus(root);
    const phase = phaseOf(config);
    const head = `Phase ${phase}: research ${s.done.research}/${s.done.of} done, ${s.done.decisions} decision(s) recorded`;
    if (s.ready) {
      return ok(`${head}. Discovery is done`, {
        artifacts: { phase, ...s },
        next_actions: phase === 'discovery' ? ['crew kickoff (show the plan), then crew kickoff --apply: it switches the phase to build'] : ['nothing to do: the project is in the build phase'],
      });
    }
    return warn(`${head}. Not done yet: ${s.missing.length} item(s)`, { artifacts: { phase, ...s }, next_actions: s.missing });
  },
};

export default [plan, status];
