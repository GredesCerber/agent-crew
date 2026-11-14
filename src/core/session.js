// A unique agent name per session on one machine, without setting CREW_AGENT_ID by hand.
// Each Claude Code / Codex session starts its own crew MCP server; the server takes the first free slot
// (claude@pc, claude@pc-2, ...) with a lock file holding its PID, and frees it on exit.
// crew task claim pins the name into the task worktree (.crew/agent-id), so CLI calls there use it too.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const SLOTS_DIR = join(tmpdir(), 'crew-agents');
export const PIN_FILE = join('.crew', 'agent-id');

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const slotName = (base, n) => (n === 1 ? base : `${base}-${n}`);

/**
 * Take the first free slot for base (e.g. claude@pc). A slot is free if it has no lock file or its PID is dead.
 * → { id, release() } or null when every slot is busy. fs and isAlive are injectable for tests.
 */
export function claimSlot(base, { dir = SLOTS_DIR, pid = process.pid, isAlive = alive, max = 20 } = {}) {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= max; n++) {
    const id = slotName(base, n);
    const file = join(dir, `${id.replace(/[^A-Za-z0-9@._-]/g, '_')}.lock`);
    if (existsSync(file)) {
      const owner = Number(readFileSync(file, 'utf8').trim());
      if (owner && owner !== pid && isAlive(owner)) continue;
    }
    try {
      writeFileSync(file, String(pid), { flag: existsSync(file) ? 'w' : 'wx' });
    } catch {
      continue; // another session took it between the check and the write
    }
    return {
      id,
      release: () => {
        try { if (Number(readFileSync(file, 'utf8').trim()) === pid) unlinkSync(file); } catch { /* already gone */ }
      },
    };
  }
  return null;
}

/** The name pinned in this worktree (nearest .crew/agent-id walking up from cwd), or null. */
export function pinnedId(cwd = process.cwd()) {
  let dir = resolve(cwd);
  for (let i = 0; i < 30; i++) {
    const f = join(dir, PIN_FILE);
    if (existsSync(f)) return readFileSync(f, 'utf8').trim() || null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

export function pinId(worktree, id) {
  mkdirSync(join(worktree, '.crew'), { recursive: true });
  writeFileSync(join(worktree, PIN_FILE), `${id}\n`);
}
