// Parser and linter of docs/prd.md, ordering, the kickoff plan, issue bodies - pure functions, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parsePrd, lintPrd, topoOrder, planKickoff, renderTaskBody, renderEpicBody, taskHash, prdApproval, isAcceptance, pathInArea,
} from '../src/core/prd.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

const ROOT = join(import.meta.dirname, '..');
const FORMAT = readFileSync(join(ROOT, 'skills', 'crew-kickoff', 'task-format.md'), 'utf8');
const areas = DEFAULT_CONFIG.areas;
const lint = (text) => lintPrd(parsePrd(text), { areas });
const rules = (r) => r.errors.map((e) => e.rule);

const SKELETON = [
  '```crew-task',
  'id: T1',
  'title: Skeleton',
  'area: infra',
  'tier: high',
  'risk: high',
  'skeleton: true',
  'paths: [web/**, api/**]',
  'goal: Everything builds',
  'acceptance:',
  '  - Given a repo When crew check Then green',
  'tests: [e2e]',
  '```',
].join('\n');
const task = (lines) => ['```crew-task', ...lines, '```'].join('\n');
const base = (id, extra = []) => [`id: ${id}`, `title: Task ${id}`, 'area: web', 'tier: mid', 'goal: goal', 'acceptance:', '  - Given a When b Then c', ...extra];
const prd = (...blocks) => ['# PRD', '', SKELETON, '', ...blocks].join('\n');

test('the task-format.md fixture passes lint with no errors and no warnings', () => {
  const r = lint(FORMAT);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.order, ['T1', 'T2', 'T3', 'T6', 'T4', 'T5']);
  const p = parsePrd(FORMAT);
  assert.equal(p.tasks.length, 6);
  assert.equal(p.epics.length, 1);
  const t4 = p.tasks.find((t) => t.id === 'T4');
  assert.deepEqual(t4.fields.after, ['T2', 'T3']);
  assert.equal(t4.fields.acceptance.length, 2);
  assert.deepEqual(t4.fields.req, ['R2', 'R3']);
  assert.equal(p.tasks[0].fields.skeleton, true);
  assert.equal(p.tasks.find((t) => t.id === 'T5').fields.ready, false);
});

test('parser: ignores foreign blocks, CRLF, line numbers, two kinds of lists, quotes', () => {
  const text = ['Text', '```js', 'id: T9', '```', '```crew-task', 'id: T1', 'title: "With quotes: yes"', 'paths: [a/**, "b/**"]', 'acceptance:', '  - [ ] Given x When y Then z', '```'].join('\r\n');
  const p = parsePrd(text);
  assert.equal(p.tasks.length, 1);
  const t = p.tasks[0];
  assert.equal(t.line, 5);
  assert.equal(t.lines.title, 7);
  assert.equal(t.fields.title, 'With quotes: yes');
  assert.deepEqual(t.fields.paths, ['a/**', 'b/**']);
  assert.deepEqual(t.fields.acceptance, ['Given x When y Then z'], 'the checkbox is stripped');
});

test('parser: an unknown/repeated key, a garbage line, an unclosed block - errors with a line', () => {
  const p = parsePrd(['```crew-task', 'id: T1', 'id: T2', 'foo: bar', 'just text', '- a dangling item', 'skeleton: maybe', '```', '```crew-epic', 'id: E1'].join('\n'));
  const got = p.errors.map((e) => `${e.line}:${e.rule}`);
  assert.deepEqual(got, ['3:duplicate_key', '4:unknown_key', '5:syntax', '6:syntax', '7:type', '9:syntax']);
});

test('lint collects all errors at once (prd_invalid with several rules)', () => {
  const r = lint(prd(task(['id: T2', 'title: x', 'area: mobile', 'tier: huge', 'risk: maybe', 'tests: [smoke]', 'acceptance: [check by hand]', 'after: [T7]', 'epic: E5', 'req: [REQ-1]'])));
  for (const rule of ['required', 'unknown_area', 'enum', 'acceptance_format', 'unknown_ref', 'req_format']) {
    assert.ok(rules(r).includes(rule), `missing ${rule}: ${JSON.stringify(r.errors)}`);
  }
  assert.ok(r.errors.every((e) => e.line > 0 && e.message), 'every error has a line and a message');
});

test('lint: no blocks, a wrong and a repeated id', () => {
  assert.deepEqual(rules(lint('# empty')), ['no_blocks']);
  const r = lint(prd(task(base('X2')), task(base('T1'))));
  assert.ok(rules(r).includes('bad_id'));
  assert.ok(rules(r).includes('duplicate_id'));
});

test('lint: the skeleton - first, only one, tier/risk high, no after', () => {
  assert.ok(rules(lint(task(base('T1')))).includes('skeleton_first'));
  const two = lint(prd(task([...base('T2'), 'skeleton: true'])));
  assert.ok(rules(two).includes('skeleton_many'));
  const weak = lint(SKELETON.replace('tier: high', 'tier: mid').replace('risk: high', 'risk: low').replace('tests: [e2e]', 'tests: [e2e]\nafter: [T1]'));
  for (const rule of ['skeleton_tier', 'skeleton_risk', 'skeleton_after']) assert.ok(rules(weak).includes(rule), rule);
});

test('lint: one area - area as a list and paths outside the area (except the skeleton) - an error', () => {
  const list = lint(prd(task(base('T2').map((l) => (l === 'area: web' ? 'area: [web, api]' : l)))));
  assert.ok(rules(list).includes('one_area'));
  const outside = lint(prd(task([...base('T2'), 'paths: [web/src/**, api/src/**]'])));
  const e = outside.errors.find((x) => x.rule === 'paths_outside_area');
  assert.ok(e, JSON.stringify(outside.errors));
  assert.match(e.message, /api\/src\/\*\*/);
  assert.doesNotMatch(e.message, /web\/src/);
  assert.deepEqual(lint(prd(task([...base('T2'), 'paths: [web/src/**]']))).errors, []);
});

test('lint: risk low is forbidden for contracts and infra; high without e2e - a warning', () => {
  const c = lint(prd(task([...base('T2').map((l) => (l === 'area: web' ? 'area: contracts' : l)), 'risk: low'])));
  assert.ok(rules(c).includes('risk_too_low'));
  const i = lint(prd(task([...base('T2').map((l) => (l === 'area: web' ? 'area: infra' : l)), 'risk: low'])));
  assert.ok(rules(i).includes('risk_too_low'));
  assert.deepEqual(lint(prd(task([...base('T2'), 'risk: low']))).errors, []);
  const alone = lint(prd(task([...base('T2'), 'risk: high', 'tests: [e2e]'])));
  assert.deepEqual(rules(alone), ['high_without_tests_task'], 'risk: high without a tests task');
  const testsTask = task(['id: T3', 'title: Tests T2', 'area: e2e', 'tier: mid', 'tests_for: T2']);
  const h = lint(prd(task([...base('T2'), 'risk: high', 'tests: [unit]']), testsTask));
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.warnings.map((w) => w.rule).filter((r) => r !== 'no_team'), ['high_without_e2e']);
});

test('lint: a dependency cycle with a path, a self-reference, duplicate titles', () => {
  const r = lint(prd(task(base('T2', ['after: [T4]'])), task(base('T4', ['after: [T2]'])), task(base('T5', ['after: [T5]']))));
  const cycle = r.errors.find((e) => e.rule === 'cycle');
  assert.ok(cycle);
  assert.match(cycle.message, /T2 -> T4 -> T2/);
  assert.ok(rules(r).includes('self_ref'));
  const dup = lint(prd(task(base('T2')), task([...base('T3').map((l) => (l.startsWith('title') ? 'title: Task T2' : l))])));
  assert.ok(dup.warnings.some((w) => w.rule === 'duplicate_title'));
});

test('acceptance: Given/When/Then and Дано/Когда/Тогда (Russian), case does not matter, order does', () => {
  assert.ok(isAcceptance('Given /register is open When I enter an email Then I see /dashboard'));
  assert.ok(isAcceptance('given a, when b, then c'));
  assert.ok(isAcceptance('Дано форма Когда отправляю Тогда вижу ошибку'));
  assert.ok(isAcceptance('ДАНО: форма; КОГДА: отправляю; ТОГДА: вижу'));
  assert.ok(!isAcceptance('When b Given a Then c'), 'order');
  assert.ok(!isAcceptance('Тогда c Когда b Дано a'));
  assert.ok(!isAcceptance('Given a Then c'), 'no When');
  assert.ok(!isAcceptance('Given When x Then y'), 'an empty Given');
  assert.ok(!isAcceptance('Forgiven a Whenever b Thence c'), 'parts of words do not count');
  assert.ok(!isAcceptance('Check by hand'));
});

test('pathInArea: glob prefixes of an area', () => {
  assert.ok(pathInArea('web/src/**', ['web/**']));
  assert.ok(pathInArea('./web', ['web/**']));
  assert.ok(pathInArea('docker-compose.yml', ['infra/**', 'docker-compose.yml']));
  assert.ok(!pathInArea('webby/**', ['web/**']));
  assert.ok(!pathInArea('api/x', ['web/**']));
});

test('req: the R<number> format, goes into the issue body under "Brief requirements"', () => {
  const p = parsePrd(prd(task(base('T2', ['req: [R1, R12]']))));
  assert.deepEqual(lintPrd(p, { areas }).errors, []);
  const body = renderTaskBody(p.tasks[1], { issueOf: { T1: 10 }, skeletonId: 'T1' });
  assert.match(body, /### Brief requirements\n\n- R1\n- R12/);
});

test('topoOrder: dependencies first, otherwise the PRD order; the skeleton is an implicit dependency', () => {
  const p = parsePrd(prd(task(base('T2', ['after: [T3]'])), task(base('T3')), task(base('T4'))));
  assert.deepEqual(topoOrder(p.tasks).order.map((t) => t.id), ['T1', 'T3', 'T2', 'T4']);
  // the skeleton is not first in the file - it is still created first
  const q = parsePrd([task(base('T2')), SKELETON].join('\n'));
  assert.deepEqual(topoOrder(q.tasks).order.map((t) => t.id), ['T1', 'T2']);
});

test('planKickoff: ready/waiting/needs-spec statuses, labels, an implicit dependency on the skeleton, epics last', () => {
  const p = parsePrd(FORMAT);
  const plan = planKickoff(p, []);
  assert.deepEqual(plan.ops.map((o) => `${o.op}:${o.id}`), ['create:T1', 'create:T2', 'create:T3', 'create:T6', 'create:T4', 'create:T5', 'create:E1']);
  const by = Object.fromEntries(plan.ops.map((o) => [o.id, o]));
  assert.deepEqual(by.T1.labels, ['status:ready', 'area:infra', 'tier:high', 'risk:high']);
  assert.deepEqual(by.T2.after, ['T1'], 'the skeleton is an implicit dependency');
  assert.deepEqual(by.T4.after, ['T1', 'T2', 'T3', 'T6'], 'explicit after + skeleton + its own tests task');
  assert.deepEqual(by.T6.after, ['T1'], 'the tests task waits only for the skeleton');
  assert.equal(by.T3.labels[0], 'status:waiting');
  assert.equal(by.T3.labels[3], 'risk:med', 'risk is med by default');
  assert.equal(by.T5.labels[0], 'status:needs-spec', 'ready: false');
  assert.deepEqual(by.E1.labels, ['epic']);
  assert.deepEqual(by.E1.tasks, ['T2', 'T3', 'T4']);
  assert.deepEqual(plan.warnings, []);
});

test('planKickoff: skip by marker, changed and orphan - warnings only; a closed dependency -> ready', () => {
  const p = parsePrd(FORMAT);
  const t1 = p.tasks[0];
  const t2 = p.tasks[1];
  const existing = [
    { number: 1, title: 'T1', state: 'CLOSED', body: `<!-- crew:task id=T1 hash=${taskHash(t1)} prd=docs/prd.md -->`, labels: [] },
    { number: 2, title: 'T2', state: 'OPEN', body: '<!-- crew:task id=T2 hash=deadbeef0000 prd=docs/prd.md -->', labels: [] },
    { number: 9, title: 'old', state: 'OPEN', body: '<!-- crew:task id=T9 hash=x prd=docs/prd.md -->', labels: [] },
    { number: 11, title: 'another PRD', state: 'OPEN', body: '<!-- crew:task id=T7 hash=x prd=docs/other.md -->', labels: [] },
  ];
  const plan = planKickoff(p, existing);
  const by = Object.fromEntries(plan.ops.map((o) => [o.id, o]));
  assert.equal(by.T1.op, 'skip');
  assert.equal(by.T2.op, 'changed');
  assert.equal(by.T9.op, 'orphan');
  assert.ok(!by.T7, 'issues of another PRD are not orphans');
  assert.equal(plan.map.T1, 1);
  assert.equal(plan.map.T3, null);
  assert.equal(plan.warnings.length, 2);
  // T5 depends only on the closed skeleton - ready: false is still needs-spec
  assert.equal(by.T5.labels[0], 'status:needs-spec');
  const solo = parsePrd(prd(task(base('T2'))));
  const again = planKickoff(solo, [{ number: 1, state: 'CLOSED', body: `<!-- crew:task id=T1 hash=${taskHash(solo.tasks[0])} prd=docs/prd.md -->` }]);
  assert.equal(again.ops.find((o) => o.id === 'T2').labels[0], 'status:ready', 'all dependencies are already closed');
});

test('renderTaskBody/renderEpicBody: task.yml sections, "After #N", markers', () => {
  const p = parsePrd(FORMAT);
  const t4 = p.tasks.find((t) => t.id === 'T4');
  const body = renderTaskBody(t4, { issueOf: { T1: 1, T2: 2, T3: 3 }, skeletonId: 'T1', epics: p.epics });
  for (const s of ['### Goal', '### Acceptance criteria', '### Contract', '### Allowed paths', '### Out of scope', '### Risk', '### Required tests', '### Epic', '### Dependencies']) {
    assert.ok(body.includes(s), `missing ${s}`);
  }
  assert.match(body, /After #1, #2, #3/);
  assert.match(body, /<!-- crew:task id=T4 hash=[0-9a-f]{12} prd=docs\/prd\.md -->/);
  assert.match(body, /<!-- crew:after issues=1,2,3 -->/);
  assert.match(body, /- \[ \] Given the email is taken/);
  const skel = renderTaskBody(p.tasks[0], { skeletonId: 'T1' });
  assert.doesNotMatch(skel, /crew:after|Dependencies/);
  const epic = renderEpicBody(p.epics[0], p.tasks, { issueOf: { T2: 2, T3: 3, T4: 4 } });
  assert.match(epic, /- \[ \] #2 Sign-up contract in contracts\/api\.yaml/);
  assert.match(epic, /- \[ \] #4 Email sign-up form/);
  assert.match(epic, /<!-- crew:epic id=E1 hash=[0-9a-f]{12} prd=docs\/prd\.md -->/);
});

test('taskHash: independent of whitespace and key order, changes with the content', () => {
  const a = parsePrd(task(['id: T1', 'title: x', 'goal: y'])).tasks[0];
  const b = parsePrd(task(['goal:   y', '', 'title: x', 'id: T1'])).tasks[0];
  const c = parsePrd(task(['id: T1', 'title: x2', 'goal: y'])).tasks[0];
  assert.equal(taskHash(a), taskHash(b));
  assert.notEqual(taskHash(a), taskHash(c));
});

test('prdApproval: the crew:prd header, approved only with status: approved', () => {
  assert.deepEqual(prdApproval('# PRD'), { status: null, by: null, at: null, approved: false });
  assert.equal(prdApproval('<!-- crew:prd status: draft by: - at: - -->\n# PRD').approved, false);
  const ok = prdApproval('<!-- crew:prd status: approved by: alice at: 2026-11-08T10:00:00Z -->\n# PRD');
  assert.deepEqual(ok, { status: 'approved', by: 'alice', at: '2026-11-08T10:00:00Z', approved: true });
  assert.equal(prdApproval('<!-- crew:prd status: approved by: auto-timeout at: 2026-11-08T10:20:00Z -->').by, 'auto-timeout');
  assert.equal(prdApproval('text `<!-- crew:prd status: approved -->` in a line').approved, false, 'only as a separate line');
});

test('template templates/product/docs/prd.md: a draft header and a valid skeleton', () => {
  const text = readFileSync(join(ROOT, 'templates', 'product', 'docs', 'prd.md'), 'utf8');
  assert.equal(prdApproval(text).status, 'draft');
  assert.match(text, /## Demo path/);
  const r = lint(text);
  assert.deepEqual(r.errors, []);
  assert.equal(parsePrd(text).tasks[0].fields.skeleton, true);
});
