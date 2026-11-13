// crew compliance check | disclosure — compliance with the event rules (event mode).
// Event rules live in events/<name>.json (start, end, ai_allowed, team_members, ...).
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, warn, fail } from '../core/output.js';
import { git, run } from '../core/exec.js';
import { loadConfig, loadEvent, HARNESS_ROOT } from '../core/config.js';

/** Commits with changes, excluding service merge commits: author date, author, Agent trailer. */
export function commits(root) {
  const out = git(['log', '--no-merges', '--format=%H%x1f%aI%x1f%ae%x1f%(trailers:key=Agent,valueonly,separator=%x2c)%x1e'], { cwd: root, allowFail: true });
  if (out.code !== 0) return [];
  return out.stdout.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, date, email, agent] = r.split('\x1f');
    return { sha, date, email, agent: (agent ?? '').trim() || null };
  });
}

/** Pure check function — the tests run it too. */
export function evaluate(event, list, prAuthors = []) {
  const problems = [];
  const warnings = [];
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const early = list.filter((c) => Date.parse(c.date) < start);
  const late = list.filter((c) => Date.parse(c.date) > end);
  if (early.length) problems.push(`commits before the start: ${early.length} (first ${early.at(-1).sha.slice(0, 7)})`);
  if (late.length) problems.push(`commits after the end: ${late.length}`);
  const agentCommits = list.filter((c) => c.agent && c.agent !== 'human');
  if (event.ai_allowed === false && agentCommits.length) problems.push(`AI is forbidden, but agent commits: ${agentCommits.length}`);
  const team = new Set((event.team_members ?? []).map((s) => s.toLowerCase()));
  if (team.size) {
    const outsiders = [...new Set(prAuthors.filter((a) => !team.has(a.toLowerCase())))];
    if (outsiders.length) problems.push(`PRs from humans outside the team: ${outsiders.join(', ')}`);
  } else {
    warnings.push('team_members is empty — team membership is not checked');
  }
  const noTrailer = list.filter((c) => !c.agent && Date.parse(c.date) >= start);
  if (noTrailer.length) problems.push(`commits without the Agent trailer: ${noTrailer.length} (use crew commit)`);
  return { problems, warnings, stats: { commits: list.length, agent_commits: agentCommits.length } };
}

const check = {
  name: 'compliance check',
  summary: 'Event mode: check the repo against the event rules (time window, team membership, AI use)',
  usesCwd: true,
  args: [],
  run({ cwd } = {}) {
    const { config, root } = loadConfig(cwd);
    const event = loadEvent(config, root);
    if (!event) {
      return warn('No event configured — nothing to check', {
        next_actions: ['fill in events/event.json and set "event": "events/event.json" in crew.config.json'],
      });
    }
    const pr = run('gh', ['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'author'], { cwd: root, allowFail: true });
    const authors = pr.code === 0 ? JSON.parse(pr.stdout || '[]').map((p) => p.author?.login).filter(Boolean) : [];
    const res = evaluate(event, commits(root), authors);
    if (res.problems.length) {
      return fail('compliance_violation', `Violations: ${res.problems.length}`, {
        cause_hint: res.problems.join('; '),
        stop_when: 'always — a human decides this; agents do not rewrite history',
        next_actions: ['tell the team captain', 'do not rewrite git history'],
        artifacts: res,
      });
    }
    return (res.warnings.length ? warn : ok)(`Compliance with the rules of "${event.name}": OK`, { artifacts: res });
  },
};

const disclosure = {
  name: 'compliance disclosure',
  summary: 'Generate DISCLOSURE.md: which tools and agents were used',
  agent: false,
  args: [],
  run() {
    const { config, root } = loadConfig();
    const event = loadEvent(config, root) ?? {};
    const list = commits(root);
    const byAgent = {};
    for (const c of list) byAgent[c.agent ?? 'unknown'] = (byAgent[c.agent ?? 'unknown'] ?? 0) + 1;
    const version = JSON.parse(readFileSync(join(HARNESS_ROOT, 'package.json'), 'utf8')).version;
    const md = [
      '# Disclosure',
      '',
      `Event: **${event.name ?? '—'}** (${event.start ?? '?'} — ${event.end ?? '?'})`,
      '',
      '## Tools',
      `- [agent-crew](${config.harness_url ?? 'https://github.com/<org>/agent-crew'}) v${version} — an open-source tool for coordinating agents (rules, templates, CLI). Contains no product code.`,
      `- AI agents: ${config.hosts.join(', ')}${config.ecc?.enabled !== false ? '; ECC plugin for Claude Code' : ''}.`,
      `- Stack generators: ${(config.scaffold ?? []).map((s) => '`' + s + '`').join(', ') || '—'}`,
      '',
      '## What was done before the event',
      '- Only tooling and public dependencies. All product code was written during the event.',
      '',
      '## Commit provenance',
      '| Agent / author | Commits |',
      '|---|---|',
      ...Object.entries(byAgent).map(([a, n]) => `| ${a} | ${n} |`),
      '',
      'Every agent commit carries an `Agent:` trailer and a link to the task (`Issue: #N`).',
      '',
    ].join('\n');
    writeFileSync(join(root, 'DISCLOSURE.md'), md);
    return ok('DISCLOSURE.md created', { artifacts: { path: join(root, 'DISCLOSURE.md'), by_agent: byAgent } });
  },
};

export default [check, disclosure];
