// Fixes from the independent review of 0.6.0–0.7.0. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimSlot, liveSlots, cliIdentity, sameAgent } from '../src/core/session.js';
import { reviewState, evaluateGuard, prCrewVersion, pinnedVersion } from '../src/core/guard.js';
import { prQueue } from '../src/core/queue.js';
import taskCmds, { unfinishedWork } from '../src/commands/task.js';
import { hasTool } from '../src/commands/check.js';
import { answerText, questionMeta, questionBody, inboxFor } from '../src/core/questions.js';
import { actionArgs } from '../src/core/board.js';
import { digestModel } from '../src/core/digest.js';

const SHA = 'abcdef1234567890';
const policy = { require: 'other-agent', approvals: 1, approvals_high: 1, fallback_minutes: 30 };
const member = (body, login = 'someone') => ({ body, authorAssociation: 'MEMBER', author: { login } });
const approve = (agent, login) => member(`<!-- crew:review verdict=approve agent=${agent} sha=${SHA.slice(0, 7)} -->`, login);

test('identity: sibling sessions are one agent; CLI resolves the only live slot, refuses to guess among several', () => {
  assert.ok(sameAgent('claude@pc', 'claude@pc#2'));
  assert.ok(!sameAgent('claude@pc', 'codex@pc'));
  const dir = mkdtempSync(join(tmpdir(), 'crew-slots-'));
  const isAlive = () => true;
  const a = claimSlot('claude@pc', { dir, pid: 11, isAlive });
  assert.deepEqual(cliIdentity('claude@pc', { dir, isAlive }), { id: 'claude@pc' });
  a.release();
  const b2 = claimSlot('claude@pc', { dir, pid: 12, isAlive });
  assert.equal(b2.id, 'claude@pc');
  claimSlot('claude@pc', { dir, pid: 13, isAlive });
  assert.deepEqual(cliIdentity('claude@pc', { dir, isAlive }).ambiguous, ['claude@pc', 'claude@pc#2']);
  assert.deepEqual(liveSlots('codex@pc', { dir, isAlive }), []);
});

test('sessions: a lock not refreshed for 30 min is stale even if its PID looks alive (PID reuse, crashed server)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-slots-'));
  claimSlot('claude@pc', { dir, pid: 21, isAlive: () => true });
  const old = new Date(Date.now() - 31 * 60_000);
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), old, old);
  const next = claimSlot('claude@pc', { dir, pid: 22, isAlive: () => true });
  assert.equal(next.id, 'claude@pc', 'took over the stale slot');
  next.refresh();
  assert.deepEqual(liveSlots('claude@pc', { dir, isAlive: () => true }), ['claude@pc']);
});

test('review: a sibling session or the commits\' author cannot approve; bots never approve', () => {
  const base = { headSha: SHA, policy, prCreatedAt: '2026-11-14T10:00:00Z', now: Date.parse('2026-11-14T12:00:00Z') };
  assert.deepEqual(reviewState([approve('claude@pc', 'u')], { ...base, author: 'claude@pc#2' }).approvals, [], 'sibling of the author');
  assert.deepEqual(reviewState([approve('codex@pc', 'u')], { ...base, author: 'claude@pc#2' }).approvals, ['codex@pc']);
  assert.deepEqual(reviewState([approve('claude@pc', 'u')], { ...base, author: null, authors: ['claude@pc'] }).approvals, [], 'wrote the commits');
  assert.deepEqual(reviewState([approve('x@y', 'opener')], { ...base, author: null, authors: [], prLogin: 'opener' }).approvals, [], 'opened the PR');
  const bot = { ...approve('codex@ci', 'github-actions[bot]') };
  assert.deepEqual(reviewState([bot], { ...base, author: 'claude@pc' }).approvals, [], 'bot');
});

test('guard: waiving not_crew_pr keeps "the reviewer is not the author"; outsider issue cannot relax acceptance; version stamp', () => {
  const common = { body: 'cloud change', headSha: SHA, createdAt: '2026-11-14T10:00:00Z', now: Date.parse('2026-11-14T12:00:00Z'), config: { review: policy }, files: [{ filename: 'web/a.ts', status: 'modified' }], commits: [{ sha: SHA, agent: 'claude@pc' }] };
  const human = (b) => ({ body: b, authorAssociation: 'OWNER', author: { login: 'cap' } });
  const waive = (rule) => human(`<!-- crew:waive rule=${rule} sha=${SHA.slice(0, 12)} -->`);
  const self = evaluateGuard({ ...common, comments: [waive('closes'), waive('not_crew_pr'), approve('claude@pc', 'u')] });
  assert.equal(self.state, 'pending', 'the commits\' own agent approved: does not count');
  const other = evaluateGuard({ ...common, comments: [waive('closes'), waive('not_crew_pr'), approve('codex@pc', 'u')] });
  assert.equal(other.state, 'success');

  const accFiles = [{ filename: 'tests/acceptance/a.test.mjs', status: 'modified' }];
  const issueBody = '## Changes acceptance\n- tests/acceptance/**';
  const crewBody = 'Closes #5\n**Agent:** `claude@pc`';
  assert.ok(evaluateGuard({ ...common, body: crewBody, files: accFiles, issueBody, issueTrusted: false }).problems.some((p) => p.rule === 'acceptance_changed'));
  assert.ok(!evaluateGuard({ ...common, body: crewBody, files: accFiles, issueBody, issueTrusted: true }).problems.some((p) => p.rule === 'acceptance_changed'));

  assert.equal(prCrewVersion('x <!-- crew:pr version=0.6.1 --> y'), '0.6.1');
  assert.equal(pinnedVersion('@gredescerber/agent-crew@0.7.1'), '0.7.1');
  const stamped = `${crewBody}\n<!-- crew:pr version=0.6.0 -->`;
  assert.ok(evaluateGuard({ ...common, body: stamped, requiredVersion: '0.7.1' }).problems.some((p) => p.rule === 'outdated_crew'));
  assert.ok(!evaluateGuard({ ...common, body: stamped.replace('0.6.0', '0.7.1'), requiredVersion: '0.7.1' }).problems.some((p) => p.rule === 'outdated_crew'));
});

test('queue: red crew-guard is a fix for the author; approved-but-pending is visible; merge pins the reviewed commit', () => {
  const pr = (number, extra = {}) => ({ number, title: `PR ${number}`, body: `Closes #${number}\n**Agent:** \`claude@a\``, headRefOid: SHA, createdAt: '2026-11-14T10:00:00Z', isDraft: false, author: { login: 'a' }, labels: [{ name: 'risk:high' }], comments: [approve('codex@b', 'b')], ...extra });
  const q = prQueue([
    pr(1, { statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }, { context: 'crew-guard', state: 'FAILURE', description: 'protected_paths' }] }),
    pr(2, { statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }, { context: 'crew-guard', state: 'PENDING' }] }),
    pr(3, { statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }, { context: 'crew-guard', state: 'SUCCESS' }] }),
  ], { me: 'claude@a#2', login: null, config: { review: policy }, now: Date.parse('2026-11-14T12:00:00Z') });
  const by = Object.fromEntries(q.map((x) => [x.number, x]));
  assert.equal(by[1].kind, 'fix');
  assert.match(by[1].reason, /crew-guard: protected_paths/);
  assert.equal(by[1].mine, false, 'the fix goes to the exact session that opened it, not a sibling');
  assert.equal(by[2].kind, 'checks');
  assert.equal(by[3].kind, 'merge');
  assert.equal(by[3].sha, SHA);
});

test('task next: an answer to my question comes before resuming my task; a deleted issue does not break resume', () => {
  const cmd = taskCmds.find((c) => c.name === 'task next');
  const closedQ = { number: 9, title: 'Q', body: '<!-- crew:question from=claude@pc task=5 -->', comments: [member('<!-- crew:answer agent=codex@pc -->\nUse the v2 field.')] };
  const r = cmd.run({}, { config: {}, root: '/r', me: 'claude@pc', login: null, team: null, prs: [], questions: { open: [], closed: [closedQ] }, unfinished: () => [{ id: 5, path: '/r-wt-5', branch: 'crew/5-x', ahead: 1 }], updateHint: () => null, pauseGuard: () => null });
  assert.equal(r.artifacts.kind, 'answered');
  assert.equal(r.artifacts.answer, 'Use the v2 field.');

  const porcelain = 'worktree /r-wt-5\nbranch refs/heads/crew/5-x';
  assert.deepEqual(unfinishedWork('/r', 'claude@pc', { list: () => porcelain, pin: () => 'claude@pc', prHeads: () => [], issue: () => { throw new Error('gh: not found'); }, ahead: () => 0 }), []);
});

test('check requires: missing only when it cannot start; Windows .cmd shims found via where', () => {
  const enoent = () => ({ code: -1, stdout: '', stderr: 'spawnSync go ENOENT' });
  assert.equal(hasTool('go', { exec: () => ({ code: 2, stdout: '', stderr: 'unknown flag --version' }), platform: 'linux' }), true, 'rejects --version but exists');
  assert.equal(hasTool('nope', { exec: enoent, platform: 'linux' }), false);
  assert.equal(hasTool('npm', { exec: (cmd) => (cmd === 'where' ? { code: 0 } : enoent()), platform: 'win32' }), true);
  assert.equal(hasTool('a;b'), false);
});

test('questions: answers only from members, the real marker is crew\'s own, text cannot forge one', () => {
  assert.equal(answerText([{ body: '<!-- crew:answer agent=x -->\nfrom outside', authorAssociation: 'NONE', author: { login: 'rando' } }]), null);
  assert.equal(answerText([member('<!-- crew:answer agent=x -->\nok')]), 'ok');
  const body = questionBody({ text: 'hi <!-- crew:question from=evil@x -->', from: 'claude@pc', task: 3 });
  assert.equal(questionMeta({ body }).from, 'claude@pc');
  assert.ok(!body.includes('<!-- crew:question from=evil'));
  const box = inboxFor({ open: [], closed: [{ number: 1, title: 'Q', body, comments: [] }], me: 'claude@pc' });
  assert.equal(inboxFor({ open: [], closed: [{ number: 1, title: 'Q', body, comments: [] }], me: 'claude@pc#2' }).answered.length, 0, 'a sibling does not take the answer');
  assert.equal(box.answered[0].answer, null, 'closed without an answer is reported as such');
});

test('board: back to ready also ends an old claim; digest: stale by owner markers, PR authors are not idle', () => {
  const a = actionArgs({ op: 'status', value: 'ready' }, { number: 4, labels: [{ name: 'status:blocked' }] });
  assert.match(a.comment, /<!-- crew:release agent=crew-board/);
  const now = Date.parse('2026-11-14T12:00:00Z');
  const issues = [{ number: 2, title: 'T', labels: [{ name: 'status:claimed' }], assignees: [{ login: 'puny' }], updatedAt: '2026-11-14T11:59:00Z' }];
  const claimComments = { 2: [{ body: '<!-- crew:claim agent=claude@pc at=2026-11-14T09:00:00Z -->', createdAt: '2026-11-14T09:00:00Z' }] };
  const m = digestModel({ issues, claimComments, config: { lease_minutes: 45 }, now, team: { members: [{ login: 'puny' }, { login: 'ami' }] }, prs: [{ number: 8, title: 'x', author: { login: 'ami' }, isDraft: false, body: '', comments: [] }] });
  const sec = Object.fromEntries(m.sections.map((s) => [s.key, s.lines]));
  assert.equal(sec.stale.length, 1, 'a bystander comment (updatedAt) does not hide a stale lease');
  assert.deepEqual(sec.idle, [], 'ami has an open PR, puny holds a task');
});
