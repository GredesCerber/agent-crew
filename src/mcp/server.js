// Minimal MCP server (stdio, JSON-RPC 2.0, one message per line).
// Exposes crew commands as tools: crew_task_next, crew_task_claim, crew_check, ...
// Connects to any MCP client: Claude Code, Codex, Cursor, etc. No dependencies.
import { claimSlot, repoSlotsDir, REFRESH_MS } from '../core/session.js';
import { baseAgentId, loadConfig } from '../core/config.js';
import { LOCAL_VERSION } from '../core/version.js';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentCommands, toolName, inputSchema, validate } from '../core/registry.js';
import { CrewError, fail } from '../core/output.js';
import { recordCommand } from '../core/metrics.js';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

export async function callTool(name, args = {}) {
  const cmd = agentCommands.find((c) => toolName(c) === name);
  if (!cmd) return fail('unknown_tool', `No such tool: ${name}`, { retry: 'tools/list' });
  const started = Date.now();
  const err = validate(cmd, args);
  let result;
  if (err) result = fail('bad_input', err, { retry: `fix the arguments of ${name}` });
  else {
    try {
      result = await cmd.run(args, {});
    } catch (e) {
      result = e instanceof CrewError ? e.toResult() : fail('internal', e.message, { stop_when: 'it repeats: report to a human' });
    }
  }
  // Agents work mostly through MCP; without this crew metrics does not see them. Never throws.
  recordCommand({ command: cmd.name, opts: args, result, started });
  return result;
}

export async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const v = SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      return { protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'crew', version: LOCAL_VERSION } };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: agentCommands.map((c) => ({ name: toolName(c), description: c.summary, inputSchema: inputSchema(c) })),
      };
    case 'tools/call': {
      const result = await callTool(params?.name, params?.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result.status === 'error' };
    }
    default:
      if (id === undefined) return undefined; // notification (notifications/initialized etc.)
      throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
  }
}

const ROOTS_ID = 'crew-roots';

/** The crew project inside one of the client's roots (file:// URIs): the folder whose crew.config.json is found. */
export function projectFromRoots(list = []) {
  for (const r of list) {
    // a bad URI or a broken crew.config.json in one root (or a folder above it) skips that root, never the server
    try {
      const found = loadConfig(fileURLToPath(String(r.uri ?? '')));
      if (found.path) return found.root;
    } catch { /* next root */ }
  }
  return null;
}

/**
 * Asks the client for its roots after initialization and changes into the crew project there. → { onMessage(msg):
 * true when the message was the answer to our request, ready(): waits (at most 3 s) for that answer }.
 */
export function projectRoots({ send, fixed = false, chdir = (d) => process.chdir(d), timeoutMs = 3000 }) {
  let supported = false;
  let settle;
  let pending = null;
  const ask = () => {
    pending = new Promise((resolve) => { settle = resolve; setTimeout(resolve, timeoutMs).unref?.(); });
    send({ jsonrpc: '2.0', id: ROOTS_ID, method: 'roots/list' });
  };
  return {
    onMessage(msg) {
      if (msg.method === 'initialize') supported = !!msg.params?.capabilities?.roots && !fixed;
      if (supported && (msg.method === 'notifications/initialized' || msg.method === 'notifications/roots/list_changed')) ask();
      if (msg.id === ROOTS_ID && !msg.method) {
        try {
          const dirPath = projectFromRoots(msg.result?.roots ?? []);
          if (dirPath) chdir(dirPath);
        } finally {
          settle?.();
        }
        return true;
      }
      return false;
    },
    ready: () => pending ?? Promise.resolve(),
  };
}

export function startServer() {
  // A host that starts MCP servers outside the project (a global config, a plugin folder) says where the project is:
  // every crew command looks for crew.config.json from the working directory.
  const dir = process.env.CREW_PROJECT_DIR;
  if (dir && existsSync(dir)) process.chdir(dir);
  else if (dir) process.stderr.write(`crew mcp: CREW_PROJECT_DIR ${dir} does not exist (moved?): working in ${process.cwd()}; run crew adapters build in the project again\n`);
  // One MCP server per agent session: take a free name slot (claude@pc, claude@pc#2, ...) in this repository's lock
  // folder, unless CREW_AGENT_ID is set. If the server moves to another project (MCP roots), the slot moves too.
  let slot = null;
  let slotDir = null;
  const fixedId = !!process.env.CREW_AGENT_ID;
  const takeSlot = () => {
    if (fixedId) return;
    const dirNow = repoSlotsDir(process.cwd());
    if (slot && dirNow === slotDir) return;
    slot?.release();
    delete process.env.CREW_AGENT_ID;
    slot = claimSlot(baseAgentId(), { dir: dirNow }); // the raw base: never a live sibling's name (claude@pc#2#2)
    slotDir = dirNow;
    if (slot) process.env.CREW_AGENT_ID = slot.id;
  };
  takeSlot();
  if (!fixedId) {
    setInterval(() => slot?.refresh(), REFRESH_MS).unref(); // a live session keeps its lock fresh; a crashed one goes stale
    for (const ev of ['exit', 'SIGINT', 'SIGTERM']) process.once(ev, () => { slot?.release(); if (ev !== 'exit') process.exit(0); });
  }
  const rl = createInterface({ input: process.stdin });
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  // MCP roots: a client started from a global config (Antigravity, an editor) tells which folders are open; the crew
  // project among them becomes the working directory. CREW_PROJECT_DIR, when set, wins.
  // a server already started inside a crew project stays there; roots only help one started somewhere else
  let inProject = false;
  try { inProject = !!loadConfig(process.cwd()).path; } catch { inProject = true; /* a broken config here: leave it to the tools to report */ }
  const roots = projectRoots({ send, fixed: !!(dir && existsSync(dir)) || inProject, chdir: (d) => { process.chdir(d); takeSlot(); } });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    try {
      if (roots.onMessage(msg)) return;
    } catch { /* roots are a convenience: an error there must not cost the agent its tools */ }
    if (msg.method === 'tools/call') await roots.ready();
    try {
      const result = await handle(msg);
      if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: e.rpcCode ?? -32603, message: e.message } });
    }
  });
}
