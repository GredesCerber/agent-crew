// Command registry. One command = one module in src/commands/ with fields:
//   name     'task next'                - how to call it from the CLI
//   summary  one line                   - for help and the MCP description
//   args     [{ name, type, positional?, required?, description }]
//   run(opts, ctx) -> result from core/output.js
//   usesCwd  true                       - the command works with a working copy; takes an optional
//                                          cwd argument (absolute path, e.g. the task's worktree).
//                                          The MCP server runs in the project root, so without cwd
//                                          the tools would see main, not the task branch.
// The CLI (bin/crew.js) and the MCP server (src/mcp/server.js) are built from this list,
// so a new command is automatically available to both humans and agents.

import task from '../commands/task.js';
import check from '../commands/check.js';
import pr from '../commands/pr.js';
import status from '../commands/status.js';
import commit from '../commands/commit.js';
import init from '../commands/init.js';
import adapters from '../commands/adapters.js';
import labels from '../commands/labels.js';
import compliance from '../commands/compliance.js';
import doctor from '../commands/doctor.js';
import worker from '../commands/worker.js';
import github from '../commands/github.js';
import metrics from '../commands/metrics.js';
import evalCmd from '../commands/eval.js';
import kickoff from '../commands/kickoff.js';
import guard from '../commands/guard.js';
import up from '../commands/up.js';
import shots from '../commands/shots.js';
import board from '../commands/board.js';
import upgrade from '../commands/upgrade.js';
import askCmds from '../commands/ask.js';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { metricsRoot } from './metrics.js';

/** Shared argument for commands with usesCwd: true. */
export const CWD_ARG = {
  name: 'cwd',
  type: 'string',
  description: 'absolute path of the working copy (the task worktree from crew_task_claim -> artifacts.worktree); defaults to the current folder',
};

/** Command arguments including the shared ones (cwd). */
export const argsOf = (cmd) => [...(cmd.args ?? []), ...(cmd.usesCwd && !(cmd.args ?? []).some((a) => a.name === 'cwd') ? [CWD_ARG] : [])];

export const commands = [...task, ...kickoff, check, ...pr, guard, status, commit, init, up, adapters, labels, ...compliance, doctor, worker, github, metrics, evalCmd, shots, board, upgrade, ...askCmds];

/** For MCP: only commands safe for agents (no init/labels/adapters; a human does those). */
export const agentCommands = commands.filter((c) => c.agent !== false);

export function findCommand(words) {
  // longest name match: "task claim 42" -> 'task claim'
  let best = null;
  for (const c of commands) {
    const parts = c.name.split(' ');
    if (parts.every((p, i) => words[i] === p) && (!best || parts.length > best.name.split(' ').length)) best = c;
  }
  return best;
}

export function toolName(cmd) {
  return 'crew_' + cmd.name.replace(/[\s-]+/g, '_');
}

export function inputSchema(cmd) {
  const properties = {};
  const required = [];
  for (const a of argsOf(cmd)) {
    properties[a.name] = { type: a.type === 'number' ? 'number' : a.type === 'boolean' ? 'boolean' : 'string', description: a.description };
    if (a.enum) properties[a.name].enum = a.enum;
    if (a.required) required.push(a.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/** argv words -> options object per the args spec. */
export function parseArgs(cmd, rest) {
  const opts = {};
  const specs = argsOf(cmd);
  const positionals = specs.filter((a) => a.positional);
  let pi = 0;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    const isShort = /^-[a-zA-Z]$/.test(w); // -m "msg", as in git
    if (w.startsWith('--') || isShort) {
      const [k, v] = w.slice(isShort ? 1 : 2).split('=');
      const spec = specs.find((a) => a.name === k.replace(/-/g, '_'));
      const key = spec?.name ?? k.replace(/-/g, '_');
      if (spec?.type === 'boolean' || (v === undefined && (rest[i + 1] === undefined || rest[i + 1].startsWith('--')))) {
        opts[key] = v === undefined ? true : v !== 'false';
      } else {
        opts[key] = v ?? rest[++i];
      }
    } else if (pi < positionals.length) {
      opts[positionals[pi++].name] = w;
    }
  }
  for (const a of specs) {
    if (a.type === 'number' && opts[a.name] !== undefined) opts[a.name] = Number(opts[a.name]);
  }
  return opts;
}

/**
 * cwd may only point inside the crew project and only the same repository crew runs in
 * (the main copy or its worktree). Otherwise an agent could commit/push to another repo on the machine.
 * home is the project root where crew/the MCP server runs (default process.cwd()).
 */
export function cwdScopeError(cwd, home = process.cwd()) {
  const target = loadConfig(cwd);
  if (!target.path) return `cwd is not a crew project (no crew.config.json up the folder tree): ${cwd}`;
  const here = loadConfig(home);
  if (!here.path) return null; // crew runs outside a project: it is enough that cwd itself is a crew project
  const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  const norm = (p) => {
    const s = real(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  if (norm(metricsRoot(target.root)) !== norm(metricsRoot(here.root))) {
    return `cwd is outside the current project: ${cwd} (only ${here.root} and its worktrees are allowed)`;
  }
  return null;
}

export function validate(cmd, opts) {
  if (cmd.usesCwd && opts.cwd !== undefined) {
    if (typeof opts.cwd !== 'string' || !isAbsolute(opts.cwd)) return 'cwd must be an absolute path';
    if (!existsSync(opts.cwd)) return `cwd does not exist: ${opts.cwd}`;
    const scope = cwdScopeError(opts.cwd);
    if (scope) return scope;
  }
  for (const a of argsOf(cmd)) {
    if (a.required && (opts[a.name] === undefined || opts[a.name] === '')) return `missing argument: ${a.name}`;
    if (a.type === 'number' && opts[a.name] !== undefined && !Number.isFinite(opts[a.name])) return `${a.name} must be a number`;
    if (a.enum && opts[a.name] !== undefined && !a.enum.includes(opts[a.name])) return `${a.name}: one of ${a.enum.join(', ')}`;
  }
  return null;
}
