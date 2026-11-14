// A unique agent name per session on one machine, without setting CREW_AGENT_ID by hand.
// Each Claude Code / Codex session starts its own crew MCP server; the server takes the first free slot
// (claude@pc, claude@pc-2, ...) with a lock file, refreshes it while alive and frees it on exit.
// CLI calls resolve the same name: the pin of the task worktree (.crew/agent-id), else the only live slot.
// With several live slots and no pin the CLI cannot know which session it belongs to, and says so.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const user = (() => { try { return userInfo().username.replace(/[^A-Za-z0-9._-]/g, '_'); } catch { return 'user'; } })();
// Per user: other accounts on a shared machine can neither read nor plant locks here.
export const SLOTS_DIR = join(tmpdir(), `crew-agents-${user}`);
export const PIN_FILE = join('.crew', 'agent-id');
/** A lock not refreshed for this long is stale even if its PID is alive (PIDs are reused, crashes skip exit handlers). */
export const STALE_MS = 30 * 60_000;
export const REFRESH_MS = 5 * 60_000;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const slotName = (base, n) => (n === 1 ? base : `${base}-${n}`);
const lockFile = (dir, id) => join(dir, `${id.replace(/[^A-Za-z0-9@._-]/g, '_')}.lock`);

/** Same agent for review purposes: one vendor on one machine (claude@pc and claude@pc-2 are siblings). */
export const baseId = (id) => String(id ?? '').replace(/-\d+$/, '');
export const sameAgent = (a, b) => !!a && !!b && baseId(a).toLowerCase() === baseId(b).toLowerCase();

function lockOwner(file, { now = Date.now(), isAlive = alive } = {}) {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const pid = Number(raw.startsWith('{') ? JSON.parse(raw).pid : raw);
    const fresh = now - statSync(file).mtimeMs < STALE_MS;
    return pid && fresh && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Take the first free slot for base (e.g. claude@pc). A slot is free if it has no lock, or its lock is stale
 * (dead PID or not refreshed for STALE_MS). Stale locks are removed and recreated with 'wx', so two sessions
 * racing for one slot cannot both win. -> { id, release(), refresh() } or null when every slot is busy.
 */
export function claimSlot(base, { dir = SLOTS_DIR, pid = process.pid, isAlive = alive, max = 20, now = Date.now() } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let n = 1; n <= max; n++) {
    const id = slotName(base, n);
    const file = lockFile(dir, id);
    if (existsSync(file)) {
      const owner = lockOwner(file, { now, isAlive });
      if (owner && owner !== pid) continue;
      try { unlinkSync(file); } catch { /* someone else removed it first */ }
    }
    try {
      writeFileSync(file, JSON.stringify({ pid, at: new Date(now).toISOString() }), { flag: 'wx', mode: 0o600 });
    } catch {
      continue; // another session took it between the check and the write
    }
    const mine = () => { try { return JSON.parse(readFileSync(file, 'utf8')).pid === pid; } catch { return false; } };
    return {
      id,
      refresh: () => { try { if (mine()) { const t = new Date(); utimesSync(file, t, t); } } catch { /* gone */ } },
      release: () => { try { if (mine()) unlinkSync(file); } catch { /* already gone */ } },
    };
  }
  return null;
}

/** Ids of live slots for base (base, base-2, ...). */
export function liveSlots(base, { dir = SLOTS_DIR, isAlive = alive, now = Date.now() } = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const want = lockFile(dir, base).split(/[\\/]/).pop().replace(/\.lock$/, '');
  return names
    .filter((f) => f.endsWith('.lock'))
    .map((f) => f.slice(0, -5))
    .filter((id) => id === want || new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(id))
    .filter((id) => lockOwner(join(dir, `${id}.lock`), { now, isAlive }))
    .sort();
}

/**
 * Who is this CLI call? -> { id } or { ambiguous: [ids] }. One live session: its slot. None: base.
 * Several and no pin: unknown, because guessing would let one session act (claim, review) as another.
 */
export function cliIdentity(base, opts = {}) {
  const live = liveSlots(base, opts);
  if (live.length <= 1) return { id: live[0] ?? base };
  return { ambiguous: live };
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
