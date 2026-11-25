// A unique agent name per session on one machine, without setting CREW_AGENT_ID by hand.
// Each Claude Code / Codex session starts its own crew MCP server; the server takes the first free slot
// (claude@pc, claude@pc#2, ...) with a lock file, refreshes it while alive and frees it on exit.
// CLI calls resolve the same name: the pin of the task worktree (.crew/agent-id), else the only live slot.
// With several live slots and no pin the CLI cannot know which session it belongs to, and says so.
//
// The sibling suffix is "#N": hostnames never contain "#", so claude@lab-1 (a machine) and claude@lab#2
// (a second session on "lab") cannot be confused.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

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

/** origin's URL as host/owner/name, so https and ssh clones of one repo match. */
const normUrl = (u) => String(u).trim().replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):(?!\d)/, '$1/').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();

/**
 * Which repository a folder belongs to: origin's URL, or the shared .git folder when there is no origin. A task
 * worktree and the main folder of one repo give the same key; two unrelated repos never do. → 12 hex, or 'no-repo'.
 */
export function repoKey(cwd = process.cwd()) {
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const g = join(dir, '.git');
    if (existsSync(g)) {
      let common = g;
      try {
        if (statSync(g).isFile()) {
          const gitdir = resolve(dir, /gitdir:\s*(.+)/.exec(readFileSync(g, 'utf8'))?.[1]?.trim() ?? '.git');
          const cd = join(gitdir, 'commondir');
          common = existsSync(cd) ? resolve(gitdir, readFileSync(cd, 'utf8').trim()) : gitdir;
        }
      } catch { /* an unreadable .git file: key by the folder */ }
      let url = null;
      try { url = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(readFileSync(join(common, 'config'), 'utf8'))?.[1] ?? null; } catch { /* no config */ }
      const id = url ? normUrl(url) : resolve(common).toLowerCase();
      return createHash('sha1').update(id).digest('hex').slice(0, 12);
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return 'no-repo';
}

/**
 * Slot locks of one repository: sessions of the same agent in two unrelated repos are not siblings (each gets
 * claude@pc there), while the sessions inside one repo still share names and see each other.
 */
export const repoSlotsDir = (cwd = process.cwd()) => join(SLOTS_DIR, repoKey(cwd));
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
 * is stale (dead PID or not refreshed for STALE_MS). Only one session at a time may remove a stale lock: it holds
 * an exclusive "<lock>.takeover" folder (mkdir is atomic) and checks the lock again inside it, so a fresh lock
 * written meanwhile is never removed. The new lock is created with 'wx' and read back, so two sessions racing for
 * one slot cannot both win.
 * -> { id, release(), refresh() } or null when every slot is busy.
 */
export function claimSlot(base, { dir = repoSlotsDir(), pid = process.pid, isAlive = alive, max = 20, now = Date.now() } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let n = 1; n <= max; n++) {
    const id = slotName(base, n);
    const file = lockFile(dir, id);
    if (existsSync(file)) {
      const owner = readLock(file, { now, isAlive });
      if (owner && owner.pid !== pid) continue;
      const guard = `${file}.takeover`;
      try {
        mkdirSync(guard);
      } catch {
        // another session is taking this slot over; a guard left by a crashed takeover expires after 10 s
        try { if (Date.now() - statSync(guard).mtimeMs > 10_000) rmdirSync(guard); } catch { /* gone */ }
        continue;
      }
      try {
        const again = readLock(file, { now: Date.now(), isAlive });
        if (again && again.pid !== pid) continue; // someone wrote a fresh lock before we got the guard
        try { unlinkSync(file); } catch { /* already gone */ }
      } finally {
        try { rmdirSync(guard); } catch { /* gone */ }
      }
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
export function liveSlots(base, { dir = repoSlotsDir(), isAlive = alive, now = Date.now() } = {}) {
  const want = base == null ? null : String(base).toLowerCase();
  return allLiveSlots({ dir, isAlive, now }).filter((id) => want === null || baseId(id).toLowerCase() === want);
}

/** Every live session of this repository on this machine (crew doctor lists them). */
export function allLiveSlots({ dir = repoSlotsDir(), isAlive = alive, now = Date.now() } = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const ids = [];
  for (const f of names.filter((x) => x.endsWith('.lock'))) {
    const lock = readLock(join(dir, f), { now, isAlive });
    if (lock?.id) ids.push(lock.id);
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
