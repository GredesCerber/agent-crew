// crew up without network: gh is replaced, git is real in a temp folder (except ls-remote).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import up, { parseInvite, eventFile, launchHints, sameRepo, EVENT_PATH } from '../src/commands/up.js';
import init from '../src/commands/init.js';
import { findCommand, agentCommands } from '../src/core/registry.js';
import { run } from '../src/core/exec.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'crew-up-'));
const OKR = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const NO = (stderr = 'HTTP 404: Not Found') => ({ code: 1, stdout: '', stderr });

/** Replacement runner: gh/crew/agents come from a table, git is real (ls-remote is a fake). */
function fakeRun(gh = {}, { remoteMain = false, clone, pull = OKR() } = {}) {
  const calls = [];
  const sh = (cmd, args = [], opts = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'pull') return pull;
    if (cmd === 'git' && args[0] === 'ls-remote') return OKR(remoteMain ? 'abc\trefs/heads/main' : '');
    if (cmd === 'git') return run(cmd, args, opts);
    if (cmd === 'gh') {
      const key = args.join(' ');
      if (args[0] === '--version') return OKR('gh version 2.0');
      if (key === 'auth status') return gh.auth ?? OKR();
      if (args[0] === 'api' && args[1] === 'user') return gh.user ?? OKR('alice 42');
      if (args[0] === 'api' && args[1] === 'user/repository_invitations') return gh.invitations ?? OKR('[]');
      if (args[0] === 'repo' && args[1] === 'view' && args.includes('viewerPermission')) return gh.perm ?? OKR('WRITE');
      if (args[0] === 'repo' && args[1] === 'view') return gh.view ?? NO('GraphQL: Could not resolve to a Repository');
      if (args[0] === 'repo' && args[1] === 'clone') return clone ? clone(args[2], args[3]) : NO();
      return gh.other ?? OKR();
    }
    return OKR('1.0.0'); // crew, claude, codex, cmd
  };
  return { sh, calls, has: (...words) => calls.some((c) => words.every((w) => c.includes(w))) };
}

test('up: registered in the CLI but not in MCP (a human or an agent runs it from a terminal)', () => {
  assert.equal(findCommand(['up']).name, 'up');
  assert.ok(!agentCommands.some((c) => c.name === 'up'));
});

test('parseInvite: commas, spaces, @, duplicates; bad logins separately', () => {
  assert.deepEqual(parseInvite('alice-dev, @bob bob'), { logins: ['alice-dev', 'bob'], bad: [] });
  assert.deepEqual(parseInvite('ok,-bad,a_b').bad, ['-bad', 'a_b']);
  assert.deepEqual(parseInvite(undefined), { logins: [], bad: [] });
});

test('eventFile and launchHints: Codex is launched with CREW_AGENT=codex', () => {
  const e = eventFile({ name: 'x', team: ['a', 'a', 'b'] });
  assert.deepEqual(e.team_members, ['a', 'b']);
  assert.equal(e.start, '');
  assert.ok(launchHints(['codex'], 'p', 'win32')[0].includes("$env:CREW_AGENT='codex'"));
  assert.ok(launchHints(['codex'], 'p', 'linux')[0].includes('CREW_AGENT=codex codex'));
  assert.ok(launchHints(['claude'], 'p').some((h) => h.includes('crew-workflow')));
});

test('up: wrong arguments - clear errors with no calls', async () => {
  const f = fakeRun();
  for (const o of [
    {},
    { repo: 'a/b', join: 'a/b' },
    { repo: 'no-slash' },
    { repo: 'a/b', invite: 'ok,-bad' },
    { repo: 'a/b', start: '2026-11-10T10:00:00+03:00' },
    { repo: 'a/b', start: 'tomorrow', end: 'day-after-tomorrow' },
    { join: 'bad' },
  ]) {
    const r = await up.run(o, { run: f.sh });
    assert.equal(r.error?.code, 'bad_input', JSON.stringify(o));
  }
  assert.equal(f.calls.length, 0);
});

test('up: gh is not authenticated - stop, a human logs in', async () => {
  const f = fakeRun({ auth: NO('not logged in') });
  const r = await up.run({ repo: 'GredesCerber/demo', dir: join(tmp(), 'demo') }, { run: f.sh });
  assert.equal(r.error.code, 'gh_auth');
  assert.ok(r.artifacts.human_steps.some((h) => h.includes('gh auth login')));
});

test('up captain: project, event.json, commit, repo, invitations, main protection; a repeat - everything is skipped', async () => {
  const dir = join(tmp(), 'demo');
  const f = fakeRun();
  const r = await up.run({
    repo: 'GredesCerber/demo', dir, stack: 'web-node', invite: 'bob,alice',
    start: '2026-11-10T10:00:00+03:00', end: '2026-11-11T18:00:00+03:00', event_name: 'Hackathon',
  }, { run: f.sh });
  assert.equal(r.status, 'success', JSON.stringify(r, null, 1));

  const cfg = JSON.parse(readFileSync(join(dir, 'crew.config.json'), 'utf8'));
  assert.equal(cfg.stack, 'web-node');
  assert.equal(cfg.event, EVENT_PATH);
  const ev = JSON.parse(readFileSync(join(dir, EVENT_PATH), 'utf8'));
  assert.deepEqual(ev.team_members, ['alice', 'bob']);
  assert.equal(ev.name, 'Hackathon');
  assert.equal(run('git', ['log', '--format=%s'], { cwd: dir }).stdout, 'chore: crew init (stack web-node)');
  assert.equal(run('git', ['status', '--porcelain'], { cwd: dir }).stdout, '', 'event.json went into the first commit');

  assert.ok(f.has('gh', 'repo', 'create', 'GredesCerber/demo', '--private', '--push'));
  assert.ok(f.has('gh', 'api', 'repos/GredesCerber/demo/collaborators/bob', 'permission=push'));
  assert.ok(!f.has('gh', 'api', 'repos/GredesCerber/demo/collaborators/alice'), 'we do not invite ourselves');
  assert.ok(f.has('gh', 'api', 'PUT', 'repos/GredesCerber/demo/branches/main/protection'));
  const state = Object.fromEntries(r.artifacts.steps.map((s) => [s.id, s.state]));
  assert.equal(state.init, 'done');
  assert.equal(state['github-setup'], 'done');
  assert.equal(state['package-access'], undefined, 'public install: no package access step');

  // A repeat: the repo already exists, main is pushed - nothing is created again.
  const f2 = fakeRun({ view: OKR('{"nameWithOwner":"GredesCerber/demo"}') }, { remoteMain: true });
  const r2 = await up.run({ repo: 'GredesCerber/demo', dir, invite: 'bob' }, { run: f2.sh });
  assert.equal(r2.status, 'success', JSON.stringify(r2, null, 1));
  const s2 = Object.fromEntries(r2.artifacts.steps.map((s) => [s.id, s.state]));
  for (const id of ['init', 'event', 'commit', 'repo']) assert.equal(s2[id], 'skipped', id);
  assert.ok(!f2.has('gh', 'repo', 'create'));
  assert.ok(!f2.has('git', 'push'));
  assert.equal(run('git', ['remote', 'get-url', 'origin'], { cwd: dir }).stdout, 'https://github.com/GredesCerber/demo.git');
});

test('up captain: without hackathon times the compliance check is off; a repo of any owner - no tokens', async () => {
  const dir = join(tmp(), 'p');
  const f = fakeRun();
  const r = await up.run({ repo: 'some-org/p', dir, public: true }, { run: f.sh });
  assert.equal(r.status, 'success', JSON.stringify(r, null, 1));
  assert.equal(JSON.parse(readFileSync(join(dir, 'crew.config.json'), 'utf8')).event, null);
  assert.ok(existsSync(join(dir, EVENT_PATH)));
  assert.ok(f.has('gh', 'repo', 'create', 'some-org/p', '--public'));
  assert.ok(!r.artifacts.human_steps.some((h) => h.includes('PACKAGES_TOKEN')));
  assert.ok(r.artifacts.human_steps.some((h) => h.includes('start/end')));
});

test('up captain: a foreign origin - stop, we overwrite nothing', async () => {
  const dir = join(tmp(), 'x');
  await init.run({ dir });
  run('git', ['remote', 'add', 'origin', 'https://github.com/other/thing.git'], { cwd: dir });
  const f = fakeRun({ view: OKR('{}') });
  const r = await up.run({ repo: 'GredesCerber/x', dir }, { run: f.sh });
  assert.equal(r.error.code, 'remote_mismatch');
  assert.ok(!f.has('git', 'push'));
});

test('up member: accepts an invitation only to its own repo, clones, builds the agent configs', async () => {
  const base = tmp();
  const src = join(base, 'src');
  await init.run({ dir: src });
  run('git', ['add', '-A'], { cwd: src });
  run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: src });

  const root = join(base, 'mine');
  const f = fakeRun({
    invitations: OKR(JSON.stringify([{ id: 5, repository: { full_name: 'other/repo' } }, { id: 7, repository: { full_name: 'Owner/Demo' } }])),
  }, {
    clone: (_repo, to) => {
      const r = run('git', ['clone', '-q', src, to]);
      run('git', ['remote', 'set-url', 'origin', 'https://github.com/Owner/Demo.git'], { cwd: to });
      return r;
    },
  });
  const r = await up.run({ join: 'owner/demo', dir: root }, { run: f.sh });
  assert.equal(r.status, 'success', JSON.stringify(r, null, 1));
  assert.ok(f.has('gh', 'api', 'PATCH', 'user/repository_invitations/7'));
  assert.ok(!f.has('user/repository_invitations/5'), 'we do not touch foreign invitations');
  assert.ok(existsSync(join(root, '.mcp.json')), 'local agent configs are built');
  assert.ok(r.next_actions.some((a) => a.includes('crew-workflow')));

  // A repeat: the clone already exists.
  const r2 = await up.run({ join: 'owner/demo', dir: root }, { run: fakeRun().sh });
  assert.equal(r2.status, 'success');
  assert.equal(r2.artifacts.steps.find((s) => s.id === 'clone').state, 'skipped');

  // git pull failed - a warning, not "done".
  const r3 = await up.run({ join: 'owner/demo', dir: root }, { run: fakeRun({}, { pull: NO('fatal: Not possible to fast-forward') }).sh });
  assert.equal(r3.status, 'warning');
  assert.equal(r3.artifacts.steps.find((s) => s.id === 'clone').state, 'failed');

  // The folder has another repo - stop, we do not build adapters.
  const f4 = fakeRun();
  const r4 = await up.run({ join: 'owner/other', dir: root }, { run: f4.sh });
  assert.equal(r4.error.code, 'remote_mismatch');
  assert.ok(!f4.has('git', 'pull'));
});

test('sameRepo: https and ssh, case, no substrings', () => {
  assert.ok(sameRepo('https://github.com/Owner/Demo.git', 'owner/demo'));
  assert.ok(sameRepo('git@github.com:owner/demo.git', 'owner/demo'));
  assert.ok(sameRepo('https://github.com/owner/demo', 'owner/demo'));
  assert.ok(sameRepo('https://github.com/owner/demo/', 'owner/demo'), 'trailing slash without .git');
  assert.ok(!sameRepo('https://github.com/evilowner/demo.git', 'owner/demo'));
  assert.ok(!sameRepo('C:/tmp/src', 'owner/demo'));
  assert.ok(!sameRepo('', 'owner/demo'));
});

test('up captain: event.json is rewritten on a repeat before the commit, in a committed project - only via a PR', async () => {
  // The project was committed by hand without event.json (like a real project) - we do not create the file, the working copy is clean.
  const dir = join(tmp(), 'ev');
  await init.run({ dir });
  run('git', ['add', '-A'], { cwd: dir });
  run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  const r = await up.run({ repo: 'GredesCerber/ev', dir, start: '2026-12-01T10:00:00+03:00', end: '2026-12-02T10:00:00+03:00' }, { run: fakeRun().sh });
  assert.equal(r.status, 'success', JSON.stringify(r, null, 1));
  assert.ok(!existsSync(join(dir, EVENT_PATH)), 'after the commit we do not write event.json');
  assert.ok(r.artifacts.human_steps.some((h) => h.includes('through a PR')));
  assert.equal(run('git', ['status', '--porcelain'], { cwd: dir }).stdout, '', 'nothing uncommitted is left');

  // The first run did not reach the commit - a repeat with other members rewrites event.json.
  const dir2 = join(tmp(), 'ev2');
  await init.run({ dir: dir2 });
  const noCommit = (cmd, args, opts) => (cmd === 'git' && args[0] === 'commit' ? NO('boom') : fakeRun().sh(cmd, args, opts));
  await up.run({ repo: 'GredesCerber/ev2', dir: dir2, invite: 'bob' }, { run: noCommit });
  assert.deepEqual(JSON.parse(readFileSync(join(dir2, EVENT_PATH), 'utf8')).team_members, ['alice', 'bob']);
  const r2 = await up.run({ repo: 'GredesCerber/ev2', dir: dir2, invite: 'bob,carol' }, { run: fakeRun().sh });
  assert.equal(r2.status, 'success', JSON.stringify(r2, null, 1));
  assert.deepEqual(JSON.parse(readFileSync(join(dir2, EVENT_PATH), 'utf8')).team_members, ['alice', 'bob', 'carol']);
});

test('up member: no access or read-only - stop with a hint for the captain', async () => {
  const r = await up.run({ join: 'o/r', dir: join(tmp(), 'r') }, { run: fakeRun({ perm: NO() }).sh });
  assert.equal(r.error.code, 'no_access');
  assert.ok(r.error.retry.includes('--invite alice'));
  const r2 = await up.run({ join: 'o/r', dir: join(tmp(), 'r') }, { run: fakeRun({ perm: OKR('READ') }).sh });
  assert.equal(r2.error.code, 'no_write');
});

test('up captain: main protection is unavailable (private repo, free plan) - a manual step, not silence', async () => {
  const f = fakeRun();
  const sh = (cmd, args = [], opts = {}) =>
    cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/{owner}/{repo}/branches/main/protection'
      ? NO('Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)')
      : f.sh(cmd, args, opts);
  const r = await up.run({ repo: 'GredesCerber/priv', dir: join(tmp(), 'priv') }, { run: sh });
  const step = r.artifacts.steps.find((s) => s.id === 'main-protection');
  assert.ok(step, JSON.stringify(r.artifacts.steps.map((s) => s.id)));
  assert.match(step.note ?? step.detail ?? JSON.stringify(step), /public|GitHub Pro/);
  const f2 = fakeRun();
  const prot = (cmd, args = [], opts = {}) =>
    cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/{owner}/{repo}/branches/main/protection'
      ? OKR(JSON.stringify({ required_status_checks: { contexts: ['check', 'crew-guard'] } }))
      : f2.sh(cmd, args, opts);
  const ok = await up.run({ repo: 'GredesCerber/pub', dir: join(tmp(), 'pub') }, { run: prot });
  assert.ok(!ok.artifacts.steps.some((s) => s.id === 'main-protection'), 'protection exists - no step');
});
