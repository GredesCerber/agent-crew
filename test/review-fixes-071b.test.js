// Second review pass of the 0.7.1 fixes (N1–N12). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimSlot, liveSlots, cliIdentity, sameAgent } from '../src/core/session.js';
import { reviewState, evaluateGuard } from '../src/core/guard.js';
import { prQueue } from '../src/core/queue.js';
import { answerText } from '../src/core/questions.js';
import { prLines } from '../src/commands/status.js';

const SHA = 'abcdef1234567890';
const policy = { require: 'other-vendor', approvals: 1, approvals_high: 1, fallback_minutes: 30 };
const member = (body, login = 'm') => ({ body, authorAssociation: 'MEMBER', author: { login } });
const slotDir = () => mkdtempSync(join(tmpdir(), 'crew-slots-'));

test('N1: a vendor/model id keeps its real name in the lock, so a terminal call is still the same agent', () => {
  const dir = slotDir();
  const s = claimSlot('claude/opus@pc', { dir, pid: 31, isAlive: () => true });
  assert.equal(s.id, 'claude/opus@pc');
  assert.deepEqual(liveSlots('claude/opus@pc', { dir, isAlive: () => true }), ['claude/opus@pc']);
  assert.deepEqual(cliIdentity('claude/opus@pc', { dir, isAlive: () => true }), { id: 'claude/opus@pc' });
  const rs = reviewState([member(`<!-- crew:review verdict=approve agent=claude/opus@pc sha=${SHA.slice(0, 7)} -->`)], { headSha: SHA, author: 'claude/opus@pc#2', policy, prCreatedAt: '2026-11-14T10:00:00Z', now: Date.parse('2026-11-14T10:05:00Z') });
  assert.deepEqual(rs.approvals, [], 'not another vendor');
});

test('N2: when the first of two sessions ends, a new one takes the free plain slot, never a sibling of a sibling', () => {
  const dir = slotDir();
  const isAlive = () => true;
  const a = claimSlot('claude@pc', { dir, pid: 41, isAlive });
  const b = claimSlot('claude@pc', { dir, pid: 42, isAlive });
  assert.equal(b.id, 'claude@pc#2');
  a.release();
  const c = claimSlot('claude@pc', { dir, pid: 43, isAlive }); // the MCP server claims from the base, not from agentId()
  assert.equal(c.id, 'claude@pc');
  assert.ok(sameAgent(c.id, b.id));
  assert.deepEqual(cliIdentity('claude@pc', { dir, isAlive }).ambiguous, ['claude@pc', 'claude@pc#2']);
});

test('N3: hostnames ending in digits are separate machines; only "#N" marks a sibling session', () => {
  assert.ok(!sameAgent('claude@lab-1', 'claude@lab-2'));
  assert.ok(sameAgent('claude@lab-2', 'claude@lab-2#2'));
  assert.ok(!sameAgent('claude@ip-10-0-0-5', 'claude@ip-10-0-0-6'));
});

test('N10: a stale lock is taken over cleanly, leaving no moved-aside files', () => {
  const dir = slotDir();
  claimSlot('codex@pc', { dir, pid: 51, isAlive: () => true });
  const old = new Date(Date.now() - 31 * 60_000);
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), old, old);
  assert.equal(claimSlot('codex@pc', { dir, pid: 52, isAlive: () => true }).id, 'codex@pc');
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.stale-')), []);
  assert.equal(claimSlot('codex@pc', { dir, pid: 53, isAlive: () => true }).id, 'codex@pc#2', 'a fresh lock is never taken');
});

test('N5: once the repo pins a version, a crew PR without the stamp (made by an old crew) fails too', () => {
  const base = { headSha: SHA, createdAt: '2026-11-14T10:00:00Z', files: [], commits: [{ sha: SHA, agent: 'claude@pc' }], requiredVersion: '0.7.1' };
  const rules = (body) => evaluateGuard({ ...base, body }).problems.map((p) => p.rule);
  assert.ok(rules('Closes #1\n**Agent:** `claude@pc`').includes('outdated_crew'));
  assert.ok(!rules('Closes #1\n**Agent:** `claude@pc`\n<!-- crew:pr version=0.7.1 -->').includes('outdated_crew'));
  assert.ok(!rules('Closes #1\nmade by hand').includes('outdated_crew'), 'not a crew PR: other rules handle it');
});

test('N6/N7/N9: guard reason points to crew guard; checks kind in status; the fix goes to the exact session', () => {
  const pr = (number, statusCheckRollup) => ({ number, title: `PR ${number}`, body: `Closes #${number}\n**Agent:** \`claude@pc\``, headRefOid: SHA, createdAt: '2026-11-14T10:00:00Z', isDraft: false, author: { login: 'a' }, labels: [], comments: [member(`<!-- crew:review verdict=approve agent=codex@pc sha=${SHA.slice(0, 7)} -->`)], statusCheckRollup });
  const prs = [
    pr(1, [{ name: 'check', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', context: 'crew-guard', state: 'FAILURE' }]), // real gh: no description
    pr(2, [{ name: 'check', conclusion: 'SUCCESS' }, { context: 'crew-guard', state: 'PENDING' }]),
  ];
  const now = Date.parse('2026-11-14T12:00:00Z');
  const q = prQueue(prs, { me: 'claude@pc#2', login: null, config: { review: policy }, now });
  assert.match(q[0].reason, /crew guard --pr 1/);
  assert.equal(q[0].mine, false, 'a sibling session is not handed the fix');
  assert.equal(prQueue(prs, { me: 'claude@pc', login: null, config: { review: policy }, now })[0].mine, true);
  const lines = prLines(prs, { config: { review: policy }, now });
  assert.ok(lines.some((l) => /#2 .*approved, waiting for checks/.test(l)));
  assert.ok(!lines.some((l) => /undefined/.test(l)));
});

test('N8: a human answer in the GitHub UI reaches the agent; the hand-off note never counts as the answer', () => {
  const handoff = member('<!-- crew:answer agent=codex@pc -->\n**Needs a human decision** (`codex@pc`): which db?');
  assert.equal(answerText([handoff, member('Use Postgres, keep SQLite for tests.', 'captain')]), 'Use Postgres, keep SQLite for tests.');
  assert.equal(answerText([handoff]), null);
  assert.equal(answerText([{ body: 'spam', authorAssociation: 'NONE', author: { login: 'x' } }]), null);
  assert.equal(answerText([member('<!-- crew:answer agent=codex@pc -->\nfield v2'), member('Correction: v3.', 'captain')]), 'field v2\n\nCorrection: v3.', 'a later human correction is kept');
});

test('F2: a quote reply to the hand-off is an answer; several human replies are joined, not just the last', () => {
  const handoff = member('<!-- crew:answer agent=codex@pc -->\n**Needs a human decision** (`codex@pc`): which db?');
  const quote = member('> **Needs a human decision** (`codex@pc`): which db?\n\nPostgres.', 'captain');
  assert.match(answerText([handoff, quote]), /Postgres\./);
  assert.equal(answerText([handoff, member('Postgres.', 'captain'), member('thanks!', 'captain')]), 'Postgres.\n\nthanks!');
  assert.equal(answerText([member('old note before the hand-off'), handoff, member('Postgres.', 'captain')]), 'Postgres.', 'only after the last hand-off');
  assert.ok(answerText([member('x'.repeat(10_000))]).length <= 4000, 'bounded');
});
