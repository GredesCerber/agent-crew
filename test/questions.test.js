// crew ask / inbox / answer: English check, inbox routing, task next surfaces questions. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mostlyNonEnglish, questionBody, inboxFor, questionMeta } from '../src/core/questions.js';
import task from '../src/commands/task.js';
import { findCommand, agentCommands } from '../src/core/registry.js';

const next = task.find((c) => c.name === 'task next');
const L = (...n) => n.map((name) => ({ name }));
const q = (number, { from, area, task: t, assignees = [], labels = [], comments = [] }) => ({
  number, title: `Q: ${number}`, labels: L('crew:question', ...labels), assignees: assignees.map((login) => ({ login })),
  body: questionBody({ text: 'Which field?', from, task: t, area }), comments,
});

test('English check: Cyrillic text is refused, short or mixed technical text is fine', () => {
  assert.equal(mostlyNonEnglish('Какое поле добавить в ответ API для статуса?'), true);
  assert.equal(mostlyNonEnglish('Which field should GET /api/items return for status?'), false);
  assert.equal(mostlyNonEnglish('ok'), false);
  assert.equal(mostlyNonEnglish('Use statusHistory (как в контракте) for the timeline view'), false);
});

test('question body carries a marker the inbox reads back', () => {
  const meta = questionMeta({ body: questionBody({ text: 'x', from: 'codex@bob', task: 12, area: 'api' }) });
  assert.deepEqual([meta.kind, meta.from, meta.task, meta.area], ['question', 'codex@bob', '12', 'api']);
});

test('inbox: questions to my login or my area, not mine, not needs-human; answers to my questions until acked', () => {
  const open = [
    q(1, { from: 'codex@bob', area: 'api', assignees: ['cap'] }),
    q(2, { from: 'codex@bob', area: 'design' }),
    q(3, { from: 'claude@cap', area: 'web', assignees: ['bob'] }),
    q(4, { from: 'codex@bob', area: 'api', assignees: ['cap'], labels: ['needs-human'] }),
  ];
  const closed = [
    q(5, { from: 'claude@cap', task: 9 }),
    q(6, { from: 'claude@cap', comments: [{ body: '<!-- crew:ack agent=claude@cap -->', authorAssociation: 'MEMBER' }] }),
  ];
  const box = inboxFor({ open, closed, me: 'claude@cap', login: 'cap', myAreas: ['api'] });
  assert.deepEqual(box.toAnswer.map((x) => x.number), [1]);
  assert.deepEqual(box.answered.map((x) => [x.number, x.task]), [[5, 9]]);
});

test('task next: a question waiting for me comes before reviews and tasks; then answers to my questions', () => {
  const base = { pauseGuard: () => null, config: {}, root: '.', me: 'claude@cap', login: 'cap', team: null, prs: [],
    ready: [{ number: 20, title: 'T', labels: L('area:api', 'tier:mid'), assignees: [{ login: 'cap' }] }] };
  const r = next.run({}, { ...base, questions: { open: [q(1, { from: 'codex@bob', assignees: ['cap'] })], closed: [] } });
  assert.equal(r.artifacts.kind, 'question');
  assert.match(r.next_actions.join(' '), /crew answer 1 --text/);
  const a = next.run({}, { ...base, questions: { open: [], closed: [q(5, { from: 'claude@cap', task: 20 })] } });
  assert.equal(a.artifacts.kind, 'answered');
  assert.match(a.next_actions.join(' '), /crew inbox --ack 5/);
  assert.equal(next.run({}, { ...base, questions: { open: [], closed: [] } }).artifacts.kind, 'task');
});

test('ask / inbox / answer are agent commands (available over MCP)', () => {
  for (const n of ['ask', 'inbox', 'answer']) {
    assert.equal(findCommand([n]).name, n);
    assert.ok(agentCommands.some((c) => c.name === n), n);
  }
});
