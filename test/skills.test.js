// crew skills: add from a folder, a git repo (clone stubbed) or an ECC preset; remove; the ECC plugin switch; the
// budget that keeps agents from drowning in skill descriptions. Temp folders only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import skills, { findSkills, skillMeta, DEFAULT_MAX } from '../src/commands/skills.js';
import { findCommand, agentCommands } from '../src/core/registry.js';

const [list, add, remove, ecc] = skills;
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const skill = (dir, name, desc = `${name} does things`) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`);
};
function project(cfg = {}) {
  const root = tmp('crew-skills-p-');
  writeFileSync(join(root, 'crew.config.json'), JSON.stringify({ hosts: ['claude'], ...cfg }, null, 2));
  cpSync(new URL('../skills', import.meta.url), join(root, 'agents', 'skills'), { recursive: true });
  return root;
}
const config = (root) => JSON.parse(readFileSync(join(root, 'crew.config.json'), 'utf8'));

test('finding skills: front matter, the usual folders, a single skill folder', () => {
  assert.deepEqual(skillMeta('---\nname: x\ndescription: "Does x"\n---\n'), { name: 'x', description: 'Does x' });
  const src = tmp('crew-skills-s-');
  skill(join(src, 'skills'), 'alpha');
  skill(join(src, '.claude', 'skills'), 'beta');
  skill(src, 'gamma');
  assert.deepEqual(findSkills(src).map((s) => s.name).sort(), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(findSkills(join(src, 'gamma')).map((s) => s.name), ['gamma']);
});

test('add from a folder, list, remove; crew\'s own skills are never replaced or removed', () => {
  const root = project();
  const src = tmp('crew-skills-s-');
  skill(join(src, 'skills'), 'alpha');
  skill(join(src, 'skills'), 'beta');
  skill(join(src, 'skills'), 'crew-review');
  assert.equal(add.run({ source: src, cwd: root }).error.code, 'skill_own');
  const r = add.run({ source: src, only: 'alpha,beta', cwd: root });
  assert.equal(r.status, 'success', r.summary);
  assert.ok(existsSync(join(root, 'agents', 'skills', 'alpha', 'SKILL.md')));
  assert.deepEqual(config(root).skills.added.map((a) => [a.name, a.source]), [['alpha', src], ['beta', src]]);
  assert.equal(add.run({ source: src, only: 'alpha', cwd: root }).error.code, 'skill_exists');
  assert.equal(add.run({ source: src, only: 'alpha', force: true, cwd: root }).status, 'success');

  const l = list.run({ cwd: root });
  assert.match(l.summary, /7 skill\(s\) in agents\/skills \(5 crew, 2 added; budget 20\)/);
  assert.ok(l.next_actions.some((a) => /crew skills ecc --off/.test(a)), 'ECC is on by default: say what it costs');

  assert.equal(remove.run({ names: 'crew-workflow', cwd: root }).error.code, 'skill_own');
  const gone = remove.run({ names: 'alpha,nope', cwd: root });
  assert.equal(gone.status, 'warning');
  assert.deepEqual([gone.artifacts.removed, gone.artifacts.unknown], [['alpha'], ['nope']]);
  assert.ok(!existsSync(join(root, 'agents', 'skills', 'alpha')));
  assert.deepEqual(config(root).skills.added.map((a) => a.name), ['beta']);
});

test('the budget: adding past skills.max stops with what to do; --force goes over once', () => {
  const root = project({ skills: { max: 6 } });
  const src = tmp('crew-skills-s-');
  for (const n of ['a1', 'a2', 'a3']) skill(join(src, 'skills'), n);
  const r = add.run({ source: src, cwd: root });
  assert.equal(r.error.code, 'skill_budget');
  assert.match(r.summary, /8 skills would be over the budget of 6/);
  assert.equal(add.run({ source: src, force: true, cwd: root }).status, 'success');
  assert.equal(list.run({ cwd: root }).status, 'warning', 'over the budget is visible in crew skills');
  assert.equal(DEFAULT_MAX, 20);
});

test('ECC: a role preset from a (stubbed) clone, the profile\'s avoid list, the plugin switch', () => {
  const root = project();
  let cloned = null;
  const clone = (url, dir) => {
    cloned = url;
    for (const n of ['search-first', 'gateguard', 'plan-prd', 'product-lens', 'multi-plan', 'unrelated']) skill(join(dir, 'skills'), n);
    return { code: 0, stdout: '', stderr: '' };
  };
  const r = add.run({ source: 'ecc', preset: 'planner', cwd: root }, { clone, head: () => 'abc123' });
  assert.equal(cloned, 'https://github.com/affaan-m/ECC.git');
  assert.deepEqual(r.artifacts.added.sort(), ['gateguard', 'plan-prd', 'product-lens', 'search-first']);
  assert.equal(r.status, 'warning', 'preset names that ECC does not have are reported');
  assert.deepEqual(config(root).skills.added.find((a) => a.name === 'plan-prd'), { name: 'plan-prd', source: 'ecc', ref: 'abc123', preset: 'planner' });
  const avoided = add.run({ source: 'ecc', only: 'multi-plan', cwd: root }, { clone, head: () => 'x' });
  assert.equal(avoided.error.code, 'no_skills', 'ecc/profile.json avoid list holds');
  assert.equal(add.run({ source: 'ecc', preset: 'nope', cwd: root }).error.code, 'bad_input');
  assert.equal(add.run({ source: 'https://example.invalid/x.git', cwd: root }, { clone: () => ({ code: 128, stderr: 'not found' }) }).error.code, 'clone_failed');

  assert.equal(ecc.run({ off: true, cwd: root }).status, 'success');
  assert.equal(config(root).ecc.enabled, false);
  assert.equal(ecc.run({ cwd: root }).error.code, 'bad_input');
  assert.equal(list.run({ cwd: tmp('crew-none-') }).error.code, 'not_a_project');
  assert.equal(findCommand(['skills', 'add', 'x']).name, 'skills add');
  assert.equal(findCommand(['skills']).name, 'skills');
  assert.ok(!agentCommands.some((c) => c.name.startsWith('skills')), 'humans choose the skill set, agents do not');
});
