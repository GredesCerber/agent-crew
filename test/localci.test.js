// Local CI (crew tick with Actions down): the check job runs on a team machine and posts the `check` status; main
// protection can be told to count statuses from any source. git, gh and crew check are stubbed; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { needsLocalCheck, installSteps, checkPr, localChecks } from '../src/core/localci.js';
import { planSetup, mergeProtection, ACTIONS_APP_ID } from '../src/commands/github.js';
import { defaultSteps } from '../src/commands/tick.js';

const pr = (over = {}) => ({ number: 7, headRefOid: 'h7', baseRefOid: 'b0', isDraft: false, isCrossRepository: false, statusCheckRollup: [], ...over });

test('which PRs get a local check: no drafts, no forks, nothing already reported on the head', () => {
  assert.equal(needsLocalCheck(pr()), true);
  assert.equal(needsLocalCheck(pr({ isDraft: true })), false);
  assert.equal(needsLocalCheck(pr({ isCrossRepository: true })), false, 'a fork never runs on a team machine');
  assert.equal(needsLocalCheck(pr({ statusCheckRollup: [{ context: 'check', state: 'PENDING' }] })), false, 'running elsewhere');
  assert.equal(needsLocalCheck(pr({ statusCheckRollup: [{ name: 'check', conclusion: 'FAILURE' }] })), false);
  assert.equal(needsLocalCheck(pr({ statusCheckRollup: [{ context: 'crew-guard', state: 'FAILURE' }] })), true);
  const seen = new Set(['/w/web/package-lock.json', '/w/api/package.json'].map((p) => join(p)));
  assert.deepEqual(installSteps('/w', (p) => seen.has(join(p))).map((s) => `${s.cwd}: ${s.run}`), ['web: npm ci --no-audit --no-fund', 'api: npm install --no-audit --no-fund']);
});

/** A fake git that records calls and answers the base config. */
const fakeGit = (calls, { fetch = 0 } = {}) => (args) => {
  calls.push(args.slice(0, 2).join(' '));
  if (args[0] === 'fetch') return { code: fetch, stdout: '' };
  if (args[0] === 'show') return { code: 0, stdout: '{"check":[{"name":"test","run":"npm test"}]}' };
  return { code: 0, stdout: '' };
};

test('one PR: pending, a throwaway worktree with the base crew.config.json, crew check, the result, cleanup', () => {
  const calls = [];
  const posted = [];
  const dir = mkdtempSync(join(tmpdir(), 'crew-lci-'));
  let config = null;
  const r = checkPr(pr(), '/repo', {
    git: fakeGit(calls), tmp: () => dir, exists: () => false,
    post: (sha, state, text) => posted.push([sha, state, text]),
    check: ({ cwd }) => { config = readFileSync(join(cwd, 'crew.config.json'), 'utf8'); return { status: 'success', summary: 'All checks green (test)' }; },
  });
  assert.equal(r.state, 'success');
  assert.deepEqual(posted.map((p) => p[1]), ['pending', 'success']);
  assert.equal(posted[1][0], 'h7');
  assert.match(posted[1][2], /All checks green/);
  assert.match(config, /npm test/, 'the check list comes from the base commit, as in crew.yml');
  assert.deepEqual(calls, ['fetch --quiet', 'worktree add', 'show b0:crew.config.json', 'worktree remove', 'worktree prune']);

  const red = checkPr(pr(), '/repo', { git: fakeGit([]), tmp: () => mkdtempSync(join(tmpdir(), 'crew-lci-')), exists: () => false, post: () => {}, check: () => ({ status: 'error', summary: 'Failed: test' }) });
  assert.deepEqual([red.state, red.description], ['failure', 'crew check: Failed: test']);
  const lost = checkPr(pr(), '/repo', { git: fakeGit([], { fetch: 1 }), tmp: () => mkdtempSync(join(tmpdir(), 'crew-lci-')), post: () => {}, check: () => assert.fail('no checkout, no check') });
  assert.equal(lost.state, 'error');
  const thrown = checkPr(pr(), '/repo', { git: fakeGit([]), tmp: () => mkdtempSync(join(tmpdir(), 'crew-lci-')), exists: () => false, post: () => {}, check: () => { throw new Error('not a crew project'); } });
  assert.equal(thrown.state, 'failure', 'a crash of crew check is a red check, not a silent pass');
});

test('all open PRs: only the ones that need it; tick adds the step only when asked or while Actions are down', async () => {
  const ran = [];
  const out = await localChecks({ root: '/repo', prs: [pr(), pr({ number: 8, isDraft: true }), pr({ number: 9, headRefOid: 'h9' })], deps: {
    git: fakeGit([]), tmp: () => mkdtempSync(join(tmpdir(), 'crew-lci-')), exists: () => false, post: () => {},
    check: () => { ran.push(1); return { status: 'success', summary: 'ok' }; },
  } });
  assert.equal(ran.length, 2);
  assert.match(out.summary, /checked 2 PR\(s\): #7 success, #9 success/);
  assert.deepEqual(defaultSteps().map(([n]) => n), ['sweep', 'guard', 'merge-ready', 'promote', 'digest']);
  assert.deepEqual(defaultSteps({ checks: true }).map(([n]) => n).slice(0, 3), ['sweep', 'checks', 'guard'], 'checks before crew-guard and merges');
});

test('github setup --local_checks: required checks from any source; switching back restores GitHub Actions', () => {
  const sources = (plan) => plan.at(-1).body.required_status_checks.checks.map((c) => c.app_id);
  assert.deepEqual(sources(planSetup({ repo: 'a/b' })), [ACTIONS_APP_ID, ACTIONS_APP_ID]);
  const local = planSetup({ repo: 'a/b', localChecks: true });
  assert.deepEqual(sources(local), [-1, -1]);
  const fromActions = { required_status_checks: { checks: [{ context: 'check', app_id: ACTIONS_APP_ID }, { context: 'crew-guard', app_id: ACTIONS_APP_ID }] } };
  assert.deepEqual(mergeProtection(local.at(-1).body, fromActions).blockers, [], 'loosening our own checks is allowed');
  const back = mergeProtection(planSetup({ repo: 'a/b' }).at(-1).body, { required_status_checks: { checks: [{ context: 'check', app_id: -1 }] } });
  assert.deepEqual([back.blockers, back.body.required_status_checks.checks.map((c) => c.app_id)], [[], [ACTIONS_APP_ID, ACTIONS_APP_ID]]);
  const other = mergeProtection(planSetup({ repo: 'a/b' }).at(-1).body, { required_status_checks: { checks: [{ context: 'check', app_id: 999 }] } });
  assert.equal(other.blockers.length, 1, 'a check of the same name from another app is still a conflict');
});
