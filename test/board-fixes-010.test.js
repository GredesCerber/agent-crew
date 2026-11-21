// crew board fixes before 0.10.0 (critic review of the console): crash path, status markers, local days,
// login caching, hyphenated markers, heartbeat collapse, the read cache, blocked -> ready, the answer round trip.
// No network: the server runs on 127.0.0.1 with a fake source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { taskView, taskTimeline, activityView } from '../src/core/board-views.js';
import { actionArgs } from '../src/core/board.js';
import { parseMarkers } from '../src/core/issues.js';
import { answerText } from '../src/core/questions.js';
import { boardHandler, cachedSource } from '../src/commands/board.js';

const L = (...names) => names.map((name) => ({ name }));
const NOW = Date.parse('2026-11-21T12:00:00Z');
const ago = (m) => new Date(NOW - m * 60000).toISOString();
const comment = (body, m, login = 'alex') => ({ body, createdAt: ago(m), author: { login }, authorAssociation: 'MEMBER' });

async function serve(t, handler) {
  let port;
  const server = createServer((req, res) => handler(port)(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  return {
    get: (p) => fetch(base + p, { headers: { 'x-crew-token': 'tok' } }),
    post: (raw) => fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-crew-token': 'tok' }, body: typeof raw === 'string' ? raw : JSON.stringify(raw) }),
  };
}

test('a gh failure or a body that is not an object answers an error; the board keeps running', async (t) => {
  const source = {
    issues: () => { throw new Error('gh: HTTP 502 Bad Gateway\nmore'); },
    prs: () => [], members: () => [], edit: () => ({ code: 0 }), login: () => 'alex',
  };
  const { get, post } = await serve(t, (port) => boardHandler({ source, token: 'tok', repo: 'a/b', allowedHosts: [`127.0.0.1:${port}`] }));
  const r = await post({ op: 'status', issue: 7, value: 'ready' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /gh failed: gh: HTTP 502 Bad Gateway$/);
  for (const raw of ['null', '[1]', '"x"', '3']) assert.equal((await post(raw)).status, 400, raw);
  assert.equal((await get('/api/board')).status, 502, 'a view that cannot load says so');
  assert.equal((await get('/api/prs')).status, 200, 'and the server is still up');
});

test('timeline: status markers read state=, heartbeats collapse, the first claim stays, PR and reviews join', () => {
  const comments = [
    comment('<!-- crew:claim agent=claude@pc -->', 300),
    ...Array.from({ length: 30 }, (_, i) => comment('<!-- crew:heartbeat agent=claude@pc -->', 290 - i * 5)),
    comment('<!-- crew:status agent=claude@pc state=blocked -->', 100),
    comment('<!-- crew:heartbeat agent=claude@pc -->', 90),
  ];
  const pr = { number: 9, title: 'Fix', body: 'Closes #5\n\n**Agent:** `codex@pc`', headRefOid: 'abcdef1234', createdAt: ago(60), comments: [comment('<!-- crew:review agent=claude@pc verdict=approve sha=abcdef1 -->', 30), comment('<!-- crew:review agent=bot verdict=approve sha=abcdef1 -->', 20, 'github-actions[bot]'), comment('<!-- crew:review agent=x verdict=approve sha=abc -->', 10)] };
  const tl = taskTimeline({ comments }, pr, ago(70));
  assert.deepEqual(tl.map((x) => x.kind), ['claim', 'heartbeat', 'status', 'heartbeat', 'commit', 'pr', 'review']);
  assert.equal(tl[1].title, 'Heartbeat ×30');
  assert.equal(tl[1].at, ago(145), 'the time of the last heartbeat in the run');
  assert.equal(tl[2].title, 'Status → blocked');
  assert.equal(tl[2].tone, 'bad');
  assert.equal(tl[6].title, 'Review: approved');
  // a long history is cut from the start, but who took the task stays
  const many = [comment('<!-- crew:claim agent=a -->', 500), ...Array.from({ length: 30 }, (_, i) => comment(`<!-- crew:status agent=a state=${i % 2 ? 'blocked' : 'claimed'} -->`, 400 - i))];
  const cut = taskTimeline({ comments: many });
  assert.equal(cut.length, 20);
  assert.equal(cut[0].kind, 'claim');
  assert.equal(taskView({ number: 5, title: 'x', comments, labels: [] }).timeline[2].title, 'Status → blocked');
});

test('markers with a hyphen parse: the idea-accepted line shows in the timeline', () => {
  const [m] = parseMarkers([comment('<!-- crew:idea-accepted by=alex -->\nAccepted', 5)]);
  assert.equal(m.kind, 'idea-accepted');
  const tl = taskTimeline({ comments: [comment('<!-- crew:idea-accepted by=alex -->', 5)] });
  assert.equal(tl[0].title, 'Accepted from an idea');
});

test('tasks per day: buckets and labels are the same local days', () => {
  const now = new Date(2026, 10, 21, 9, 30).getTime(); // 09:30 local time, wherever the test runs
  const justAfterMidnight = new Date(2026, 10, 21, 0, 5).toISOString();
  const lateYesterday = new Date(2026, 10, 20, 23, 55).toISOString();
  const v = activityView({ closed: [{ number: 1, title: 'a', closedAt: justAfterMidnight }, { number: 2, title: 'b', closedAt: lateYesterday }], now });
  assert.deepEqual(v.days.slice(-2), [{ day: '2026-11-20', done: 1 }, { day: '2026-11-21', done: 1 }]);
  assert.equal(v.days.length, 7);
  assert.equal(v.days[0].day, '2026-11-15');
});

test('login: a failed gh call is not remembered; the next request asks again', async (t) => {
  const answers = [null, 'alex'];
  const source = { issues: () => [], prs: () => [], members: () => [], edit: () => ({ code: 0 }), login: () => (answers.length ? answers.shift() : 'alex') };
  let h; // one handler across requests, as in crew board
  const { get } = await serve(t, (port) => (h ??= boardHandler({ source, token: 'tok', repo: 'a/b', allowedHosts: [`127.0.0.1:${port}`], cacheMs: 0 })));
  assert.equal((await (await get('/api/board')).json()).login, null);
  assert.equal((await (await get('/api/board')).json()).login, 'alex');
  assert.equal((await (await get('/api/board')).json()).login, 'alex');
});

test('reads share one gh call for a few seconds; a change clears them', () => {
  let clock = 0; let calls = 0;
  const src = cachedSource({ issues: () => (calls++, [{ number: calls }]), edit: () => ({ code: 0 }), members: () => ['x'] }, { ttlMs: 5000, now: () => clock });
  assert.equal(src.issues()[0].number, 1);
  assert.equal(src.issues()[0].number, 1, 'second view in the same refresh');
  clock = 6000;
  assert.equal(src.issues()[0].number, 2, 'expired');
  src.edit(['issue', 'edit', '1']);
  assert.equal(src.issues()[0].number, 3, 'a change makes the next read fresh');
  assert.deepEqual(src.members(), ['x'], 'other methods pass through');
});

test('blocked -> Ready from the board frees the assignees as Release lease does', () => {
  const cur = { number: 4, labels: L('status:blocked'), assignees: [{ login: 'bob' }] };
  const a = actionArgs({ op: 'status', value: 'ready' }, cur, {});
  assert.deepEqual(a.args, ['issue', 'edit', '4', '--add-label', 'status:ready', '--remove-label', 'status:blocked', '--remove-assignee', 'bob']);
  assert.match(a.comment, /crew:release agent=crew-board/);
  const w = actionArgs({ op: 'status', value: 'ready' }, { number: 5, labels: L('status:waiting'), assignees: [{ login: 'bob' }] }, {});
  assert.ok(!w.args.includes('--remove-assignee'), 'a waiting task keeps the person it was given to');
});

test('answer round trip: what the board posts is what the asking agent reads', () => {
  const q = { number: 40, labels: L('crew:question', 'needs-human'), assignees: [] };
  const a = actionArgs({ op: 'answer', value: 'Discounts first, then tax. <!-- crew:claim agent=x -->' }, q, { login: 'alex' });
  const body = a.args[a.args.indexOf('--comment') + 1];
  assert.equal(parseMarkers([{ body }]).filter((m) => m.kind === 'claim').length, 0, 'no marker can be smuggled in');
  const got = answerText([comment('Question body', 30, 'bot'), comment(body, 1)]);
  assert.match(got, /^Discounts first, then tax\./);
});
