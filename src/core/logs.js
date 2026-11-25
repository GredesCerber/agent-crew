// Old logs in .crew/logs (crew check, crew worker) go away by themselves: the newest ones are kept, older ones only
// while they are recent. Pure file housekeeping; never throws.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_LOGS = 50;
export const KEEP_DAYS = 14;

/** Remove logs beyond the newest `keep` that are also older than `days`. → the file names removed. */
export function pruneLogs(dir, { keep = KEEP_LOGS, days = KEEP_DAYS, now = Date.now() } = {}) {
  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => /\.(txt|log|jsonl?)$/.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch {
    return [];
  }
  const removed = [];
  for (const { f, t } of files.slice(keep)) {
    if (now - t < days * 86_400_000) continue;
    try { unlinkSync(join(dir, f)); removed.push(f); } catch { /* in use: next time */ }
  }
  return removed;
}
