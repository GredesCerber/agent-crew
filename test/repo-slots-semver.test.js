// Session slots per repository (two unrelated repos on one machine are not siblings; a worktree shares its repo's
// slots) and SemVer with pre-releases for the version gate. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoKey, claimSlot, liveSlots, allLiveSlots } from '../src/core/session.js';
import { compareSemver, parseVersion } from '../src/core/semver.js';
import { compareVersions } from '../src/core/version.js';
import { pinnedVersion, prCrewVersion, evaluateGuard } from '../src/core/guard.js';

/** A fake repository folder: .git/config with an origin URL (or none). */
function repo(url) {
  const root = mkdtempSync(join(tmpdir(), 'crew-repo-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), url ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : '[core]\n');
  return root;
}

test('repo key: the same repo matches across clones, URL forms and worktrees; other repos do not', () => {
  const a = repo('https://github.com/acme/shop.git');
  const a2 = repo('git@github.com:acme/shop.git');
  const b = repo('https://github.com/acme/other');
  assert.equal(repoKey(a), repoKey(a2), 'https and ssh clones of one repo');
  assert.notEqual(repoKey(a), repoKey(b));
  mkdirSync(join(a, 'web', 'src'), { recursive: true });
  assert.equal(repoKey(join(a, 'web', 'src')), repoKey(a), 'a subfolder');
  // a task worktree: .git is a file pointing into the main repo's .git/worktrees/<name>
  const wtGit = join(a, '.git', 'worktrees', 'crew-5');
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(join(wtGit, 'commondir'), '../..\n');
  const wt = mkdtempSync(join(tmpdir(), 'crew-wt-'));
  writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.equal(repoKey(wt), repoKey(a), 'a worktree shares its repo');
  // no origin: keyed by the .git folder, still distinct per repo
  assert.notEqual(repoKey(repo(null)), repoKey(repo(null)));
  assert.equal(repoKey(mkdtempSync(join(tmpdir(), 'crew-none-'))), 'no-repo');
});

test('sessions in two repos both get claude@pc; inside one repo the second gets claude@pc#2', () => {
  const slots = mkdtempSync(join(tmpdir(), 'crew-slots-'));
  const dirA = join(slots, 'a');
  const dirB = join(slots, 'b');
  const live = () => true;
  const a1 = claimSlot('claude@pc', { dir: dirA, pid: 101, isAlive: live });
  const b1 = claimSlot('claude@pc', { dir: dirB, pid: 202, isAlive: live });
  const a2 = claimSlot('claude@pc', { dir: dirA, pid: 303, isAlive: live });
  assert.deepEqual([a1.id, b1.id, a2.id], ['claude@pc', 'claude@pc', 'claude@pc#2']);
  assert.deepEqual(liveSlots('claude@pc', { dir: dirB, isAlive: live }), ['claude@pc'], 'repo B sees one session: no ambiguous_agent');
  assert.deepEqual(liveSlots('claude@pc', { dir: dirA, isAlive: live }), ['claude@pc', 'claude@pc#2']);
  claimSlot('codex@pc', { dir: dirA, pid: 404, isAlive: live });
  assert.deepEqual(allLiveSlots({ dir: dirA, isAlive: live }), ['claude@pc', 'claude@pc#2', 'codex@pc'], 'crew doctor lists every session of the repo');
});

test('SemVer: a release candidate is older than its release', () => {
  const order = ['0.12.9', '0.13.0-alpha', '0.13.0-alpha.1', '0.13.0-alpha.beta', '0.13.0-beta.2', '0.13.0-beta.11', '0.13.0-rc.1', '0.13.0', '0.13.1', '1.0.0'];
  for (let i = 0; i < order.length - 1; i++) {
    assert.equal(compareSemver(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compareSemver(order[i + 1], order[i]), 1);
  }
  assert.equal(compareSemver('v0.13.0', '0.13.0+build.5'), 0);
  assert.equal(compareSemver('0.13', '0.13.0'), null);
  assert.deepEqual(parseVersion('0.13.0-rc.1'), { core: [0, 13, 0], pre: ['rc', '1'] });
  assert.equal(compareVersions('0.13.0-rc.1', '0.13.0'), -1);
});

test('the version gate understands pre-releases: stamp, pin and outdated_crew', () => {
  assert.equal(pinnedVersion('@gredescerber/agent-crew@0.13.0-rc.1'), '0.13.0-rc.1');
  assert.equal(pinnedVersion('github:GredesCerber/agent-crew#v0.13.0-rc.2'), '0.13.0-rc.2');
  assert.equal(prCrewVersion('<!-- crew:pr version=0.13.0-rc.1 -->'), '0.13.0-rc.1');
  const pr = (used, required) => evaluateGuard({ body: `Closes #1\n\n**Agent:** \`claude@pc\`\n<!-- crew:pr version=${used} -->`, requiredVersion: required, headSha: 'abc1234', config: {} });
  const outdated = (r) => r.problems.some((p) => p.rule === 'outdated_crew');
  assert.ok(outdated(pr('0.13.0-rc.1', '0.13.0')), 'an rc PR is older than the pinned release');
  assert.ok(!outdated(pr('0.13.0', '0.13.0-rc.1')), 'the release satisfies a pinned rc');
  assert.ok(!outdated(pr('0.13.0-rc.2', '0.13.0-rc.2')));
});
