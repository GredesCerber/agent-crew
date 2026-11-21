// crew board screens: task drawer, team, inbox, discovery, PRs, activity; the new actions and routes. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { taskText, taskView, teamView, inboxView, discoveryView, prsView, activityView, pauseView } from '../src/core/board-views.js';
import { actionArgs, boardModel, renderPage } from '../src/core/board.js';
import { boardHandler } from '../src/commands/board.js';

const L = (...names) => names.map((name) => ({ name }));
const NOW = Date.parse('2026-11-21T12:00:00Z');
const ago = (m) => new Date(NOW - m * 60000).toISOString();
const comment = (body, m, login = 'alex') => ({ body, createdAt: ago(m), author: { login }, authorAssociation: 'MEMBER' });
const BODY = '## Goal\nRecalculate totals.\n\n## Acceptance criteria\n- [x] After quantity edits\n- [ ] Mixed carts\n<!-- crew:after issues=206,207 -->';

test('task text: goal and acceptance checklist from the issue body', () => {
  const t = taskText(BODY);
  assert.equal(t.goal, 'Recalculate totals.');
  assert.deepEqual(t.criteria, [{ text: 'After quantity edits', done: true }, { text: 'Mixed carts', done: false }]);
  assert.ok(!t.text.includes('crew:after'), 'markers are not shown as text');
  assert.equal(taskText('Just fix the login page.\n- [ ] works').goal, 'Just fix the login page.', 'hand-written issues work too');
});

test('task drawer: owner, lease left, timeline, dependencies, linked PR', () => {
  const issue = {
    number: 214, title: 'Fix cart totals', body: BODY, state: 'OPEN', labels: L('status:claimed', 'area:web', 'risk:high'), assignees: [{ login: 'alex' }],
    comments: [comment('<!-- crew:claim agent=claude@pc at=x -->', 50), comment('<!-- crew:heartbeat agent=claude@pc -->', 10)],
  };
  const pr = { number: 87, title: 'Fix', body: 'Closes #214\n\n**Agent:** `claude@pc`', headRefOid: 'abc', createdAt: ago(20), labels: L('risk:high'), comments: [], statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }, { name: 'crew-guard', state: 'PENDING' }] };
  const v = taskView(issue, { prs: [pr], config: { lease_minutes: 45 }, now: NOW });
  assert.equal(v.owner.agent, 'claude@pc');
  assert.equal(v.owner.lease_left_min, 35, '45 min lease, last heartbeat 10 min ago');
  assert.equal(v.owner.stale, false);
  assert.deepEqual(v.after, [206, 207]);
  assert.equal(v.pr.number, 87);
  assert.equal(v.pr.author, 'claude@pc');
  assert.equal(v.pr.check, 'success');
  assert.deepEqual(v.timeline.map((x) => x.kind), ['claim', 'pr', 'heartbeat'], 'the PR being opened is in the timeline, in time order');
  assert.equal(v.claim_command, 'crew task claim 214');
  assert.equal(taskView(null), null);
});

test('team: areas from crew-team, what each person works on, newcomers, captain rule', () => {
  const columns = boardModel({ issues: [
    { number: 1, title: 'A', labels: L('status:claimed'), assignees: [{ login: 'maya' }], updatedAt: ago(5) },
    { number: 2, title: 'B', labels: L('status:ready'), assignees: [{ login: 'quinn' }], updatedAt: ago(5) },
  ], now: NOW }).columns;
  const v = teamView({
    members: ['alex', 'maya', 'quinn', 'lee', 'dependabot[bot]'],
    team: { members: [{ login: 'alex', areas: ['web', 'review'], review: true }, { login: 'maya', areas: ['api'] }, { login: 'quinn', areas: ['web'] }] },
    columns, claimComments: { 1: [comment('<!-- crew:claim agent=codex@maya-pc at=z -->', 30, 'maya')] },
    closed: [{ number: 9, closedAt: ago(60), assignees: [{ login: 'maya' }] }, { number: 8, closedAt: ago(60 * 24 * 9), assignees: [{ login: 'maya' }] }],
    config: { captain: 'alex', captain_handover: { mode: 'deputies', deputies: ['maya'] } }, now: NOW,
  });
  const by = Object.fromEntries(v.people.map((p) => [p.login, p]));
  assert.equal(v.people[0].login, 'alex', 'the captain first');
  assert.deepEqual(by.alex.areas, ['web'], 'review is a role, not an area');
  assert.equal(by.alex.reviewer, true);
  assert.deepEqual(by.maya.agents, ['codex@maya-pc']);
  assert.equal(by.maya.done_week, 1, 'only the last 7 days');
  assert.equal(by.quinn.queued, 1);
  assert.deepEqual(v.newcomers, ['lee']);
  assert.ok(!by['dependabot[bot]'], 'bots are not people');
  assert.equal(v.policy.mode, 'deputies');
  assert.deepEqual(v.policy.deputies, ['maya']);
});

test('inbox: ideas, questions for a human, questions between agents', () => {
  const v = inboxView({
    ideas: [{ number: 5, title: 'Idea: smoke test', labels: L('crew:idea'), createdAt: ago(25), body: 'Buy one item.\n<!-- crew:idea from=claude@pc task=214 who=maya -->' }],
    questions: [
      { number: 6, title: 'Question: tax first?', labels: L('crew:question', 'needs-human'), createdAt: ago(18), body: 'Spec is open.\n<!-- crew:question from=claude@pc area=web task=214 -->' },
      { number: 7, title: 'Question for api: shape?', labels: L('crew:question'), createdAt: ago(32), body: '<!-- crew:question from=codex@m area=api -->' },
    ],
    now: NOW,
  });
  assert.deepEqual(v.ideas.map((i) => [i.title, i.who, i.task]), [['smoke test', 'maya', 214]]);
  assert.deepEqual(v.human.map((q) => [q.number, q.from, q.age_min]), [[6, 'claude@pc', 18]]);
  assert.deepEqual(v.agents.map((q) => [q.number, q.area, q.title]), [[7, 'api', 'shape?']]);
});

test('discovery: budget used, over budget, exit criteria and decisions', () => {
  const v = discoveryView({
    config: { phase: 'discovery' },
    research: [
      { number: 50, title: 'Research [1h]: Tax audit', state: 'OPEN', labels: L('crew:research', 'status:claimed'), assignees: [{ login: 'maya' }], body: '<!-- crew:research id=R2 -->', comments: [comment('<!-- crew:claim agent=codex@m at=b -->', 90, 'maya')] },
      { number: 51, title: 'Research [2h]: Filters', state: 'CLOSED', labels: L('crew:research'), assignees: [], body: '', comments: [] },
    ],
    status: { ready: false, missing: ['research still open: #50'] },
    discoveryText: '## Exit criteria\n- [x] Mapped\n- [ ] Signed off\n',
    decisionsText: '## 2026-11-20 — Discounts before tax\n\n## 2026-11-21 — Filters server-side\n',
    now: NOW,
  });
  assert.equal(v.phase, 'discovery');
  assert.deepEqual(v.tasks.map((t) => [t.number, t.used_hours, t.over, t.state]), [[50, 1.5, true, 'claimed'], [51, null, false, 'done']]);
  assert.deepEqual(v.exit, [{ text: 'Mapped', done: true }, { text: 'Signed off', done: false }]);
  assert.deepEqual(v.decisions.map((d) => d.title), ['Filters server-side', 'Discounts before tax'], 'newest first');
  assert.deepEqual(v.missing, ['research still open: #50']);
});

test('pull requests: author, reviews on the current commit, guard text, next step', () => {
  const pr = (n, extra) => ({ number: n, title: `PR ${n}`, body: `Closes #${n + 100}\n\n**Agent:** \`claude@pc\``, headRefOid: 'abc1234def', createdAt: ago(60), isDraft: false, labels: L('risk:med'), comments: [], statusCheckRollup: [], ...extra });
  const v = prsView([
    pr(1, { statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }, { name: 'crew-guard', state: 'PENDING' }] }),
    pr(2, { mergeable: 'CONFLICTING', statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }, { name: 'crew-guard', conclusion: 'FAILURE', description: 'protected files: crew.config.json' }] }),
    pr(3, { comments: [comment('<!-- crew:review verdict=approve agent=codex@m sha=abc1234 -->', 5, 'maya')], labels: L('risk:high'), statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }, { name: 'crew-guard', conclusion: 'SUCCESS' }] }),
  ], { now: NOW });
  const by = Object.fromEntries(v.map((p) => [p.number, p]));
  assert.equal(by[1].kind, 'review');
  assert.equal(by[1].issue, 101);
  assert.equal(by[2].kind, 'fix');
  assert.equal(by[2].conflict, true);
  assert.equal(by[2].guard_text, 'protected files: crew.config.json');
  assert.equal(by[3].kind, 'merge');
  assert.deepEqual(by[3].reviews, [{ agent: 'codex@m', verdict: 'approve', current: true, own: false }]);
});

test('activity: done per day, claim-to-PR per agent from metrics, feed newest first', () => {
  const v = activityView({
    closed: [{ number: 1, title: 'A', closedAt: ago(60), assignees: [{ login: 'alex' }] }, { number: 2, title: 'B', closedAt: ago(60 * 24 * 2), assignees: [] }, { number: 3, title: 'old', closedAt: ago(60 * 24 * 30), assignees: [] }],
    merged: [{ number: 9, title: 'M', mergedAt: ago(30), mergedBy: { login: 'alex' } }],
    events: [
      { command: 'task claim', issue: 5, agent: 'claude@pc', status: 'success', at: ago(100) },
      { command: 'pr open', issue: 5, agent: 'claude@pc', status: 'success', at: ago(40) },
      { command: 'task claim', issue: 6, agent: 'claude@pc', status: 'error', at: ago(20) },
    ],
    now: NOW,
  });
  assert.equal(v.days.length, 7);
  assert.equal(v.done_total, 2, 'the 30-day-old task is outside the week');
  assert.deepEqual(v.claim_to_pr, [{ agent: 'claude@pc', median_min: 60, count: 1 }]);
  assert.equal(v.feed[0].kind, 'merged');
  assert.ok(!v.feed.some((f) => f.title === '#6'), 'failed commands are not activity');
  assert.equal(v.metrics_local, true);
});

test('new actions: release only a held task; answers only crew questions', () => {
  const held = { number: 9, labels: L('status:claimed', 'area:web'), assignees: [{ login: 'bob' }] };
  const r = actionArgs({ op: 'release', reason: 'session died' }, held, { login: 'alex' });
  assert.deepEqual(r.args, ['issue', 'edit', '9', '--add-label', 'status:ready', '--remove-label', 'status:claimed', '--remove-assignee', 'bob']);
  assert.match(r.comment, /<!-- crew:release agent=crew-board@alex /);
  assert.match(r.comment, /session died/);
  assert.match(actionArgs({ op: 'release' }, { number: 3, labels: L('status:ready') }).error, /not held/);
  assert.match(actionArgs({ op: 'release' }, { number: 3, labels: L('status:review') }).error, /PR in review/);
  const q = { number: 6, labels: L('crew:question', 'needs-human') };
  const a = actionArgs({ op: 'answer', value: 'Tax after <!-- crew:x --> discounts' }, q, { login: 'alex' });
  assert.deepEqual(a.args.slice(0, 5), ['issue', 'close', '6', '--reason', 'completed']);
  assert.match(a.args[6], /^<!-- crew:answer agent=@alex -->\n/);
  assert.ok(!a.args[6].includes('<!-- crew:x'), 'a person cannot smuggle markers');
  assert.match(actionArgs({ op: 'answer', value: '' }, q).error, /write the answer/);
  assert.match(actionArgs({ op: 'answer', value: 'x' }, { number: 7, labels: L('status:ready') }).error, /not a crew question/);
});

test('pause view lists only open crew:pause issues', () => {
  assert.deepEqual(pauseView([{ number: 1, title: 'stop', labels: L('crew:pause') }, { number: 2, title: 'done', labels: L('crew:pause'), state: 'CLOSED' }, { number: 3, title: 'x', labels: L('status:ready') }]), [{ number: 1, title: 'stop' }]);
});

test('page: tabs, drawer and a script that compiles; the repo name cannot break out', () => {
  const html = renderPage({ token: 'abc123', repo: 'acme/</script><b>' });
  assert.match(html, /id="tabs"/);
  assert.match(html, /id="drawer"/);
  assert.match(html, /id="pause"/);
  assert.ok(!html.includes('</script><b>'), 'the repo name is escaped everywhere');
  const script = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(script), 'the inlined client script is valid JavaScript');
});

test('HTTP: screen routes and team-wide actions (pause, resume, handoff)', async (t) => {
  const edits = [];
  let issues = [{ number: 7, title: 'T', labels: L('status:claimed'), assignees: [{ login: 'bob' }], updatedAt: ago(3) }];
  const captainCalls = [];
  const source = {
    issues: () => issues,
    prs: () => [],
    members: () => ['alex', 'bob'],
    edit: (args) => {
      edits.push(args);
      if (args[1] === 'create') issues = [...issues, { number: 99, title: 'crew:pause — x', labels: L('crew:pause'), assignees: [] }];
      return { code: 0, stdout: '', stderr: '' };
    },
    login: () => 'alex',
    issue: (n) => (n === 7 ? { ...issues[0], body: BODY, comments: [], state: 'OPEN' } : null),
    captain: (name, args, deps) => (captainCalls.push([name, args, deps.login]), { status: 'success', summary: `@${args.to} acts as captain` }),
  };
  let port;
  const server = createServer((req, res) => boardHandler({ source, token: 'tok', repo: 'acme/app', config: { captain: 'alex' }, allowedHosts: [`127.0.0.1:${port}`], now: () => NOW })(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const get = (p) => fetch(base + p, { headers: { 'x-crew-token': 'tok' } });
  const post = (body) => fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-crew-token': 'tok' }, body: JSON.stringify(body) });

  const task = await (await get('/api/task?n=7')).json();
  assert.equal(task.goal, 'Recalculate totals.');
  assert.equal(task.status, 'claimed', 'a task whose fields look like an HTTP reply is still a task');
  assert.equal((await get('/api/task?n=8')).status, 404);
  assert.equal((await get('/api/task?n=abc')).status, 400);
  for (const p of ['/api/team', '/api/inbox', '/api/discovery', '/api/prs', '/api/activity']) assert.equal((await get(p)).status, 200, p);
  assert.equal((await fetch(`${base}/api/team`)).status, 403, 'screens need the token too');

  assert.equal((await post({ op: 'pause', reason: 'demo\nfreeze' })).status, 200);
  assert.deepEqual(edits.at(-1).slice(0, 4), ['issue', 'create', '--title', 'crew:pause — demo freeze']);
  const board = await (await get('/api/board')).json();
  assert.deepEqual(board.paused.map((p) => p.number), [99]);
  assert.equal(board.login, 'alex');
  assert.equal((await post({ op: 'resume' })).status, 200);
  assert.deepEqual(edits.at(-1).slice(0, 3), ['issue', 'close', '99']);
  assert.equal((await post({ op: 'handoff', value: 'bob', hours: 4 })).status, 200);
  assert.deepEqual(captainCalls, [['captain handoff', { to: 'bob', hours: 4 }, 'alex']]);
  assert.equal((await post({ op: 'release', issue: 7 })).status, 200);
  assert.ok(edits.some((a) => a[0] === 'issue' && a[1] === 'comment' && a[2] === '7' && /crew:release agent=crew-board@alex/.test(a[4])), 'the release marker is posted');
  assert.equal((await post({ op: 'toString' })).status, 400, 'prototype names are not actions');
});
