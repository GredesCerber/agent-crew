// gh issue / gh pr / gh repo / gh label over REST (Claude Code cloud sessions block GraphQL): the same JSON shape as
// gh --json, the same writes. A recording fake of `gh api` stands in for GitHub; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ghViaRest, parseGhArgs, REST_COMMANDS } from '../src/core/ghrest.js';
import { restMode } from '../src/core/exec.js';

/** A fake GitHub REST API: routes by "METHOD path" (query string stripped), records every call. */
function fakeApi(routes) {
  const calls = [];
  const api = (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    const hit = routes[key];
    if (hit === undefined) return { code: 1, data: null, stderr: `HTTP 404: Not Found (${key})` };
    const r = typeof hit === 'function' ? hit(path, body) : hit;
    return r && r.__error ? { code: 1, data: null, stderr: r.__error } : { code: 0, data: r, stderr: '' };
  };
  return { api, calls };
}
const REPO = { full_name: 'acme/shop', default_branch: 'main', visibility: 'public', permissions: { admin: false, push: true, pull: true } };
const user = (login) => ({ login });
const run = (args, routes, input) => {
  const f = fakeApi({ 'GET repos/{owner}/{repo}': REPO, 'GET user': user('alice'), ...routes });
  return { r: ghViaRest(args, { api: f.api, input }), calls: f.calls };
};
const json = (r) => JSON.parse(r.stdout);

test('args: flags with values, comma lists, booleans, the target', () => {
  assert.deepEqual(parseGhArgs(['issue', 'edit', '12', '--add-label', 'a,b', '--remove-label', 'c', '--add-label', 'd', '--force']), {
    group: 'issue', verb: 'edit', target: '12', flags: { '--add-label': ['a', 'b', 'd'], '--remove-label': ['c'], '--force': true },
  });
  assert.equal(ghViaRest(['repo', 'clone', 'a/b'], { api: () => ({}) }), null, 'not translated: the real gh runs');
  assert.ok(REST_COMMANDS.includes('issue list') && REST_COMMANDS.includes('pr merge'));
});

test('issue list: labels, state, no PRs, the fields gh --json gives, comments when asked', () => {
  const issues = [
    { number: 5, title: 'Task', body: 'b', state: 'open', state_reason: null, labels: [{ name: 'status:ready' }], assignees: [user('bob')], user: user('cap'), created_at: 'c', updated_at: 'u', html_url: 'h5' },
    { number: 6, title: 'A PR', state: 'open', pull_request: {}, labels: [] },
  ];
  const { r, calls } = run(['issue', 'list', '--state', 'open', '--label', 'status:ready', '--limit', '50', '--json', 'number,title,labels,assignees,updatedAt,comments'], {
    'GET repos/{owner}/{repo}/issues': issues,
    'GET repos/{owner}/{repo}/issues/5/comments': [{ body: '<!-- crew:claim agent=a -->', user: user('bob'), author_association: 'MEMBER', created_at: 't' }],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r), [{ number: 5, title: 'Task', labels: [{ name: 'status:ready' }], assignees: [{ login: 'bob' }], updatedAt: 'u', comments: [{ body: '<!-- crew:claim agent=a -->', author: { login: 'bob' }, authorAssociation: 'MEMBER', createdAt: 't' }] }]);
  assert.match(calls.find((c) => c.path.startsWith('repos/{owner}/{repo}/issues?')).path, /state=open&labels=status%3Aready&per_page=100&page=1/);
});

test('issue list --search uses the search API with the repo; states are upper-case like gh', () => {
  const { r, calls } = run(['issue', 'list', '--state', 'closed', '--search', 'closed:>=2026-11-20', '--json', 'number,stateReason,closedAt'], {
    'GET search/issues': { items: [{ number: 9, state: 'closed', state_reason: 'not_planned', closed_at: 'x' }] },
  });
  assert.deepEqual(json(r), [{ number: 9, stateReason: 'NOT_PLANNED', closedAt: 'x' }]);
  assert.match(decodeURIComponent(calls.find((c) => c.path.startsWith('search/')).path), /repo:acme\/shop is:issue is:closed closed:>=2026-11-20/);
});

test('issue create, edit, comment, close: the REST writes crew needs', () => {
  const created = run(['issue', 'create', '--title', 'Q', '--label', 'crew:question,area:web', '--body-file', '-', '--assignee', '@me'], {
    'POST repos/{owner}/{repo}/issues': (p, body) => ({ html_url: 'https://github.com/acme/shop/issues/42', echo: body }),
  }, 'the body from stdin');
  assert.equal(created.r.stdout, 'https://github.com/acme/shop/issues/42', 'crew reads the number from the URL');
  assert.deepEqual(created.calls.find((c) => c.method === 'POST').body, { title: 'Q', body: 'the body from stdin', labels: ['crew:question', 'area:web'], assignees: ['alice'] });

  const edited = run(['issue', 'edit', '7', '--add-label', 'status:claimed', '--remove-label', 'status:ready', '--remove-label', 'status:gone', '--add-assignee', '@me'], {
    'POST repos/{owner}/{repo}/issues/7/labels': [],
    'DELETE repos/{owner}/{repo}/issues/7/labels/status%3Aready': [],
    'POST repos/{owner}/{repo}/issues/7/assignees': {},
  });
  assert.equal(edited.r.code, 0, 'a label that is not there (404) is fine, as with gh');
  assert.deepEqual(edited.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), [
    'POST repos/{owner}/{repo}/issues/7/labels', 'DELETE repos/{owner}/{repo}/issues/7/labels/status%3Aready', 'DELETE repos/{owner}/{repo}/issues/7/labels/status%3Agone', 'POST repos/{owner}/{repo}/issues/7/assignees',
  ]);

  const closed = run(['issue', 'close', '40', '--reason', 'not planned', '--comment', 'Not now'], {
    'POST repos/{owner}/{repo}/issues/40/comments': { html_url: 'c' },
    'PATCH repos/{owner}/{repo}/issues/40': {},
  });
  assert.deepEqual(closed.calls.map((c) => c.method), ['POST', 'PATCH'], 'the comment first, then the close');
  assert.deepEqual(closed.calls[1].body, { state: 'closed', state_reason: 'not_planned' });

  const said = run(['issue', 'comment', '7', '--body', '<!-- crew:heartbeat agent=a -->'], { 'POST repos/{owner}/{repo}/issues/7/comments': { html_url: 'x' } });
  assert.equal(said.r.code, 0);
  assert.equal(run(['issue', 'pin', '3'], {}).r.code, 0, 'pinning is GraphQL-only: skipped, not a failure');
});

test('pr list: checks from check runs (latest per name) and statuses, mergeable, the author', () => {
  const pr = { number: 12, title: 'Fix', body: 'Closes #5', state: 'open', head: { sha: 'abc', ref: 'crew/5-x', repo: { full_name: 'acme/shop' } }, base: { sha: 'b0', repo: { full_name: 'acme/shop' } }, draft: false, user: user('bob'), labels: [{ name: 'risk:med' }], created_at: 't', html_url: 'u', auto_merge: null };
  const { r } = run(['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,headRefOid,isDraft,author,labels,statusCheckRollup,mergeable,isCrossRepository,autoMergeRequest'], {
    'GET repos/{owner}/{repo}/pulls': [pr],
    'GET repos/{owner}/{repo}/pulls/12': { ...pr, mergeable: false },
    'GET repos/{owner}/{repo}/commits/abc/check-runs': { check_runs: [
      { name: 'check', status: 'completed', conclusion: 'failure', started_at: '2026-11-26T10:00:00Z' },
      { name: 'check', status: 'completed', conclusion: 'success', started_at: '2026-11-26T11:00:00Z' },
    ] },
    'GET repos/{owner}/{repo}/commits/abc/statuses': [
      { context: 'crew-guard', state: 'pending', description: 'waiting for review' },
      { context: 'crew-guard', state: 'failure', description: 'older' },
    ],
  });
  const [p] = json(r);
  assert.deepEqual(p.statusCheckRollup.map((c) => [c.name ?? c.context, c.conclusion || c.state]), [['check', 'SUCCESS'], ['crew-guard', 'PENDING']]);
  assert.equal(p.statusCheckRollup[1].description, 'waiting for review');
  assert.deepEqual([p.mergeable, p.isDraft, p.author, p.isCrossRepository, p.autoMergeRequest], ['CONFLICTING', false, { login: 'bob' }, false, null]);
});

test('pr view by branch, pr create, pr merge (no auto-merge over REST), repo view with --jq, label create --force', () => {
  const pr = { number: 12, title: 'Fix', body: 'b', state: 'closed', merged_at: 'm', head: { sha: 'abc', ref: 'crew/5-x' }, html_url: 'https://github.com/acme/shop/pull/12' };
  const view = run(['pr', 'view', 'crew/5-x', '--json', 'url,state,number,body'], { 'GET repos/{owner}/{repo}/pulls': [pr] });
  assert.deepEqual(json(view.r), { url: pr.html_url, state: 'MERGED', number: 12, body: 'b' });
  assert.match(decodeURIComponent(view.calls.at(-1).path), /head=acme:crew\/5-x/);
  assert.match(run(['pr', 'view', 'nope', '--json', 'url'], { 'GET repos/{owner}/{repo}/pulls': [] }).r.stderr, /no pull requests found/);

  const created = run(['pr', 'create', '--head', 'crew/5-x', '--title', 'T (#5)', '--body', 'Closes #5'], { 'POST repos/{owner}/{repo}/pulls': { html_url: 'https://github.com/acme/shop/pull/13' } });
  assert.equal(created.r.stdout, 'https://github.com/acme/shop/pull/13');
  assert.equal(created.calls.find((c) => c.method === 'POST').body.base, 'main', 'the default branch');

  assert.match(run(['pr', 'merge', '12', '--auto', '--merge'], {}).r.stderr, /auto-merge needs GitHub GraphQL/);
  const merged = run(['pr', 'merge', '12', '--merge', '--delete-branch', '--match-head-commit', 'abc'], {
    'GET repos/{owner}/{repo}/pulls/12': pr, 'PUT repos/{owner}/{repo}/pulls/12/merge': { merged: true },
  });
  assert.equal(merged.r.code, 0, 'a refused branch deletion does not fail the merge');
  assert.deepEqual(merged.calls.find((c) => c.method === 'PUT').body, { merge_method: 'merge', sha: 'abc' });

  assert.equal(run(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {}).r.stdout, 'acme/shop');
  assert.equal(run(['repo', 'view', '--json', 'viewerPermission', '--jq', '.viewerPermission'], {}).r.stdout, 'WRITE');
  const label = run(['label', 'create', 'crew:pause', '--color', '000000', '--description', 'stop', '--force'], {
    'POST repos/{owner}/{repo}/labels': { __error: 'HTTP 422: Validation Failed (already_exists)' },
    'PATCH repos/{owner}/{repo}/labels/crew%3Apause': {},
  });
  assert.equal(label.r.code, 0, '--force updates a label that exists');
});

test('REST mode: in Claude Code cloud sessions, or on request; CREW_GH_REST=0 turns it off', () => {
  assert.equal(restMode({ CLAUDE_CODE_REMOTE: 'true' }), true);
  assert.equal(restMode({ CREW_GH_REST: '1' }), true);
  assert.equal(restMode({ CLAUDE_CODE_REMOTE: 'true', CREW_GH_REST: '0' }), false);
  assert.equal(restMode({}), false);
});

test('Claude adapter: a committed SessionStart hook installs crew in cloud sessions and does nothing elsewhere', async () => {
  const { default: claude, CLOUD_SETUP } = await import('../adapters/claude/adapter.js');
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const files = Object.fromEntries(claude.generate({ config: {}, roles: [], skills: [], frontmatter: () => ({ meta: {}, body: '' }), platform: 'linux' }).map((f) => [f.path, f]));
  const hook = JSON.parse(files['.claude/settings.json'].content).hooks.SessionStart[0].hooks[0];
  assert.equal(hook.type, 'command');
  assert.match(hook.command, /\.claude\/crew-cloud-setup\.mjs/);
  assert.equal(files['.claude/crew-cloud-setup.mjs'].commit, true, 'a cloud session starts from the committed repo');
  assert.equal(files['.claude/crew-cloud-setup.mjs'].content, CLOUD_SETUP);
  // outside a cloud session it exits at once, without calling gh or npm
  const script = join(mkdtempSync(join(tmpdir(), 'crew-cloud-')), 'setup.mjs');
  writeFileSync(script, CLOUD_SETUP);
  const env = { ...process.env, PATH: '' };
  delete env.CLAUDE_CODE_REMOTE;
  const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});
