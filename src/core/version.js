// An outdated crew on a member's machine means fixes
// do not take effect until the person updates their clone. crew compares itself with the latest harness tag.
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
  const p = (v) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '')) ?? []).slice(1).map(Number);
  const x = p(a);
  const y = p(b);
  if (x.length !== 3 || y.length !== 3) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
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
