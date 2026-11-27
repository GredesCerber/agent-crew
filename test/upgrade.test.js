// crew upgrade: plan for current and legacy (hk) projects; legacy markers keep working. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planUpgrade, mergeConfig, migrateGitignore, ownedFiles, staleGenerated } from '../src/commands/upgrade.js';
import { parseMarkers } from '../src/core/issues.js';
import { reviewState } from '../src/core/guard.js';
import { prdApproval } from '../src/core/prd.js';
import { issueFromBranch } from '../src/commands/pr.js';
import upgrade from '../src/commands/upgrade.js';
import { findCommand, agentCommands } from '../src/core/registry.js';

const fakeRepo = (files) => ({
  exists: (p) => p in files,
  read: (p) => files[p],
  list: (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)),
});
const FILES = [{ path: 'AGENTS.md', content: 'rules v2\n' }, { path: 'agents/skills/crew-workflow/SKILL.md', content: 'loop\n' }];

test('legacy hk project: renames, deletes old workflows and hk-* skills, writes crew files, fixes .gitignore', () => {
  const repo = fakeRepo({
    'hk.config.json': JSON.stringify({ hosts: ['claude'], areas: { web: ['web/**'] }, custom: 1 }),
    'docs/tz.md': 'brief',
    '.github/workflows/hk.yml': 'x',
    '.github/workflows/hk-guard.yml': 'x',
    'agents/skills/hk-workflow/SKILL.md': 'old',
    'agents/skills/hk-deploy/SKILL.md': 'our own skill',
    'AGENTS.md': 'rules v1\n',
    '.gitignore': '# hk: локальные файлы\n.hk/\n.mcp.json\n',
  });
  const plan = planUpgrade(repo, { files: FILES, defaults: { hosts: ['claude', 'codex'], areas: { web: ['web/**'], design: ['design/**'] }, lease_minutes: 45 } });
  assert.equal(plan.legacy, true);
  const by = (op) => plan.ops.filter((o) => o.op === op).map((o) => (o.from ? `${o.from}>${o.path}` : o.path));
  assert.deepEqual(by('rename'), ['hk.config.json>crew.config.json', 'docs/tz.md>docs/brief.md']);
  assert.deepEqual(by('delete'), ['.github/workflows/hk.yml', '.github/workflows/hk-guard.yml', 'agents/skills/hk-workflow/SKILL.md']);
  const writes = Object.fromEntries(plan.ops.filter((o) => o.op === 'write').map((o) => [o.path, o]));
  assert.equal(writes['AGENTS.md'].kind, 'update');
  assert.equal(writes['agents/skills/crew-workflow/SKILL.md'].kind, 'create');
  const cfg = JSON.parse(writes['crew.config.json'].content);
  assert.deepEqual(cfg.hosts, ['claude'], 'user values kept');
  assert.equal(cfg.custom, 1);
  assert.equal(cfg.lease_minutes, 45, 'missing keys added');
  assert.deepEqual(cfg.areas, { web: ['web/**'] }, 'areas belong to the project: never added back');
  assert.deepEqual(plan.config_added, ['lease_minutes']);
  assert.equal(writes['.gitignore'].content, '# crew: local files\n.crew/\n.mcp.json\n');
});

test('up-to-date project: no ops; CRLF differences are not changes', () => {
  const repo = fakeRepo({ 'crew.config.json': '{"a":1}', 'AGENTS.md': 'rules v2\r\n', 'agents/skills/crew-workflow/SKILL.md': 'loop\n', '.gitignore': '# crew: local files\n.crew/\n' });
  const plan = planUpgrade(repo, { files: FILES, defaults: { a: 2 } });
  assert.deepEqual(plan.ops, []);
  assert.equal(plan.legacy, false);
});

test('mergeConfig and gitignore helpers', () => {
  assert.deepEqual(mergeConfig({ a: 1 }, { a: 2, b: 3 }), { config: { a: 1, b: 3 }, added: ['b'] });
  assert.equal(migrateGitignore('# hk: local files\r\n.hk/\r\n'), '# crew: local files\n.crew/\n');
});

test('owned files come from the package: AGENTS.md, workflows, roles, skills', () => {
  const paths = ownedFiles().map((f) => f.path);
  for (const p of ['AGENTS.md', '.github/workflows/crew.yml', '.github/workflows/crew-guard.yml', 'agents/roles/builder.md', 'agents/skills/crew-workflow/SKILL.md', 'docs/playbooks/preflight.md']) {
    assert.ok(paths.includes(p), p);
  }
  assert.ok(!paths.some((p) => p.startsWith('docs/brief') || p === 'docs/prd.md'), 'project docs are never overwritten');
});

test('legacy hk markers and branches still read after the upgrade (no duplicate tasks, leases, reviews)', () => {
  const m = parseMarkers([{ body: '<!-- hk:claim agent=codex@x at=2026-11-10T10:00:00Z -->', authorAssociation: 'COLLABORATOR' }]);
  assert.equal(m[0].kind, 'claim');
  assert.equal(m[0].agent, 'codex@x');
  const rs = reviewState([{ body: '<!-- hk:review verdict=approve agent=claude@a sha=abcdef1 -->', authorAssociation: 'MEMBER' }],
    { headSha: 'abcdef1234', author: 'codex@b', policy: { require: 'other-agent', fallback_minutes: 30 }, prCreatedAt: '2026-11-10T10:00:00Z' });
  assert.deepEqual(rs.approvals, ['claude@a']);
  assert.equal(prdApproval('<!-- hk:prd status: approved by: alice at: 2026-11-10T08:00:00Z -->').approved, true);
  assert.equal(issueFromBranch('hk/58-docker'), 58);
  assert.equal(issueFromBranch('crew/58-docker'), 58);
});

test('crew upgrade is a human command (not exposed to agents over MCP)', () => {
  assert.equal(findCommand(['upgrade']).name, 'upgrade');
  assert.ok(!agentCommands.some((c) => c === upgrade));
  assert.ok(!agentCommands.some((c) => c.name === 'board'));
});

test('check: a step that requires a missing tool is skipped locally with a note and fails in CI', async () => {
  const { default: check } = await import('../src/commands/check.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { git } = await import('../src/core/exec.js');
  const root = mkdtempSync(join(tmpdir(), 'crew-req-'));
  git(['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'crew.config.json'), JSON.stringify({ check: [{ name: 'docker-e2e', run: 'node -e "process.exit(1)"', requires: ['docker'] }, { name: 'unit', run: 'node -e "0"' }] }));
  const deps = { hasTool: () => false, checkLease: () => ({ state: 'ok' }) };
  const prevCI = process.env.CI;
  delete process.env.CI;
  try {
    const local = check.run({ cwd: root }, deps);
    assert.equal(local.status, 'success', JSON.stringify(local));
    assert.match(JSON.stringify(local), /needs docker: skipped here, CI runs it/);
    process.env.CI = 'true';
    const ci = check.run({ cwd: root }, deps);
    assert.equal(ci.status, 'error');
  } finally {
    if (prevCI === undefined) delete process.env.CI; else process.env.CI = prevCI;
  }
});

test('pr open: conflicts with main are found before pushing (real git merge-tree)', async () => {
  const { mainConflicts } = await import('../src/commands/pr.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { git } = await import('../src/core/exec.js');
  const root = mkdtempSync(join(tmpdir(), 'crew-conf-'));
  const g = (...a) => git(['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'tr.json'), '{"a":1}\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'crew/5-x');
  writeFileSync(join(root, 'tr.json'), '{"a":1,"mine":2}\n');
  g('commit', '-q', '-am', 'mine');
  g('checkout', '-q', 'main');
  writeFileSync(join(root, 'tr.json'), '{"a":1,"theirs":3}\n');
  g('commit', '-q', '-am', 'theirs');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  g('checkout', '-q', 'crew/5-x');
  const sh = (args) => (args[0] === 'fetch' ? { code: 0, stdout: '', stderr: '' } : git(args, { cwd: root, allowFail: true }));
  assert.deepEqual(mainConflicts(root, sh), ['tr.json']);
  g('checkout', '-q', 'main');
  g('checkout', '-q', '-b', 'crew/6-y');
  assert.deepEqual(mainConflicts(root, sh), [], 'no conflicts on a fresh branch');
});

test('merge-ready merges only ready PRs (review + green check and crew-guard, not auto-merged), deterministically', async () => {
  const { default: mergeReady } = await import('../src/commands/merge-ready.js');
  const SHA = 'abcdef1234567890';
  const green = [{ name: 'check', conclusion: 'SUCCESS' }, { context: 'crew-guard', state: 'SUCCESS' }];
  const approve = [{ body: `<!-- crew:review verdict=approve agent=claude@a sha=${SHA.slice(0, 7)} -->`, authorAssociation: 'MEMBER' }];
  const pr = (number, risk, extra = {}) => ({ number, title: `PR ${number}`, body: `Closes #${number}\n**Agent:** \`codex@b\``, headRefOid: SHA, createdAt: '2026-11-14T10:00:00Z', isDraft: false, author: { login: 'b' }, labels: [{ name: `risk:${risk}` }], comments: approve, statusCheckRollup: green, ...extra });
  const calls = [];
  const r = mergeReady.run({}, {
    config: { hosts: ['claude', 'codex'] },
    prs: [pr(1, 'high'), pr(2, 'med', { autoMergeRequest: { enabledAt: 'x' } }), pr(3, 'high', { comments: [] }), pr(4, 'high', { mergeable: 'CONFLICTING' })],
    gh: (args) => (calls.push(args), { code: 0, stdout: '', stderr: '' }),
  });
  assert.deepEqual(r.artifacts.merged, [1]);
  assert.deepEqual(calls, [['pr', 'merge', '1', '--merge', '--delete-branch', '--match-head-commit', SHA]], 'merges exactly the reviewed commit');
});

test('crew-guard: a human waiver lifts paperwork rules for this commit only; protected files and review stay', async () => {
  const { evaluateGuard, waiveMarker } = await import('../src/core/guard.js');
  const SHA = '0123456789abcdef';
  const base = { body: 'cloud session change', headSha: SHA, createdAt: '2026-11-14T10:00:00Z', now: Date.parse('2026-11-14T12:00:00Z'), config: {}, files: [{ filename: 'web/a.ts', status: 'modified' }], commits: [{ sha: SHA, agent: null }] };
  const human = (body) => ({ body, authorAssociation: 'OWNER', author: { login: 'cap' } });
  const before = evaluateGuard(base);
  assert.deepEqual(before.problems.map((p) => p.rule).sort(), ['agent_trailer', 'closes', 'not_crew_pr']);
  const waivers = ['closes', 'agent_trailer', 'not_crew_pr'].map((rule) => human(waiveMarker({ rule, sha: SHA.slice(0, 12) })));
  const after = evaluateGuard({ ...base, comments: waivers });
  assert.equal(after.state, 'pending', 'still needs a review');
  assert.deepEqual(after.waived.sort(), ['agent_trailer', 'closes', 'not_crew_pr']);
  const approved = evaluateGuard({ ...base, comments: [...waivers, human(`<!-- crew:review verdict=approve agent=claude@a sha=${SHA.slice(0, 7)} -->`)] });
  assert.equal(approved.state, 'success');
  assert.match(approved.description, /waived/);
  const newPush = evaluateGuard({ ...base, headSha: 'ffff' + SHA.slice(4), comments: waivers });
  assert.equal(newPush.state, 'failure', 'a waiver is bound to its commit');
  const prot = evaluateGuard({ ...base, files: [{ filename: '.github/workflows/crew.yml', status: 'modified' }], comments: [...waivers, human(waiveMarker({ rule: 'protected_paths', sha: SHA.slice(0, 12) }))] });
  assert.ok(prot.problems.some((p) => p.rule === 'protected_paths'), 'protected files cannot be waived');
  const bot = evaluateGuard({ ...base, comments: waivers.map((c) => ({ ...c, author: { login: 'github-actions[bot]' } })) });
  assert.equal(bot.waived.length, 0, 'bots cannot waive');
});

test('staleGenerated: committed agent configs that a new crew would change count as upgrade work; local-only ones do not', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'crew-regen-'));
  writeFileSync(join(root, 'crew.config.json'), JSON.stringify({ hosts: ['claude'] }));
  const build = async () => ({ files: [
    { path: '.claude/crew-cloud-setup.mjs', commit: true, content: 'new' },
    { path: 'CLAUDE.md', commit: true, content: 'same' },
    { path: '.claude/settings.local.json', commit: false, content: 'local' },
  ] });
  const stale = (_root, f) => f.content !== 'same';
  assert.deepEqual(await staleGenerated(root, { build, stale }), ['.claude/crew-cloud-setup.mjs']);
  assert.deepEqual(await staleGenerated(join(root, 'nowhere'), { build, stale }), []);
});
