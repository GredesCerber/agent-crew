// Working without GitHub Actions (crew tick, the Actions health check) and inside Claude Code cloud sessions
// (agent name, the GraphQL block). No network: gh is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import tick, { actionsHealth, tickOnce } from '../src/commands/tick.js';
import { machineName, baseAgentId } from '../src/core/config.js';
import { graphqlBlocked, cloudSession } from '../src/core/exec.js';
import { findCommand, agentCommands } from '../src/core/registry.js';

/** gh stub: answers by the first arguments. */
const ghFrom = (table) => (args) => {
  const key = args.slice(0, 2).join(' ');
  if (key === 'run list') return table.runs;
  if (key === 'run view') return table.jobs ? { jobs: table.jobs } : null;
  if (args[0] === 'api') return table.annotations ?? null;
  return null;
};

test('Actions health: blocked when jobs that should run never start, with GitHub\'s own reason', () => {
  const runs = [
    { databaseId: 3, conclusion: 'failure', status: 'completed' },
    { databaseId: 2, conclusion: 'skipped', status: 'completed' },
    { databaseId: 1, conclusion: 'failure', status: 'completed' },
  ];
  const jobs = [
    { databaseId: 11, name: 'sweep', conclusion: 'failure', steps: [] },
    { databaseId: 12, name: 'check', conclusion: 'skipped', steps: [] },
  ];
  const blocked = actionsHealth({ j: ghFrom({ runs, jobs, annotations: [{ message: 'The job was not started because your account is locked due to a billing issue.' }] }) });
  assert.deepEqual(blocked, { state: 'blocked', reason: 'The job was not started because your account is locked due to a billing issue.' });
  assert.equal(actionsHealth({ j: ghFrom({ runs: [{ databaseId: 9, conclusion: 'success', status: 'completed' }, ...runs] }) }).state, 'ok');
  // a real failure (steps ran) is not "blocked"
  assert.equal(actionsHealth({ j: ghFrom({ runs, jobs: [{ databaseId: 11, conclusion: 'failure', steps: [{ name: 'test' }] }] }) }).state, 'unknown');
  assert.equal(actionsHealth({ j: () => null }).state, 'unknown');
  assert.equal(actionsHealth({ j: ghFrom({ runs: [] }) }).reason, 'no workflow runs yet');
});

test('crew tick: every scheduled step runs; one failing does not stop the rest', async () => {
  const done = [];
  const steps = [
    ['sweep', () => { done.push('sweep'); return { status: 'success', summary: 'released #93' }; }],
    ['guard', () => { throw new Error('gh: HTTP 502'); }],
    ['merge-ready', () => { done.push('merge'); return { status: 'success' }; }],
    ['promote', async () => { done.push('promote'); return { status: 'success' }; }],
    ['digest', () => { done.push('digest'); return { status: 'success' }; }],
  ];
  const out = await tickOnce({ steps });
  assert.deepEqual(done, ['sweep', 'merge', 'promote', 'digest']);
  assert.deepEqual(out.map((s) => s.status), ['success', 'error', 'success', 'success', 'success']);
  assert.match(out[1].summary, /HTTP 502/);

  const blocked = { state: 'blocked', reason: 'account is locked due to a billing issue' };
  const r = await tick.run({}, { steps, health: () => blocked, quiet: true });
  assert.equal(r.status, 'warning');
  assert.match(r.next_actions[0], /GitHub Actions do not run in this repo \(account is locked/);
  assert.match(r.next_actions[0], /crew github setup --local_checks --apply/);
  const fine = await tick.run({}, { steps: steps.filter(([n]) => n !== 'guard'), health: () => ({ state: 'ok' }), quiet: true });
  assert.equal(fine.status, 'success');
  assert.equal(findCommand(['tick']).name, 'tick');
  assert.ok(!agentCommands.some((c) => c.name === 'tick'), 'humans run it, agents do not');
});

test('a Claude Code cloud session is the Claude agent, named after its session', () => {
  const cloud = { CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01VxQd93cCf8xzhh1PmF1KyB' };
  assert.equal(machineName(cloud), 'cloud-1pmf1kyb', 'the last 8 characters of the session id');
  assert.equal(baseAgentId(cloud), `claude@${machineName(cloud)}`);
  assert.equal(baseAgentId({ CLAUDE_CODE_REMOTE: 'true' }), 'claude@cloud');
  assert.equal(baseAgentId({ ...cloud, CREW_AGENT: 'codex' }), `codex@${machineName(cloud)}`, 'an explicit name wins');
  assert.match(baseAgentId({ CLAUDECODE: '1' }), /^claude@/, 'a shell inside Claude Code is not a human');
  assert.match(baseAgentId({}), /^human@/);
  assert.equal(cloudSession(cloud), true);
  assert.equal(cloudSession({}), false);
});

test('in a cloud session a GraphQL 403 from gh is reported as the proxy limit, not a crew failure', () => {
  const cloud = { CLAUDE_CODE_REMOTE: 'true' };
  const e = graphqlBlocked('gh', ['issue', 'list', '--json', 'number'], 'HTTP 403: Forbidden (https://api.github.com/graphql)', cloud);
  assert.equal(e.code, 'gh_graphql_blocked');
  assert.match(e.message, /gh issue list is blocked in this cloud session/);
  assert.equal(graphqlBlocked('gh', ['api', 'repos/o/r'], 'HTTP 403', cloud), null, 'REST is not the GraphQL block');
  assert.equal(graphqlBlocked('gh', ['issue', 'list'], 'HTTP 403', {}), null, 'outside the cloud a 403 is a real permission problem');
  assert.equal(graphqlBlocked('git', ['push'], 'HTTP 403', cloud), null);
});
