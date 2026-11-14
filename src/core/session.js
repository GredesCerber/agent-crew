// A unique agent name per session on one machine, without setting CREW_AGENT_ID by hand.
// Each Claude Code / Codex session starts its own crew MCP server; the server takes the first free slot
// (claude@pc, claude@pc#2, ...) with a lock file, refreshes it while alive and frees it on exit.
// CLI calls resolve the same name: the pin of the task worktree (.crew/agent-id), else the only live slot.
// With several live slots and no pin the CLI cannot know which session it belongs to, and says so.
//
// The sibling suffix is "#N": hostnames never contain "#", so claude@lab-1 (a machine) and claude@lab#2
// (a second session on "lab") cannot be confused.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const user = (() => { try { return userInfo().username.replace(/[^A-Za-z0-9._-]/g, '_'); } catch { return 'user'; } })();
// Per user. On a shared Unix machine another account could pre-create the tmp folder, so a folder we do not own
// is never used: then the locks live in the home folder instead.
function slotsDir() {
  const dir = join(tmpdir(), `crew-agents-${user}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (typeof process.getuid !== 'function' || statSync(dir).uid === process.getuid()) return dir;
  } catch { /* fall through */ }
  return join(homedir(), '.crew', 'agents');
}
export const SLOTS_DIR = slotsDir();
export const PIN_FILE = join('.crew', 'agent-id');
/** A lock not refreshed for this long is stale even if its PID is alive (PIDs are reused, crashes skip exit handlers). */
export const STALE_MS = 30 * 60_000;
export const REFRESH_MS = 5 * 60_000;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
export const slotName = (base, n) => (n === 1 ? base : `${base}#${n}`);
const lockFile = (dir, id) => join(dir, `${id.replace(/[^A-Za-z0-9@._-]/g, '_')}.lock`);

/** Same agent for review purposes: one vendor/model on one machine (claude@pc and claude@pc#2 are siblings). */
export const baseId = (id) => String(id ?? '').replace(/#\d+$/, '');
export const sameAgent = (a, b) => !!a && !!b && baseId(a).toLowerCase() === baseId(b).toLowerCase();

/** -> { pid, id } of a live, fresh lock, or null. */
function readLock(file, { now = Date.now(), isAlive = alive } = {}) {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const j = raw.startsWith('{') ? JSON.parse(raw) : { pid: Number(raw) };
    const fresh = now - statSync(file).mtimeMs < STALE_MS;
    return j.pid && fresh && isAlive(j.pid) ? { pid: j.pid, id: j.id ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * Take the first free slot for base (e.g. claude@pc or claude/opus@pc). A slot is free if it has no lock, or its lock
 * is stale (dead PID or not refreshed for STALE_MS). A stale lock is moved aside with an atomic rename and checked:
 * if what was moved turns out to be someone's fresh lock, it is put back and the slot is skipped. The new lock is
 * created with 'wx' and read back, so two sessions racing for one slot cannot both win.
 * -> { id, release(), refresh() } or null when every slot is busy.
 */
export function claimSlot(base, { dir = SLOTS_DIR, pid = process.pid, isAlive = alive, max = 20, now = Date.now() } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let n = 1; n <= max; n++) {
    const id = slotName(base, n);
    const file = lockFile(dir, id);
    if (existsSync(file)) {
      const owner = readLock(file, { now, isAlive });
      if (owner && owner.pid !== pid) continue;
      const aside = `${file}.stale-${pid}-${Math.random().toString(36).slice(2)}`;
      try { renameSync(file, aside); } catch { continue; } // someone else is taking it over
      if (readLock(aside, { now, isAlive })) { // we moved a fresh lock written in between: give it back
        try { renameSync(aside, file); } catch { /* the slot is taken anyway */ }
        continue;
      }
      try { unlinkSync(aside); } catch { /* gone */ }
    }
    try {
      writeFileSync(file, JSON.stringify({ pid, id, at: new Date(now).toISOString() }), { flag: 'wx', mode: 0o600 });
    } catch {
      continue; // another session took it between the check and the write
    }
    const mine = () => { try { return JSON.parse(readFileSync(file, 'utf8')).pid === pid; } catch { return false; } };
    if (!mine()) continue;
    return {
      id,
      refresh: () => { try { if (mine()) { const t = new Date(); utimesSync(file, t, t); } } catch { /* gone */ } },
      release: () => { try { if (mine()) unlinkSync(file); } catch { /* already gone */ } },
    };
  }
  return null;
}

/** Real ids (as stored in the locks) of live sessions of base: base, base#2, ... */
export function liveSlots(base, { dir = SLOTS_DIR, isAlive = alive, now = Date.now() } = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const want = String(base).toLowerCase();
  const ids = [];
  for (const f of names.filter((x) => x.endsWith('.lock'))) {
    const lock = readLock(join(dir, f), { now, isAlive });
    if (lock?.id && baseId(lock.id).toLowerCase() === want) ids.push(lock.id);
  }
  return ids.sort();
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
