#!/usr/bin/env node
// crew: control panel for an agent team. See README.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commands, findCommand, parseArgs, validate } from '../src/core/registry.js';
import { CrewError, fail, render } from '../src/core/output.js';
import { HARNESS_ROOT } from '../src/core/config.js';
import { recordCommand } from '../src/core/metrics.js';

const argv = process.argv.slice(2);
const json = argv.includes('--json') || process.env.CREW_JSON === '1' || !process.stdout.isTTY;
const words = argv.filter((a) => a !== '--json');

function help() {
  const width = Math.max(...commands.map((c) => c.name.length));
  return [
    'crew: control panel for an agent team (Claude Code, Codex, ...)',
    '',
    'Commands:',
    ...commands.map((c) => `  crew ${c.name.padEnd(width)}  ${c.summary}`),
    `  crew ${'mcp'.padEnd(width)}  Start the MCP server (for agents)`,
    '',
    'Flags: --json (machine output; enabled automatically when output is not a terminal)',
    'Environment: CREW_AGENT=claude/opus: who is working (recorded in commits and tasks)',
  ].join('\n');
}

async function main() {
  if (!words.length || ['help', '--help', '-h'].includes(words[0])) return console.log(help());
  if (['--version', '-v', 'version'].includes(words[0])) {
    return console.log(JSON.parse(readFileSync(join(HARNESS_ROOT, 'package.json'), 'utf8')).version);
  }
  if (words[0] === 'mcp') {
    const { startServer } = await import('../src/mcp/server.js');
    return startServer();
  }
  const cmd = findCommand(words);
  if (!cmd) {
    console.log(render(fail('unknown_command', `Unknown command: ${words.join(' ')}`, { retry: 'crew help' }), { json }));
    process.exitCode = 2;
    return;
  }
  const opts = parseArgs(cmd, words.slice(cmd.name.split(' ').length));
  const err = validate(cmd, opts);
  const started = Date.now();
  let result;
  if (err) result = fail('bad_input', err, { retry: 'crew help' });
  else {
    try {
      result = await cmd.run(opts, {});
    } catch (e) {
      result = e instanceof CrewError ? e.toResult() : fail('internal', e.message, { stop_when: 'it repeats: report to a human' });
    }
  }
  recordCommand({ command: cmd.name, opts, result, started }); // .crew/metrics.jsonl; never throws
  console.log(render(result, { json }));
  if (result.status === 'error') process.exitCode = 1;
}

main();
