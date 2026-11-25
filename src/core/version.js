// An outdated crew on a member's machine means fixes
// do not take effect until the person updates their clone. crew compares itself with the latest harness tag.
import { compareSemver } from './semver.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_ROOT } from './config.js';
import { run } from './exec.js';

export const LOCAL_VERSION = JSON.parse(readFileSync(join(HARNESS_ROOT, 'package.json'), 'utf8')).version;
const REPO = 'GredesCerber/agent-crew';
const CACHE = join(tmpdir(), 'crew-latest.json');
const TTL_MS = 60 * 60_000;

/** '0.2.10' > '0.2.9' (numbers, not strings). Not a version: null. */
export function compareVersions(a, b) {
  // SemVer order, pre-releases included: 0.13.0-rc.1 is older than 0.13.0
  return compareSemver(a, b);
}

/** Latest harness tag (via gh, cached for an hour in tmp). No network/access: null, does not interfere with work. */
export function latestVersion({ now = Date.now(), fetch = () => run('gh', ['api', `repos/${REPO}/tags`, '--jq', '.[].name'], { allowFail: true }), cache = CACHE } = {}) {
  try {
    const c = JSON.parse(readFileSync(cache, 'utf8'));
    if (now - c.at < TTL_MS && c.latest) return c.latest;
  } catch { /* no cache */ }
  const r = fetch();
  if (r.code !== 0) return null;
  const tags = r.stdout.split('\n').map((s) => s.trim()).filter((t) => compareVersions(t, '0.0.0') !== null);
  const latest = tags.sort((a, b) => compareVersions(b, a))[0]?.replace(/^v/, '') ?? null;
  if (latest) {
    try { writeFileSync(cache, JSON.stringify({ at: now, latest })); } catch { /* tmp unavailable: no cache */ }
  }
  return latest;
}

/** Advice to update if the local crew is older than the latest tag; otherwise null. */
export function updateHint({ local = LOCAL_VERSION, latest = latestVersion() } = {}) {
  if (!latest || compareVersions(local, latest) !== -1) return null;
  return `crew ${local} is outdated, ${latest} is available: git -C ~/agent-crew fetch --tags && git -C ~/agent-crew checkout v${latest} (fixes do not take effect until you update)`;
}
