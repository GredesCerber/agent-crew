// crew board: model, validated actions, HTTP handler (fake gh source, real local server on a free port).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

import { boardModel, actionArgs, renderPage, COLUMNS } from '../src/core/board.js';
import { boardHandler } from '../src/commands/board.js';
import { taskOrder } from '../src/core/queue.js';

const L = (...names) => names.map((name) => ({ name }));
const NOW = Date.parse('2026-11-14T12:00:00Z');
const issue = (number, status, { assignees = [], extra = [] } = {}) => ({
  number, title: `Task ${number}`, labels: L(`status:${status}`, 'area:web', 'tier:mid', 'risk:med', ...extra),
  assignees: assignees.map((login) => ({ login })), updatedAt: new Date(NOW - 7 * 60000).toISOString(),
});

test('board model: columns by status, priority first, epics skipped', () => {
  const m = boardModel({
    issues: [issue(3, 'ready'), issue(4, 'ready', { extra: ['priority:high'] }), issue(5, 'claimed', { assignees: ['bob'] }), { ...issue(6, 'ready'), labels: L('epic') }],
    members: ['bob', 'alice', 'bob'], now: NOW,
  });
  assert.deepEqual(Object.keys(m.columns), COLUMNS);
  assert.deepEqual(m.columns.ready.map((c) => c.number), [4, 3], 'priority:high first');
  assert.equal(m.columns.claimed[0].assignees[0], 'bob');
  assert.equal(m.columns.ready[1].idle_min, 7);
  assert.deepEqual(m.members, ['alice', 'bob']);
});

test('actions are validated: members only, no hijacking claimed tasks, priority labels', () => {
  const members = ['alice', 'bob'];
  const t = issue(7, 'ready', { assignees: ['alice'] });
  assert.deepEqual(actionArgs({ op: 'assign', value: 'bob' }, t, { members }).args, ['issue', 'edit', '7', '--remove-assignee', 'alice', '--add-assignee', 'bob']);
  assert.deepEqual(actionArgs({ op: 'assign', value: '' }, t, { members }).args, ['issue', 'edit', '7', '--remove-assignee', 'alice']);
  assert.match(actionArgs({ op: 'assign', value: 'mallory' }, t, { members }).error, /not a member/);
  assert.match(actionArgs({ op: 'assign', value: 'x --repo evil/r' }, t, { members }).error, /not a member/);
  assert.deepEqual(actionArgs({ op: 'status', value: 'blocked' }, t).args, ['issue', 'edit', '7', '--add-label', 'status:blocked', '--remove-label', 'status:ready']);
  assert.match(actionArgs({ op: 'status', value: 'ready' }, issue(8, 'claimed')).error, /crew task release 8 --force/);
  assert.match(actionArgs({ op: 'status', value: 'done' }, t).error, /status must be/);
  assert.deepEqual(actionArgs({ op: 'priority', value: 'high' }, t).args, ['issue', 'edit', '7', '--add-label', 'priority:high']);
  assert.deepEqual(actionArgs({ op: 'priority', value: 'normal' }, issue(9, 'ready', { extra: ['priority:high'] })).args, ['issue', 'edit', '9', '--remove-label', 'priority:high']);
  assert.equal(actionArgs({ op: 'priority', value: 'normal' }, t).noop, true);
  assert.match(actionArgs({ op: 'delete' }, t).error, /unknown action/);
  assert.match(actionArgs({ op: 'assign', value: 'bob' }, undefined).error, /unknown issue/);
});

test('page escapes the repo name and embeds the token', () => {
  const html = renderPage({ token: 'abc123', repo: 'acme/<app>' });
  assert.match(html, /acme\/&lt;app&gt;/);
  assert.match(html, /const TOKEN="abc123"/);
});

test('task next order: priority inside the same owner group', () => {
  const order = taskOrder([issue(1, 'ready'), issue(2, 'ready', { extra: ['priority:low'] }), issue(3, 'ready', { extra: ['priority:high'] })], { login: 'x' });
  assert.deepEqual(order.map((o) => o.issue.number), [3, 1, 2]);
});

test('HTTP: host check, token check, actions go through gh only after validation', async (t) => {
  const edits = [];
  const issues = [issue(7, 'ready', { assignees: ['alice'] })];
  const source = { issues: () => issues, prs: () => [], members: () => ['alice', 'bob'], edit: (args) => (edits.push(args), { code: 0, stdout: '', stderr: '' }) };
  let port;
  const server = createServer((req, res) => boardHandler({ source, token: 'tok', repo: 'acme/app', allowedHosts: [`127.0.0.1:${port}`] })(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${base}/`)).status, 403, 'the page itself needs the key from the printed address');
  assert.equal((await fetch(`${base}/?t=wrong`)).status, 403);
  const page = await fetch(`${base}/?t=tok`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer', 'the key never leaks to GitHub links');
  assert.equal((await fetch(`${base}/api/board`)).status, 403, 'no token');
  const board = await (await fetch(`${base}/api/board`, { headers: { 'x-crew-token': 'tok' } })).json();
  assert.equal(board.columns.ready[0].number, 7);
  // fetch cannot override Host, so a raw request plays the DNS-rebinding page
  const badStatus = await new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path: '/api/board', headers: { host: 'evil.example', 'x-crew-token': 'tok' } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', reject);
    r.end();
  });
  assert.equal(badStatus, 403, 'DNS rebinding: foreign Host refused');

  const post = (body, headers = {}) => fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-crew-token': 'tok', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ issue: 7, op: 'assign', value: 'mallory' })).status, 400);
  assert.equal((await post({ issue: 7, op: 'assign', value: 'bob' }, { 'x-crew-token': 'nope' })).status, 403);
  assert.equal(edits.length, 0, 'nothing reached gh yet');
  assert.equal((await post({ issue: 7, op: 'assign', value: 'bob' })).status, 200);
  assert.deepEqual(edits, [['issue', 'edit', '7', '--remove-assignee', 'alice', '--add-assignee', 'bob']]);
  const form = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-crew-token': 'tok' }, body: 'issue=7' });
  assert.equal(form.status, 415);
});
