// Regression tests for the second batch of v0 review findings (issue #1): H1, H3, H4, H5, H6, H7, M1, M2, M3, M8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { safeText, isTrustedComment, parseMarkers, currentOwner, ownerState, ownerActivityAt, marker } from '../src/core/issues.js';
import { checkLease } from '../src/core/lease.js';
import { scanStaged } from '../src/commands/commit.js';
import { countTests, isFullRun } from '../src/commands/check.js';
import { evaluateGuard, reviewMarker } from '../src/core/guard.js';
import { localAgentFiles, prepareWorkspace } from '../src/commands/task.js';
import { findCommand } from '../src/core/registry.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

const ROOT = join(import.meta.dirname, '..');
const CREW = join(ROOT, 'bin', 'crew.js');
const crew = (args, cwd, env = {}) => {
  const r = spawnSync(process.execPath, [CREW, ...args, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: JSON.parse(r.stdout) };
};
const g = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
const NOW = Date.parse('2026-11-08T12:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const c = (body, minAgo, extra = {}) => ({ body, createdAt: iso(minAgo), ...extra });
const claimC = (agent, minAgo, extra) => c(marker('claim', { agent, at: iso(minAgo) }), minAgo, extra);

// -- H7: markers only from members, notes are escaped --────────────────────────────

test('H7: markers from outsiders are ignored (release/claim from NONE/CONTRIBUTOR)', () => {
  const member = { author: { login: 'alice' }, authorAssociation: 'MEMBER' };
  const stranger = { author: { login: 'troll' }, authorAssociation: 'NONE' };
  const comments = [claimC('claude/a', 30, member), c(marker('release', { agent: 'x', at: iso(10) }), 10, stranger)];
  assert.equal(currentOwner(comments).agent, 'claude/a', 'a foreign release does not release the task');
  assert.equal(parseMarkers(comments).length, 1);
  assert.equal(parseMarkers(comments, { trustedOnly: false }).length, 2);
  assert.ok(isTrustedComment({ author: { login: 'github-actions' }, authorAssociation: 'NONE' }), 'the Actions bot (sweep, promote) is trusted');
  assert.ok(isTrustedComment({ author: { login: 'b' }, authorAssociation: 'collaborator' }));
  assert.ok(!isTrustedComment({ author: { login: 'b' }, authorAssociation: 'CONTRIBUTOR' }));
});

test('H7: --note quoting a marker does not become a marker', () => {
  const note = 'see <!-- crew:release agent=evil at=2026 -->';
  const body = `${marker('status', { agent: 'a', state: 'blocked', at: 'x' })}\n${safeText(note)}`;
  const ms = parseMarkers([{ body }]);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].kind, 'status');
  assert.ok(!safeText(note).includes('<!--') && !safeText(note).includes('-->'));
});

test('H7: crew-guard does not count a review marker from an outsider (public repo)', () => {
  const sha = 'abcdef1234567890';
  const body = 'Closes #3\n\n**Agent:** `claude/a`\n';
  const fake = { body: reviewMarker({ verdict: 'approve', agent: 'codex/x', sha: 'abcdef1' }), createdAt: iso(1), author: { login: 'troll' }, authorAssociation: 'NONE' };
  const real = { ...fake, author: { login: 'bob' }, authorAssociation: 'COLLABORATOR' };
  assert.equal(evaluateGuard({ body, headSha: sha, comments: [fake], config: DEFAULT_CONFIG }).state, 'pending');
  assert.equal(evaluateGuard({ body, headSha: sha, comments: [real], config: DEFAULT_CONFIG }).state, 'success');
});

// -- H3: bypasses of the pr open gate --──────────────────────────────────────────────────────────

test('H3c: a PR opened bypassing crew pr open (no **Agent:**) does not pass crew-guard', () => {
  const r = evaluateGuard({ body: 'Closes #3', headSha: 'abcdef1234', comments: [], config: DEFAULT_CONFIG });
  assert.equal(r.state, 'failure');
  assert.ok(r.problems.some((p) => p.rule === 'not_crew_pr'));
});

test('H3a: a partial run and an old config do not count (isFullRun)', () => {
  const steps = [{ name: 'lint' }, { name: 'test' }];
  assert.equal(isFullRun([{ name: 'lint', ok: true }], steps), false, '--only lint');
  assert.equal(isFullRun([{ name: 'lint', ok: true }, { name: 'test', ok: true }], steps), true);
  assert.equal(isFullRun([{ name: 'lint', ok: true }, { name: 'test', ok: false }], steps), false);
  assert.equal(isFullRun([{ name: 'lint', ok: true }, { name: 'test', ok: true, skipped: true }], steps), true, 'a skip by when_exists is by the rules');
  assert.equal(isFullRun([], []), false);
});

test('H3a: crew check --only writes green: false and partial: true', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-only-'));
  writeFileSync(join(dir, 'crew.config.json'), JSON.stringify({ check: [{ name: 'a', run: 'node -e "0"' }, { name: 'b', run: 'node -e "0"' }] }));
  g(dir, 'init', '-q', '-b', 'main');
  const r = crew(['check', '--only', 'a'], dir);
  assert.equal(r.out.status, 'warning', JSON.stringify(r.out));
  const lc = JSON.parse(readFileSync(join(dir, '.crew', 'last-check.json'), 'utf8'));
  assert.equal(lc.green, false);
  assert.equal(lc.partial, true);
  const full = crew(['check'], dir);
  assert.equal(full.out.status, 'success');
  assert.equal(JSON.parse(readFileSync(join(dir, '.crew', 'last-check.json'), 'utf8')).green, true);
});

// -- H1: acceptance tests are mandatory --───────────────────────────────────────────────────

test('H1: a step with tests_dir is skipped while there are no tests; with tests - only exit code 0 (and not "no tests found")', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-acc-'));
  g(dir, 'init', '-q', '-b', 'main');
  // a command "like pytest with no tests": exits with 5, and ok_exit_codes [0,5] is ignored for tests_dir
  const step = { name: 'acceptance', run: 'node -e "process.exit(5)"', tests_dir: 'tests/acceptance', ok_exit_codes: [0, 5] };
  writeFileSync(join(dir, 'crew.config.json'), JSON.stringify({ check: [step] }));
  const empty = crew(['check'], dir);
  assert.equal(empty.out.status, 'success');
  assert.match(empty.out.summary, /no tests yet/);
  mkdirSync(join(dir, 'tests', 'acceptance'), { recursive: true });
  writeFileSync(join(dir, 'tests', 'acceptance', 'test_1_login.py'), 'def test_x(): pass\n');
  const red = crew(['check'], dir);
  assert.equal(red.out.error?.code, 'ci_red', JSON.stringify(red.out));
});

test('H1: countTests counts pytest/vitest/node:test files, excluding node_modules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cnt-'));
  mkdirSync(join(dir, 'sub', 'node_modules', 'x'), { recursive: true });
  for (const f of ['test_a.py', 'b_test.py', 'c.spec.ts', 'd.test.mjs', 'README.md', 'conftest.py']) writeFileSync(join(dir, f), '');
  writeFileSync(join(dir, 'sub', 'e.test.js'), '');
  writeFileSync(join(dir, 'sub', 'node_modules', 'x', 'f.test.js'), '');
  assert.equal(countTests(dir), 5);
  assert.equal(countTests(dir, '(^test_.*\\.py$)|(_test\\.py$)'), 2);
  assert.equal(countTests(join(dir, 'missing')), 0);
});

test('H1: the stack presets contain an acceptance step with tests_dir and no when_exists', () => {
  for (const s of ['web-fastapi', 'web-node']) {
    const j = JSON.parse(readFileSync(join(ROOT, 'templates', 'stacks', `${s}.json`), 'utf8'));
    const a = j.check.find((x) => x.name === 'acceptance');
    assert.ok(a, `${s}: no acceptance step`);
    assert.equal(a.tests_dir, 'tests/acceptance');
    assert.ok(!a.when_exists && !a.ok_exit_codes);
    const re = new RegExp(a.tests_pattern);
    assert.ok(re.test(s === 'web-node' ? 'login.test.js' : 'test_login.py'));
    assert.ok(!re.test('README.md'));
  }
});

// -- H5 / M8: the lease and a dangling owner --─────────────────────────────────────────────────

test('H5: a stale claim (the agent crashed before the label changed) - ownerState.stale, the task can be taken', () => {
  const s = ownerState([claimC('claude/dead', 120)], { now: NOW, leaseMinutes: 45 });
  assert.equal(s.owner.agent, 'claude/dead');
  assert.equal(s.stale, true);
  assert.equal(ownerState([claimC('claude/live', 10)], { now: NOW, leaseMinutes: 45 }).stale, false);
  assert.equal(ownerState([], { now: NOW, leaseMinutes: 45 }).owner, null);
});

test('M8: the lease is extended only by markers of the owner, not of the loser in claim_conflict', () => {
  const comments = [claimC('claude/a', 60), claimC('codex/b', 5)]; // b lost the race 5 minutes ago
  const owner = currentOwner(comments);
  assert.equal(owner.agent, 'claude/a');
  assert.equal(ownerActivityAt(comments, owner), iso(60));
  assert.equal(ownerState(comments, { now: NOW, leaseMinutes: 45 }).stale, true);
  const beat = [...comments, c(marker('heartbeat', { agent: 'claude/a', at: iso(2) }), 2)];
  assert.equal(ownerState(beat, { now: NOW, leaseMinutes: 45 }).stale, false, 'the owner heartbeat extends it');
  assert.equal(ownerState(comments, { now: NOW, leaseMinutes: 45, lastCommitAt: iso(3) }).stale, false, 'a push to the task branch extends it');
});

// -- H6: heartbeat from inside the work and the owner check --─────────────────────────────────

test('H6: checkLease - ok + heartbeat no more than once per 5 minutes; lost if the task was taken; unknown without GitHub', () => {
  const posted = [];
  const post = (id, body) => posted.push(body);
  const mine = { comments: [claimC('claude/a', 20)] };
  const r = checkLease({ id: 1, me: 'claude/a', view: () => mine, post, now: NOW });
  assert.equal(r.state, 'ok');
  assert.equal(r.heartbeat, true);
  assert.match(posted[0], /crew:heartbeat agent=claude\/a/);

  const fresh = { comments: [claimC('claude/a', 20), c(marker('heartbeat', { agent: 'claude/a', at: iso(2) }), 2)] };
  assert.equal(checkLease({ id: 1, me: 'claude/a', view: () => fresh, post, now: NOW }).heartbeat, false, 'no spam');

  const taken = { comments: [claimC('claude/a', 90), c(marker('release', { agent: 'github-actions', at: iso(40) }), 40), claimC('codex/b', 30)] };
  const lost = checkLease({ id: 1, me: 'claude/a', view: () => taken, post, now: NOW });
  assert.equal(lost.state, 'lost');
  assert.equal(lost.owner, 'codex/b');

  const offline = checkLease({ id: 1, me: 'claude/a', view: () => { throw new Error('no network'); }, post, now: NOW });
  assert.equal(offline.state, 'unknown');
});

// -- M3: commit only on the task branch, no secrets --────────────────────────────────────

test('M3: scanStaged catches keys by name and by content, including .env.example', () => {
  const names = ['src/a.js', 'deploy/server.pem', '.env', '.env.example', 'config/service-account.json', 'data/dump.sqlite'];
  const diff = [
    '+++ b/src/a.js',
    '+const k = "AKIAABCDEFGHIJKLMNOP";',
    '+++ b/.env.example',
    '+OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '+++ b/src/b.js',
    '+const t = "ghp_' + 'a'.repeat(36) + '";',
  ].join('\n');
  const files = scanStaged(names, diff).map((h) => h.file);
  for (const f of ['deploy/server.pem', '.env', 'config/service-account.json', 'data/dump.sqlite', 'src/a.js', 'src/b.js']) assert.ok(files.includes(f), f);
  assert.ok(files.includes('.env.example'));
  assert.deepEqual(scanStaged(['src/ok.js'], '+++ b/src/ok.js\n+const x = 1;\n'), []);
});

test('M3: crew commit refuses on main and does not commit secrets (the files stay in place)', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-cm-'));
  const root = join(parent, 'p');
  g(parent, 'init', '-q', '-b', 'main', root);
  g(root, 'config', 'user.email', 't@example.com');
  g(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'crew.config.json'), '{}');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'init');
  writeFileSync(join(root, 'a.txt'), 'x\n');
  assert.equal(crew(['commit', '-m', 'feat: x'], root).out.error.code, 'not_task_branch');
  g(root, 'checkout', '-q', '-b', 'crew/4-x');
  writeFileSync(join(root, 'id_rsa'), 'secret\n');
  const r = crew(['commit', '-m', 'feat: x'], root, { CREW_AGENT: 'claude/t' });
  assert.equal(r.out.error.code, 'secret_suspected', JSON.stringify(r.out));
  assert.ok(existsSync(join(root, 'id_rsa')), 'the file is not deleted');
  assert.equal(g(root, 'diff', '--cached', '--name-only').stdout.trim(), '', 'the index is cleared');
});

// -- M1: release / heartbeat / status check the owner --──────────────────────────────

test('M1: task status claimed is forbidden (only via claim); release/status have --force for humans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-st-'));
  assert.equal(crew(['task', 'status', '5', 'claimed'], dir).out.error.code, 'use_claim');
  assert.ok(findCommand(['task', 'release']).args.some((a) => a.name === 'force'));
  assert.ok(findCommand(['task', 'status']).args.some((a) => a.name === 'force'));
});

// -- Executor helpers on cheap models --──────────────────────────────────────────

test('roles scout (low -> haiku) and implementer (mid -> sonnet) are generated for Claude and Codex', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-roles-'));
  const proj = join(parent, 'demo');
  assert.equal(crew(['init', proj], parent).out.status, 'success');
  const scout = readFileSync(join(proj, '.claude', 'agents', 'scout.md'), 'utf8');
  const impl = readFileSync(join(proj, '.claude', 'agents', 'implementer.md'), 'utf8');
  assert.match(scout, /^model: haiku$/m);
  assert.match(impl, /^model: sonnet$/m);
  assert.match(scout, /Change nothing/);
  assert.match(impl, /Do not commit/);
  assert.ok(existsSync(join(proj, '.agents', 'skills', 'role-scout', 'SKILL.md')), 'Codex gets the role as a skill');
  assert.ok(existsSync(join(proj, '.agents', 'skills', 'role-implementer', 'SKILL.md')));
  assert.match(readFileSync(join(proj, 'AGENTS.md'), 'utf8'), /Who gets what/);
});

// -- H4: local agent configs reach the worktree --─────────────────────────────────

test('H4: the task worktree gets .mcp.json and skills from the root (they are in .gitignore)', () => {
  const parent = mkdtempSync(join(tmpdir(), 'crew-wt-'));
  const proj = join(parent, 'demo');
  assert.equal(crew(['init', proj], parent).out.status, 'success');
  const local = localAgentFiles(proj);
  for (const f of ['.mcp.json', '.codex/config.toml', '.claude/skills', '.agents/skills']) assert.ok(local.includes(f), `${f} is not in the list: ${local}`);
  assert.ok(!local.includes('.crew'));
  g(proj, 'add', '-A');
  g(proj, 'commit', '-q', '-m', 'init');
  const ws = prepareWorkspace({ root: proj, id: 11, title: 'Login' });
  for (const f of ['.mcp.json', '.codex/config.toml', '.claude/skills/crew-workflow/SKILL.md', '.agents/skills/crew-workflow/SKILL.md']) {
    assert.ok(existsSync(join(ws.worktree, f)), `worktree has no ${f}`);
  }
  assert.ok(ws.copied.includes('.mcp.json'));
  assert.equal(g(ws.worktree, 'status', '--porcelain').stdout.trim(), '', 'copied files are ignored by git');
});
