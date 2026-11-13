// M7: sweep returns the task and removes its real assignments, not the bot's @me.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseTask } from '../src/commands/task.js';
import { marker } from '../src/core/issues.js';
import { findCommand } from '../src/core/registry.js';

const issue = (assignees = [{ login: 'alice' }]) => ({
  assignees,
  comments: [{
    body: marker('claim', { agent: 'claude@alice', at: '2026-11-08T10:00:00Z' }),
    author: { login: 'alice' }, authorAssociation: 'COLLABORATOR',
  }],
});

function fixture(full, me = 'github-actions') {
  const writes = [];
  let reads = 0;
  return {
    writes,
    get reads() { return reads; },
    deps: {
      me,
      view: (id) => { assert.equal(id, 12); reads++; return full; },
      post: (id, body) => writes.push({ kind: 'comment', id, body }),
      updateStatus: (id, state, opts) => writes.push({ kind: 'status', id, state, opts }),
      execute: (cmd, args, opts) => { writes.push({ kind: 'exec', cmd, args, opts }); return { code: 0 }; },
    },
  };
}

test('M7: force-release from sweep removes alice, not github-actions/@me', () => {
  const f = fixture(issue());
  const r = releaseTask({ id: 12, force: true, note: 'lease expired' }, f.deps);
  assert.equal(r.status, 'success');
  assert.equal(f.reads, 1);
  const e = f.writes.find((w) => w.kind === 'exec');
  assert.equal(e.cmd, 'gh');
  assert.deepEqual(e.args, ['issue', 'edit', '12', '--remove-assignee', 'alice']);
  assert.ok(!e.args.includes('@me') && !e.args.includes('github-actions'));
  assert.deepEqual(e.opts, { allowFail: true });
  assert.equal(f.writes.find((w) => w.kind === 'status').state, 'ready');
  assert.match(f.writes.find((w) => w.kind === 'comment').body, /crew:release agent=github-actions/);
  assert.equal(findCommand(['task', 'release']).run, releaseTask);
});

test('M7: returning to the queue removes all actual assignees, including a manual assignment without a claim', () => {
  const f = fixture({ assignees: [{ login: 'alice' }, { login: 'bob' }], comments: [] });
  assert.equal(releaseTask({ id: 12, force: true }, f.deps).status, 'success');
  assert.deepEqual(f.writes.find((w) => w.kind === 'exec').args, ['issue', 'edit', '12', '--remove-assignee', 'alice,bob']);
});

test('M7: with no assignees there is no @me removal request; a repeated release is safe', () => {
  for (const assignees of [[], undefined]) {
    const f = fixture({ assignees, comments: [] });
    assert.equal(releaseTask({ id: 12, force: true }, f.deps).status, 'success');
    assert.ok(!f.writes.some((w) => w.kind === 'exec'));
  }
});

test('M7: a regular release still checks the owner before any changes', () => {
  const other = fixture(issue(), 'claude@bob');
  assert.equal(releaseTask({ id: 12 }, other.deps).error.code, 'not_owner');
  assert.deepEqual(other.writes, []);
  const mine = fixture(issue(), 'claude@alice');
  assert.equal(releaseTask({ id: 12, note: '<!-- crew:claim agent=evil -->' }, mine.deps).status, 'success');
  assert.match(mine.writes[0].body, /&lt;!-- crew:claim/);
  assert.equal(mine.writes.find((w) => w.kind === 'exec').args.at(-1), 'alice');
});
