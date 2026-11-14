// Unique agent names per session (src/core/session.js): slots with PID locks, the name pinned in a worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimSlot, pinId, pinnedId } from '../src/core/session.js';

test('slots: first session gets the plain name, the next ones #2, #3; a dead session frees its slot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-slots-'));
  const live = new Set([101, 102]);
  const isAlive = (pid) => live.has(pid);
  const a = claimSlot('claude@pc', { dir, pid: 101, isAlive });
  const b = claimSlot('claude@pc', { dir, pid: 102, isAlive });
  assert.equal(a.id, 'claude@pc');
  assert.equal(b.id, 'claude@pc#2');
  live.delete(101); // session 1 crashed without cleanup
  const c = claimSlot('claude@pc', { dir, pid: 103, isAlive: (p) => p === 102 || p === 103 });
  assert.equal(c.id, 'claude@pc', 'stale lock is reused');
  b.release();
  const d = claimSlot('claude@pc', { dir, pid: 104, isAlive: (p) => p === 103 || p === 104 });
  assert.equal(d.id, 'claude@pc#2', 'released slot is free again');
  assert.equal(claimSlot('codex@pc', { dir, pid: 105, isAlive: () => true }).id, 'codex@pc', 'vendors have separate slots');
});

test('the name pinned in a worktree is found from any subfolder', () => {
  const wt = mkdtempSync(join(tmpdir(), 'crew-wt-'));
  pinId(wt, 'claude@pc#2');
  mkdirSync(join(wt, 'web', 'src'), { recursive: true });
  assert.equal(pinnedId(join(wt, 'web', 'src')), 'claude@pc#2');
  const other = mkdtempSync(join(tmpdir(), 'crew-none-'));
  writeFileSync(join(other, 'x'), '');
  assert.equal(pinnedId(other), null);
});
