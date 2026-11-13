// Supervisor process for runSupervised (proc.js). Do not import: it is launched as a separate node process.
// stdin: JSON { cmd, args, shell, cwd, input, timeoutMs } -> stdout: JSON { code, stdout, stderr, timedOut, error }.
// On timeout it kills the command's whole process tree and exits without waiting for grandchildren to close the pipes.
import { spawn } from 'node:child_process';
import { killTree } from './proc.js';

const CAP = 64 * 1024 * 1024;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  const job = JSON.parse(raw);
  const out = { stdout: '', stderr: '' };
  let timedOut = false;
  let done = false;

  const finish = (code, error = null) => {
    if (done) return;
    done = true;
    process.stdout.write(JSON.stringify({ code, stdout: out.stdout, stderr: out.stderr, timedOut, error }));
    process.exit(0);
  };

  let child;
  try {
    child = spawn(job.cmd, job.args ?? [], {
      cwd: job.cwd ?? undefined,
      shell: !!job.shell,
      stdio: [job.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group, so kill(-pid) kills everyone
    });
  } catch (e) {
    return finish(-1, e.code ?? e.message);
  }
  for (const k of ['stdout', 'stderr']) {
    child[k].setEncoding('utf8');
    child[k].on('data', (d) => { if (out[k].length < CAP) out[k] += d; });
  }
  if (job.input != null) {
    child.stdin.on('error', () => {}); // the process may have exited without reading stdin
    child.stdin.end(job.input);
  }
  child.on('error', (e) => finish(-1, e.code ?? e.message));
  child.on('close', (code) => finish(code ?? -1));

  if (job.timeoutMs) {
    setTimeout(() => {
      timedOut = true;
      killTree(child, { graceMs: 2_000 });
      // Do not wait for close: surviving grandchildren could hold the pipes. Give SIGKILL 3 s and exit.
      setTimeout(() => finish(-1), 3_000);
    }, job.timeoutMs);
  }
});
