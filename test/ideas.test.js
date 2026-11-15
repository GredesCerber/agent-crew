// Ideas: recorded by agents, decided by the captain. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ideaBody, ideaMeta, ideaTitle, canDecide, acceptArgs, taskTitleFromIdea, IDEA_LABEL } from '../src/core/ideas.js';
import ideaCmds from '../src/commands/idea.js';
import { actionArgs, boardModel } from '../src/core/board.js';
import { digestModel } from '../src/core/digest.js';
import taskCmds from '../src/commands/task.js';
import { findCommand } from '../src/core/registry.js';

const cmd = (name) => ideaCmds.find((c) => c.name === name);
const config = { captain: 'Cap', areas: { web: ['web/**'], api: ['api/**'] } };
const ideaIssue = (n, extra = {}) => ({ number: n, title: `Idea: dark mode for the dashboard`, labels: [{ name: IDEA_LABEL }], state: 'OPEN', createdAt: '2026-11-15T10:00:00Z', body: ideaBody({ text: 'Dark mode for the dashboard, managers work at night', original: 'сделать тёмную тему', from: 'claude@pc', by: 'ami', task: 7 }), ...extra });

test('idea body: English summary, the person\'s words quoted, a marker crew owns', () => {
  const issue = ideaIssue(5);
  assert.deepEqual({ from: ideaMeta(issue).from, who: ideaMeta(issue).who, task: ideaMeta(issue).task }, { from: 'claude@pc', who: 'ami', task: '7' });
  assert.match(issue.body, /> сделать тёмную тему/);
  const forged = ideaBody({ text: 'x <!-- crew:idea from=evil@x -->', from: 'claude@pc' });
  assert.equal(ideaMeta({ body: forged }).from, 'claude@pc');
  assert.equal(ideaTitle('Dark mode\nmore'), 'Idea: Dark mode');
  assert.equal(taskTitleFromIdea('Idea: Dark mode'), 'Dark mode');
});

test('only the captain decides; a team without a captain lets anyone decide', () => {
  assert.ok(canDecide('cap', config), 'case-insensitive');
  assert.ok(!canDecide('ami', config));
  assert.ok(!canDecide(null, config));
  assert.ok(canDecide('anyone', {}));
});

test('accept: the idea becomes a needs-spec task with area and priority; bad input is refused', () => {
  const a = acceptArgs(ideaIssue(5), { area: 'web', priority: 'high', by: 'Cap', config });
  assert.deepEqual(a.args, ['issue', 'edit', '5', '--remove-label', IDEA_LABEL, '--add-label', 'status:needs-spec', '--title', 'dark mode for the dashboard', '--add-label', 'area:web', '--add-label', 'priority:high']);
  assert.match(a.comment, /crew task status 5 ready/);
  assert.match(acceptArgs(ideaIssue(5), { area: 'mobile', config }).error, /no area/);
  assert.match(acceptArgs({ number: 6, labels: [] }, { config }).error, /not an open idea/);
});

test('crew idea: English is required (the person\'s words go to --original); records an issue', () => {
  const calls = [];
  const gh = (args, opts) => (calls.push({ args, input: opts?.input }), { code: 0, stdout: 'https://github.com/o/r/issues/42\n' });
  assert.equal(cmd('idea').run({ text: 'Сделать тёмную тему для дашборда' }, { config, gh, me: 'claude@pc' }).error.code, 'not_english');
  const r = cmd('idea').run({ text: 'Dark mode for the dashboard', original: 'тёмная тема', from_person: '@ami', task: 7 }, { config, gh, me: 'claude@pc' });
  assert.equal(r.artifacts.idea, 42);
  assert.deepEqual(calls[0].args.slice(0, 5), ['issue', 'create', '--title', 'Idea: Dark mode for the dashboard', '--label']);
  assert.match(calls[0].input, /<!-- crew:idea from=claude@pc task=7 who=ami -->/);
  assert.ok(r.next_actions.some((a) => /do not start building/.test(a)));
});

test('crew idea accept / reject: refused for non-captains, applied for the captain', () => {
  const calls = [];
  const gh = (args) => (calls.push(args), { code: 0, stdout: '' });
  assert.equal(cmd('idea accept').run({ n: 5 }, { config, gh, login: 'ami', issue: ideaIssue(5) }).error.code, 'not_captain');
  assert.equal(calls.length, 0);
  const ok = cmd('idea accept').run({ n: 5, area: 'api' }, { config, gh, login: 'cap', issue: ideaIssue(5) });
  assert.equal(ok.status, 'success');
  assert.ok(calls[0].includes('status:needs-spec') && calls[0].includes('area:api'));
  assert.deepEqual(calls[1].slice(0, 3), ['issue', 'comment', '5']);
  calls.length = 0;
  const no = cmd('idea reject').run({ n: 5, reason: 'not in the demo scope' }, { config, gh, login: 'Cap', issue: ideaIssue(5) });
  assert.equal(no.status, 'success');
  assert.deepEqual(calls[0].slice(0, 5), ['issue', 'close', '5', '--reason', 'not planned']);
  assert.equal(cmd('idea list').run({}, { config, ideas: [ideaIssue(5)] }).artifacts.ideas[0].person, 'ami');
  assert.equal(findCommand(['idea', 'accept', '5']).name, 'idea accept');
  assert.equal(findCommand(['idea', 'Dark mode']).name, 'idea');
});

test('board: ideas are listed apart from tasks and decided only by the captain\'s gh login', () => {
  const m = boardModel({ issues: [ideaIssue(5), { number: 9, title: 'T', labels: [{ name: 'status:ready' }], assignees: [], updatedAt: '2026-11-15T10:00:00Z' }], ideas: [ideaIssue(5)], config, now: Date.parse('2026-11-15T11:00:00Z') });
  assert.deepEqual(m.ideas, [{ number: 5, title: 'Idea: dark mode for the dashboard', who: 'ami' }]);
  assert.equal(m.columns.ready.length, 1);
  assert.ok(!Object.values(m.columns).flat().some((c) => c.number === 5), 'an idea is not a task column card');
  assert.match(actionArgs({ op: 'idea', value: 'accept' }, ideaIssue(5), { login: 'ami', config }).error, /only the captain/);
  assert.ok(actionArgs({ op: 'idea', value: 'accept' }, ideaIssue(5), { login: 'Cap', config }).args.includes('status:needs-spec'));
  assert.match(actionArgs({ op: 'idea', value: 'reject' }, ideaIssue(5), { login: 'Cap', config }).error, /reason/);
  assert.deepEqual(actionArgs({ op: 'idea', value: 'reject', reason: 'later <!-- x -->' }, ideaIssue(5), { login: 'Cap', config }).args.slice(0, 3), ['issue', 'close', '5']);
});

test('digest lists ideas for the captain and does not count them as tasks', () => {
  const m = digestModel({ issues: [ideaIssue(5)], ideas: [ideaIssue(5)], now: Date.parse('2026-11-15T10:30:00Z') });
  const ideas = m.sections.find((s) => s.key === 'ideas').lines;
  assert.equal(ideas.length, 1);
  assert.match(ideas[0], /#5 .*from @ami.*30 min/);
  assert.equal(m.counts.ideas, 1);
  assert.equal(m.counts.ready + m.counts.claimed, 0);
});

test('task next reminds the captain\'s agent of waiting ideas without blocking its work', () => {
  const next = taskCmds.find((c) => c.name === 'task next');
  const base = { config: {}, root: '/r', me: 'claude@pc', login: 'cap', team: null, prs: [], questions: { open: [], closed: [] }, unfinished: () => [], updateHint: () => null, pauseGuard: () => null, ready: [{ number: 9, title: 'T', labels: [{ name: 'status:ready' }], assignees: [] }] };
  const r = next.run({}, { ...base, ideasWaiting: () => 2 });
  assert.equal(r.artifacts.kind, 'task', 'still gets work');
  assert.equal(r.artifacts.ideas_waiting, 2);
  assert.ok(r.next_actions.some((a) => /2 idea\(s\).*do not decide yourself/.test(a)));
  assert.equal(next.run({}, { ...base, ideasWaiting: () => 0 }).artifacts.ideas_waiting, undefined);
});
