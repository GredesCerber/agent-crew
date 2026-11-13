// Run external commands with a timeout that kills the WHOLE process tree.
// spawnSync with timeout only kills the direct child (cmd.exe / sh), while grandchildren (npm test, dev server,
// claude under cmd /c) keep the pipes open: spawnSync hangs and the processes stay alive.
// So the synchronous call goes through supervisor.js: it launches the command itself, kills the
// tree on timeout and exits, so the pipes to us are guaranteed to close.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUPERVISOR = fileURLToPath(new URL('./supervisor.js', import.meta.url));
const MAX_BUFFER = 64 * 1024 * 1024;

/** Kill a process along with its children. On POSIX the process must be started with detached: true (own group). */
export function killTree(child, { graceMs = 10_000 } = {}) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already exited */ } }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
  }, graceMs);
}

/**
 * Run a command synchronously with a timeout covering the whole process tree.
 * @param {{cmd: string, args?: string[], shell?: boolean, cwd?: string, env?: object, input?: string, timeoutMs?: number}} spec
 * @returns {{code: number, stdout: string, stderr: string, timedOut: boolean, error: string|null}}
 */
export function runSupervised({ cmd, args = [], shell = false, cwd, env, input, timeoutMs }) {
  const job = JSON.stringify({ cmd, args, shell, cwd, input: input ?? null, timeoutMs: timeoutMs ?? null });
  const r = spawnSync(process.execPath, [SUPERVISOR], {
    input: job,
    env: env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_BUFFER * 2 + 1024 * 1024,
    // safety net in case the supervisor itself hangs
    timeout: timeoutMs ? timeoutMs + 30_000 : undefined,
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return {
      code: r.status ?? -1,
      stdout: '',
      stderr: r.stderr ?? '',
      timedOut: r.error?.code === 'ETIMEDOUT',
      error: r.error ? r.error.code ?? r.error.message : 'supervisor: no result',
    };
  }
}
