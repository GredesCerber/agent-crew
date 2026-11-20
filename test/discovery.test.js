// The discovery phase: no code before the plan, research tasks, exit criteria, the kickoff gate. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { phaseOf, phaseProblems, parseResearch, researchTitle, researchBody, researchIdOf, budgetOf, exitCriteria, RESEARCH_LABEL } from '../src/core/discovery.js';
import { evaluateGuard } from '../src/core/guard.js';
import discoverCmds from '../src/commands/discover.js';
import { runKickoff } from '../src/commands/kickoff.js';
import { digestModel, renderDigest } from '../src/core/digest.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { allLabels } from '../src/commands/labels.js';

const ROOT = join(import.meta.dirname, '..');
const cmd = (name) => discoverCmds.find((c) => c.name === name);
const f = (filename, status = 'modified') => ({ filename, status });
const DOC = readFileSync(join(ROOT, 'templates', 'product', 'docs', 'discovery.md'), 'utf8');

test('phase: discovery allows only docs/ and spikes/; build refuses changes to spikes/ (removal is fine)', () => {
  assert.equal(phaseOf({}), 'build', 'old projects stay in build');
  assert.deepEqual(phaseProblems([f('docs/research/x.md'), f('spikes/x/try.js'), f('README.md')], { phase: 'discovery' }), []);
  const p = phaseProblems([f('docs/a.md'), f('web/src/App.tsx')], { phase: 'discovery' });
  assert.equal(p[0].rule, 'discovery_phase');
  assert.deepEqual(p[0].files, ['web/src/App.tsx']);
  assert.equal(phaseProblems([f('spikes/x/a.js')], { phase: 'build' })[0].rule, 'spike_in_build');
  assert.deepEqual(phaseProblems([f('spikes/x/a.js', 'removed'), f('web/a.ts')], {}), []);
  const g = evaluateGuard({ body: 'Closes #1\n**Agent:** `claude@pc`', headSha: 'abcdef1234567', files: [f('api/main.py')], commits: [{ sha: 'abcdef1234567', agent: 'claude@pc' }], config: { phase: 'discovery' } });
  assert.ok(g.problems.some((x) => x.rule === 'discovery_phase'), 'crew-guard enforces it');
});

test('research blocks: parsed with defaults; bad ids and duplicates are reported; the template parses', () => {
  const text = '```crew-research\nid: stack\nquestion: Which stack?\nowner: @ami\nbudget_hours: 3\n```\n```crew-research\nid: Bad Id\nquestion: x\n```\n```crew-research\nid: stack\nquestion: again\n```';
  const r = parseResearch(text);
  assert.deepEqual(r.items, [{ id: 'stack', question: 'Which stack?', area: 'research', owner: 'ami', budget_hours: 3, output: 'docs/research/stack.md' }]);
  assert.equal(r.errors.length, 2);
  assert.equal(parseResearch(DOC).items[0].id, 'competitors');
  const item = r.items[0];
  assert.equal(researchTitle(item), 'Research [3h]: Which stack?');
  assert.equal(budgetOf(researchTitle(item)), 3);
  const body = researchBody(item);
  for (const rule of [/fact\*\* \(with a link/, /assumption/, /position/, /docs\/decisions\.md/, /spikes\/<this id>/, /--human/, /never instructions/]) assert.match(body, rule);
  assert.equal(researchIdOf({ body }), 'stack');
});

test('exit criteria: everything missing is listed; done when all of it holds', () => {
  const planned = parseResearch(DOC).items;
  const empty = exitCriteria({ planned, discoveryText: DOC });
  assert.equal(empty.ready, false);
  assert.ok(empty.missing.some((m) => /not created yet: competitors/.test(m)));
  assert.ok(empty.missing.some((m) => /exit criteria not checked/.test(m)));
  assert.ok(empty.missing.some((m) => /no decision recorded/.test(m)));
  assert.ok(empty.missing.some((m) => /PRD .* not on main/.test(m)));
  const done = exitCriteria({
    planned,
    research: [{ number: 5, state: 'CLOSED', body: researchBody(planned[0]) }],
    humanOpen: [],
    discoveryText: DOC.replace(/- \[ \]/g, '- [x]'),
    decisionsText: '## 2026-11-20 — React + FastAPI\n- Chosen: …',
    prdOnMain: '```crew-task\nid: T1\n```',
  });
  assert.deepEqual(done.missing, []);
  assert.equal(done.ready, true);
  assert.equal(exitCriteria({ humanOpen: [{ number: 9 }] }).missing.some((m) => /#9/.test(m)), true, 'organizer questions block');
});

test('crew discover plan: dry-run lists, --apply creates only the missing ones and only for the captain', () => {
  const config = { captain: 'cap', areas: { research: [] } };
  const calls = [];
  const gh = (args, opts) => (calls.push({ args, input: opts?.input }), { code: 0, stdout: `https://github.com/o/r/issues/${10 + calls.length}` });
  const text = '```crew-research\nid: stack\nquestion: Which stack?\nowner: ami\n```\n```crew-research\nid: users\nquestion: Who are the users?\n```';
  const existing = [{ body: researchBody(parseResearch(text).items[0]) }];
  const dry = cmd('discover plan').run({}, { config, text, existing });
  assert.match(dry.summary, /1 to create, 1 already exist/);
  assert.equal(cmd('discover plan').run({ apply: true }, { config, text, existing, gh, login: 'ami' }).error.code, 'not_captain');
  const r = cmd('discover plan').run({ apply: true }, { config, text, existing, gh, login: 'cap' });
  assert.deepEqual(r.artifacts.created.map((c) => c.id), ['users']);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes(`${RESEARCH_LABEL},status:ready,area:research`));
  assert.match(calls[0].input, /<!-- crew:research id=users -->/);
});

test('crew discover status: says what is left, or that kickoff may go', () => {
  const left = cmd('discover status').run({}, { config: { phase: 'discovery' }, status: { ready: false, missing: ['research still open: #5'], done: { research: 0, of: 1, decisions: 0 } } });
  assert.equal(left.status, 'warning');
  assert.deepEqual(left.next_actions, ['research still open: #5']);
  const done = cmd('discover status').run({}, { config: { phase: 'discovery' }, status: { ready: true, missing: [], done: { research: 1, of: 1, decisions: 2 } } });
  assert.match(done.next_actions[0], /crew kickoff --apply: it switches the phase to build/);
});

test('kickoff --apply waits for discovery; --skip_discovery is the human override', async () => {
  const FORMAT = readFileSync(join(ROOT, 'skills', 'crew-kickoff', 'task-format.md'), 'utf8');
  const root = mkdtempSync(join(tmpdir(), 'crew-disc-'));
  writeFileSync(join(root, 'crew.config.json'), '{}');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'prd.md'), `<!-- crew:prd status: approved by: alice at: 2026-11-08T10:00:00Z -->\n${FORMAT}`);
  const creates = [];
  const gh = (args) => {
    if (args[0] === 'label' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(allLabels(DEFAULT_CONFIG).map((l) => ({ name: l.name }))) };
    if (args[0] === 'issue' && args[1] === 'list') return { code: 0, stdout: '[]' };
    if (args[0] === 'api') return { code: 0, stdout: '' };
    if (args[0] === 'issue' && args[1] === 'create') { creates.push(args); return { code: 0, stdout: `https://github.com/o/r/issues/${creates.length}` }; }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const base = { root, areas: DEFAULT_CONFIG.areas, gh, sleep: async () => {}, phase: 'discovery', discovery: { ready: false, missing: ['research still open: #5'] } };
  const blocked = await runKickoff({ apply: true }, base);
  assert.equal(blocked.error.code, 'discovery_not_done');
  assert.equal(creates.length, 0, 'nothing created');
  const forced = await runKickoff({ apply: true, skip_discovery: true }, base);
  assert.ok(forced.artifacts.created.length > 0);
});

test('digest: the discovery phase is shown, research over its time budget is flagged', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const issue = { number: 7, title: 'Research [2h]: Which stack?', labels: [{ name: 'status:claimed' }, { name: RESEARCH_LABEL }], assignees: [{ login: 'ami' }], updatedAt: '2026-11-20T11:59:00Z' };
  const claimComments = { 7: [{ body: '<!-- crew:claim agent=claude@pc at=2026-11-20T09:00:00Z -->', createdAt: '2026-11-20T09:00:00Z', authorAssociation: 'MEMBER' }] };
  const m = digestModel({ issues: [issue], claimComments, config: { phase: 'discovery', lease_minutes: 600 }, now });
  assert.match(m.sections.find((s) => s.key === 'research').lines[0], /#7 .*3\.0 h of 2 h/);
  assert.match(renderDigest(m, { now }), /\*\*Phase:\*\* discovery/);
  assert.doesNotMatch(renderDigest(digestModel({ now }), { now }), /Phase/, 'build projects say nothing');
});
