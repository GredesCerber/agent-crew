import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { pinnedId } from './session.js';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_CONFIG = {
  // Areas = directories. An agent with --area web only touches web/**.
  // e2e: acceptance and E2E tests, including tests/pending/** (test tasks for risk:high).
  areas: {
    web: ['web/**'],
    api: ['api/**'],
    contracts: ['contracts/**'],
    e2e: ['tests/e2e/**', 'tests/acceptance/**', 'tests/pending/**'],
    infra: ['infra/**', '.github/**'],
    // Not code: designer mockups and styles, researcher notes. Styles web/src/styles/** are shared with web.
    design: ['design/**', 'web/src/styles/**'],
    research: ['docs/research/**'],
  },
  // What `crew check` runs (in order). An empty string or missing entry means the step is skipped.
  check: [],
  // Task lease: how many minutes without activity before the task returns to the queue.
  lease_minutes: 45,
  // Model tiers -> concrete models per vendor (crew worker passes them to --model). Codex: Sol -> Terra -> Luna.
  tiers: {
    high: { claude: 'opus', codex: 'gpt-6.1-sol' },
    mid: { claude: 'sonnet', codex: 'gpt-6.1-terra' },
    low: { claude: 'haiku', codex: 'gpt-6-luna' },
  },
  hosts: ['claude', 'codex'],
  // Agent review instead of a human approve button (checked by crew guard / the crew-guard status).
  // Who reviews first is the review area in the PRD crew-team block (usually the captain); crew task next gives them PRs before tasks.
  //   require: other-vendor means a reviewer from another vendor; other-agent means any other agent (team with Claude only).
  //   Default is other-vendor when there is more than one host. If no other-vendor reviewer shows up within fallback_minutes,
  //   any other agent counts (so PRs do not hang).
  review: { approvals: 1, approvals_high: 1, fallback_minutes: 30 },
  event: null, // path to events/<name>.json when a hackathon is running
};

/** Find crew.config.json walking up from cwd. Returns { config, root } (root = project root). */
export function loadConfig(cwd = process.cwd()) {
  let dir = resolve(cwd);
  for (;;) {
    const p = join(dir, 'crew.config.json');
    if (existsSync(p)) {
      const user = JSON.parse(readFileSync(p, 'utf8'));
      return { config: { ...DEFAULT_CONFIG, ...user }, root: dir, path: p };
    }
    const up = dirname(dir);
    if (up === dir) return { config: { ...DEFAULT_CONFIG }, root: resolve(cwd), path: null };
    dir = up;
  }
}

export function loadEvent(config, root) {
  if (!config.event) return null;
  const p = resolve(root, config.event);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** Short machine name for the agent id: "petya-laptop". */
export const machineName = () =>
  (hostname().split('.')[0] || 'host').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'host';

/**
 * Agent id: <vendor>[/<model>]@<machine>, e.g. claude@petya-laptop, codex/gpt-x@masha-pc.
 * CREW_AGENT sets vendor/model (adapters set it; for all Claude agents it is just "claude"),
 * the machine is appended automatically, otherwise three Claudes on three laptops would be one agent
 * (another agent's lease would be taken for your own, and review by "another agent" would be impossible).
 * For several sessions on one machine, give each its own CREW_AGENT_ID (claude@petya-2).
 */
export function agentId(env = process.env) {
  if (env.CREW_AGENT_ID) return env.CREW_AGENT_ID;
  // A task worktree remembers who claimed it (crew task claim), so CLI calls there act as the same session.
  if (env === process.env) {
    const pinned = pinnedId();
    if (pinned) return pinned;
  }
  const base = env.CREW_AGENT || 'human';
  return base.includes('@') ? base : `${base}@${machineName()}`;
}
