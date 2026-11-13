// Tests of the protective mechanisms without network or GitHub: labels, crew.yml, crew-guard.yml, the crew github setup plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { planSetup, DEFAULT_HARNESS, REQUIRED_CHECKS, ACTIONS_APP_ID } from '../src/commands/github.js';
import { allLabels } from '../src/commands/labels.js';
import { agentCommands, findCommand } from '../src/core/registry.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

const ROOT = join(import.meta.dirname, '..');
const CREW = join(ROOT, 'bin', 'crew.js');
const crew = (args, cwd) => {
  const r = spawnSync(process.execPath, [CREW, ...args, '--json'], { cwd, encoding: 'utf8' });
  return { code: r.status, out: JSON.parse(r.stdout) };
};
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

test('init: no CODEOWNERS and no manual approval labels - crew-guard holds the rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-guard-'));
  const proj = join(dir, 'demo');
  const r = crew(['init', proj], dir);
  assert.equal(r.out.status, 'success', JSON.stringify(r.out));
  assert.ok(!existsSync(join(proj, '.github', 'CODEOWNERS')), 'CODEOWNERS is no longer needed');
  assert.ok(existsSync(join(proj, '.github', 'workflows', 'crew-guard.yml')), 'no crew-guard.yml');
  assert.ok(!r.out.next_actions.some((a) => a.includes('CODEOWNERS')));
});

test('labels.json: no *-change-approved labels (a human is not an approve button)', () => {
  const labels = JSON.parse(read('templates', 'labels.json'));
  assert.ok(!labels.some((x) => /change-approved/.test(x.name)));
  for (const l of labels) assert.ok(l.description.length <= 100, `${l.name}: GitHub limits a description to 100 characters`);
});

test('crew.yml: no pr-rules, harness from GitHub Packages, check on a PR takes crew.config.json from base', () => {
  const yml = read('templates', 'product', '.github', 'workflows', 'crew.yml');
  assert.ok(!yml.includes('change-approved'));
  assert.ok(!yml.includes('\n  pr-rules:'));
  assert.ok(yml.includes('npm install -g --allow-git=all "${{ vars.CREW_HARNESS }}"'));
  assert.ok(!yml.includes('npm.pkg.github.com') && !yml.includes('PACKAGES_TOKEN'), 'public install: no registry, no token');
  assert.doesNotMatch(yml, /packages: read/);

  const check = yml.slice(yml.indexOf('  check:'), yml.indexOf('  sweep:'));
  const swap = check.indexOf('git show "$BASE_SHA:crew.config.json" > crew.config.json');
  assert.ok(swap > 0, 'check does not take crew.config.json from base');
  assert.ok(swap < check.indexOf('run: crew check --json'), 'the config swap must come before crew check');
  const swapStep = check.slice(check.lastIndexOf('- name:', swap), swap);
  assert.ok(swapStep.includes("if: github.event_name == 'pull_request'"));
});

test('crew-guard.yml: from main (pull_request_target/issue_comment), does not take PR code, sets a status', () => {
  const yml = read('templates', 'product', '.github', 'workflows', 'crew-guard.yml');
  assert.ok(yml.includes('\n  pull_request_target:\n'));
  assert.ok(yml.includes('\n  issue_comment:\n'));
  assert.ok(!yml.includes('\n  pull_request:\n'), 'a plain pull_request would take the workflow from the PR branch');
  assert.match(yml, /statuses: write/);
  assert.ok(!/contents: write|issues: write|pull-requests: write/.test(yml), 'no extra write permissions');
  // checkout without a ref: only code from main is executed
  const co = yml.slice(yml.indexOf('actions/checkout@v4')).split('\n').slice(0, 2).join('\n');
  assert.ok(!co.includes('ref:'), 'checkout must not take the PR ref');
  assert.ok(!yml.includes('head.sha') && !yml.includes('head.ref'), 'the PR branch code is not downloaded');
  assert.ok(yml.includes('crew guard --pr "$PR" --report --json'));
  assert.ok(yml.includes("contains(github.event.comment.body, 'crew:review')"));
});

test('planSetup: main protection with a required check from GitHub Actions', () => {
  const plan = planSetup({ repo: 'acme/app', labels: [] });
  const bp = plan.find((s) => s.id === 'branch-protection:main');
  assert.equal(bp.method, 'PUT');
  assert.equal(bp.path, 'repos/acme/app/branches/main/protection');
  const contexts = bp.body.required_status_checks.checks.map((c) => c.context);
  assert.ok(contexts.includes('check'), 'no required check');
  assert.deepEqual(contexts, REQUIRED_CHECKS);
  assert.ok(bp.body.required_status_checks.checks.every((c) => c.app_id === ACTIONS_APP_ID));
  assert.ok(bp.body.required_pull_request_reviews, 'main only via PR');
  assert.equal(bp.body.required_pull_request_reviews.require_code_owner_reviews, false);
  assert.equal(bp.body.required_pull_request_reviews.required_approving_review_count, 0);
  assert.deepEqual(REQUIRED_CHECKS, ['check', 'crew-guard']);
  assert.equal(bp.body.allow_force_pushes, false);
  // all fields required for PUT .../protection are present (null is a valid value)
  for (const k of ['required_status_checks', 'enforce_admins', 'required_pull_request_reviews', 'restrictions']) {
    assert.ok(k in bp.body, `no field ${k}`);
  }
});

test('planSetup: the CREW_HARNESS variable - upsert, default value and from an argument', () => {
  const v = planSetup({ repo: 'acme/app' }).find((s) => s.id === 'variable:CREW_HARNESS');
  assert.equal(v.method, 'PATCH');
  assert.equal(v.path, 'repos/acme/app/actions/variables/CREW_HARNESS');
  assert.deepEqual(v.body, { name: 'CREW_HARNESS', value: DEFAULT_HARNESS });
  const pkg = JSON.parse(read('package.json'));
  assert.equal(DEFAULT_HARNESS, `github:GredesCerber/agent-crew#v${pkg.version}`, 'pinned tag');
  assert.equal(pkg.publishConfig, undefined);
  assert.deepEqual(v.if_missing, { method: 'POST', path: 'repos/acme/app/actions/variables', body: v.body });
  const custom = planSetup({ repo: 'acme/app', harness: 'github:org/fork' }).find((s) => s.id === 'variable:CREW_HARNESS');
  assert.equal(custom.body.value, 'github:org/fork');
});

test('planSetup: labels from allLabels, the name in the path is escaped, creation on 404', () => {
  const labels = allLabels(DEFAULT_CONFIG);
  const plan = planSetup({ repo: 'acme/app', labels });
  const steps = plan.filter((s) => s.id.startsWith('label:'));
  assert.equal(steps.length, labels.length);
  const ready = steps.find((s) => s.id === 'label:status:ready');
  assert.equal(ready.method, 'PATCH');
  assert.equal(ready.path, 'repos/acme/app/labels/status%3Aready');
  assert.equal(ready.body.new_name, 'status:ready');
  assert.equal(ready.if_missing.method, 'POST');
  assert.equal(ready.if_missing.body.name, 'status:ready');
});

test('planSetup is idempotent: deterministic, only PUT/PATCH (+POST only when the object does not exist)', () => {
  const args = { repo: 'acme/app', labels: allLabels(DEFAULT_CONFIG), harness: 'github:x/y' };
  assert.deepEqual(planSetup(args), planSetup(args));
  for (const s of planSetup(args)) {
    assert.ok(['PUT', 'PATCH'].includes(s.method), `${s.id}: ${s.method}`);
    if (s.if_missing) assert.equal(s.if_missing.method, 'POST');
  }
  assert.equal(planSetup({ ...args, branch: 'release' }).at(-1).path, 'repos/acme/app/branches/release/protection');
});

test('crew github setup: dry-run by default returns artifacts.plan, humans only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-gh-'));
  const r = crew(['github', 'setup', '--repo', 'acme/app'], dir);
  assert.equal(r.out.status, 'success', JSON.stringify(r.out));
  assert.equal(r.out.artifacts.apply, false);
  assert.ok(r.out.artifacts.plan.some((s) => s.id === 'branch-protection:main'));
  assert.ok(r.out.next_actions[0].includes('--apply'));
  const bad = crew(['github', 'setup', '--repo', 'not a repo'], dir);
  assert.equal(bad.out.error.code, 'bad_input');
  assert.equal(findCommand(['github', 'setup']).agent, false);
  assert.ok(!agentCommands.some((c) => c.name === 'github setup'), 'github setup must not end up in MCP');
});
