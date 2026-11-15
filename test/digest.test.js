// crew digest: deterministic team status and the pinned issue. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { digestModel, renderDigest, DIGEST_LABEL } from '../src/core/digest.js';
import digest, { postDigest } from '../src/commands/digest.js';
import { findCommand } from '../src/core/registry.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const issue = (number, status, login, extra = {}) => ({ number, title: `Task ${number}`, labels: [{ name: `status:${status}` }], assignees: login ? [{ login }] : [], updatedAt: ago(5), ...extra });
const SHA = 'abcdef1234567890';
const DATA = {
  issues: [
    issue(1, 'claimed', 'ami'),
    issue(2, 'claimed', 'puny', { updatedAt: ago(120) }),
    issue(3, 'ready', 'wohor'),
    issue(4, 'blocked', 'puny'),
    issue(5, 'needs-spec', null),
    { number: 6, title: 'Epic', labels: [{ name: 'epic' }], assignees: [], updatedAt: ago(1) },
  ],
  prs: [{ number: 10, title: 'red one', body: 'Closes #1\n**Agent:** `claude@a`', headRefOid: SHA, createdAt: ago(50), isDraft: false, author: { login: 'ami' }, labels: [], comments: [], statusCheckRollup: [{ name: 'check', conclusion: 'FAILURE' }] },
    { number: 11, title: 'waiting', body: 'Closes #2\n**Agent:** `codex@b`', headRefOid: SHA, createdAt: ago(45), isDraft: false, author: { login: 'puny' }, labels: [], comments: [], statusCheckRollup: [] }],
  questions: [
    { number: 20, title: 'Q: pick a db', body: '<!-- crew:question from=claude@a task=1 -->', labels: [{ name: 'crew:question' }, { name: 'needs-human' }], assignees: [{ login: 'cap' }], createdAt: ago(30) },
    { number: 21, title: 'Q [api]: field name?', body: '<!-- crew:question from=codex@b -->', labels: [{ name: 'crew:question' }], assignees: [{ login: 'ami' }], createdAt: ago(10) },
  ],
  team: { members: [{ login: 'ami', areas: ['web'] }, { login: 'puny', areas: ['api'] }, { login: 'wohor', areas: ['research'] }, { login: 'cap', areas: ['infra'] }] },
};

test('digest model: human, stale leases, PRs, questions and idle members, without an LLM', () => {
  const m = digestModel({ ...DATA, config: { lease_minutes: 45 }, now: NOW });
  const sec = Object.fromEntries(m.sections.map((s) => [s.key, s.lines]));
  assert.equal(sec.human.length, 3, 'needs-human question + blocked + needs-spec');
  assert.match(sec.human[0], /#20 .*asked by claude@a/);
  assert.deepEqual(sec.stale.map((l) => l.split(' ')[0]), ['#2']);
  assert.match(sec.prs[0], /#10 .*waits for its author \(red check\)/);
  assert.match(sec.prs[1], /#11 .*waits for review 45 min \(slow\)/);
  assert.deepEqual(sec.questions.map((l) => l.split(' ')[0]), ['#21']);
  assert.deepEqual(sec.idle, ['@wohor: nothing in progress, 1 ready task(s) assigned', '@cap: nothing in progress, no ready tasks assigned']);
  assert.deepEqual(m.counts, { ready: 1, claimed: 2, human: 3, stale: 1, prs: 2, questions: 1, ideas: 0, idle: 2 });
});

test('digest markdown never pings anyone (it is rewritten every 15 minutes)', () => {
  const md = renderDigest(digestModel({ ...DATA, now: NOW }), { now: NOW });
  assert.match(md, /^<!-- crew:digest -->/);
  assert.doesNotMatch(md, /@(?=[\w-])/, 'every @mention is broken');
  assert.match(md, /2026-11-14 12:00 UTC/);
  assert.match(renderDigest(digestModel({ now: NOW }), { now: NOW }), /- none/);
});

test('digest --post creates and pins the issue once, then only edits it', () => {
  const calls = [];
  const fake = (existing) => ({
    ghJson: (args) => (calls.push(['json', ...args]), existing),
    gh: (args, opts) => (calls.push([...args, opts?.input ? 'with-body' : '']), { code: 0, stdout: args[1] === 'create' ? 'https://github.com/o/r/issues/77\n' : '', stderr: '' }),
  });
  assert.deepEqual(postDigest('body', fake([])), { issue: 77, created: true });
  assert.ok(calls.some((c) => c[0] === 'issue' && c[1] === 'create' && c.includes(DIGEST_LABEL) && c.includes('with-body')));
  assert.ok(calls.some((c) => c.join(' ') === 'issue pin 77 '));
  calls.length = 0;
  assert.deepEqual(postDigest('body', fake([{ number: 77 }])), { issue: 77, created: false });
  assert.deepEqual(calls.filter((c) => c[0] !== 'json'), [['issue', 'edit', '77', '--body-file', '-', 'with-body']]);
  assert.ok(postDigest('body', { ghJson: () => [], gh: () => ({ code: 1, stdout: '', stderr: 'label not found' }) }).error);
});

test('crew digest command: summary, warning status and registry', () => {
  const r = digest.run({}, { config: { lease_minutes: 45 }, data: DATA, now: NOW });
  assert.equal(r.status, 'warning');
  assert.match(r.summary, /3 need a human, 1 stale, 2 PRs waiting, 2 idle/);
  assert.equal(r.artifacts.issue, null);
  const quiet = digest.run({}, { config: {}, data: { issues: [], prs: [], questions: [], team: null }, now: NOW });
  assert.equal(quiet.status, 'success');
  assert.equal(findCommand(['digest']).name, 'digest');
});

test('crew board carries the captain panel (same digest as the pinned issue)', async () => {
  const { boardModel, renderPage } = await import('../src/core/board.js');
  const m = boardModel({ ...DATA, members: ['ami'], config: { lease_minutes: 45 }, now: NOW });
  assert.deepEqual(m.digest.counts, digestModel({ ...DATA, config: { lease_minutes: 45 }, now: NOW }).counts);
  assert.match(renderPage({ token: 't', repo: 'o/r' }), /id="kpis"/);
  assert.equal(boardModel({ now: NOW }).digest.counts.human, 0, 'works without questions or team');
});
