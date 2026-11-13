import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import codex from '../adapters/codex/adapter.js';
import { spawnAgent } from '../src/commands/worker.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'crew-codex-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, 'npm & тест %PATH% ^');
  mkdirSync(prefix);
  return { root, prefix };
}

test('Codex on Windows launches the native executable without cmd', (t) => {
  const { prefix } = fixture(t);
  const binary = join(prefix, 'codex.exe');
  writeFileSync(binary, 'fixture');
  const spec = codex.headless({ prompt: 'P', platform: 'win32', searchPath: prefix });
  assert.equal(spec.cmd, binary);
  assert.equal(spec.args[0], 'exec');
});

test('Codex npm entrypoint receives literal arguments and stdin, never executes the cmd shim', async (t) => {
  const { root, prefix } = fixture(t);
  const bin = join(prefix, 'node_modules', '@openai', 'codex', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(prefix, 'codex.cmd'), '@echo CMD_SHIM_MUST_NOT_RUN\r\nexit /b 91\r\n');
  writeFileSync(join(bin, 'codex.js'), 'let input="";process.stdin.on("data",d=>input+=d);process.stdin.on("end",()=>console.log(JSON.stringify({args:process.argv.slice(2),input})));');
  const prompt = 'текст\n" & echo INJECTED | %PATH% ^';
  const cwd = join(root, 'project&echo.INJECTED&rem');
  const writable = join(root, 'общий git & %PATH% ^');
  mkdirSync(cwd);
  const model = 'model"&echo.INJECTED&rem';
  const spec = codex.headless({ prompt, model, cwd, writableDirs: [writable], platform: 'win32', searchPath: prefix });
  assert.equal(spec.cmd, process.execPath);
  assert.equal(spec.args[0], join(bin, 'codex.js'));
  const log = join(root, 'launch.log');
  const result = await spawnAgent(spec, { cwd, env: spec.env, timeoutMs: 10000, logFile: log });
  assert.equal(result.code, 0);
  const output = JSON.parse(readFileSync(log, 'utf8'));
  assert.equal(output.input, prompt);
  assert.deepEqual(output.args, ['exec', '--json', '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-C', cwd, '--add-dir', writable, '--model', model, '-']);
});

test('An unsupported cmd shim is never used as a fallback', (t) => {
  const { prefix } = fixture(t);
  writeFileSync(join(prefix, 'codex.cmd'), '@echo NEVER_RUN\r\n');
  const spec = codex.headless({ prompt: 'P', platform: 'win32', searchPath: prefix });
  assert.equal(spec.cmd, 'codex.exe');
  assert.equal(spec.args[0], 'exec');
});
