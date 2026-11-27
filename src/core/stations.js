// The factory's stations and the skill kit of each. A piece of work moves queue → build → review → merge; research
// (discovery) is build work on a question instead of code. Each station has a kit: the skills an agent there should
// reach for. crew task next names the kit with the work it hands out, so an agent with 20 skills loaded knows which
// 3–6 matter now. Kits only list skills the project has (agents/skills); `crew skills add` brings missing ones.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_ROOT } from './config.js';
import { projectSkills } from '../commands/skills.js';

export const STATIONS = ['build', 'review', 'research'];

/** The station a crew task next item belongs to. → 'build' | 'review' | 'research' | null (merges, questions). */
export function stationOf(artifacts = {}) {
  if (artifacts?.kind === 'review') return 'review';
  if (['task', 'fix', 'resume'].includes(artifacts?.kind)) return artifacts.area === 'research' ? 'research' : 'build';
  return null;
}

const eccRoles = () => {
  try { return JSON.parse(readFileSync(join(HARNESS_ROOT, 'ecc', 'profile.json'), 'utf8')).roles ?? {}; } catch { return {}; }
};

/** Default kits: crew's own skill for the station, then ECC's picks for the matching role (ecc/profile.json). */
export function defaultKits(roles = eccRoles()) {
  const common = roles.common ?? [];
  return {
    build: ['crew-workflow', ...(roles.builder ?? []), ...(roles.qa ?? []), ...common],
    review: ['crew-review', ...(roles.reviewer ?? []), ...common],
    research: ['crew-discovery', 'crew-workflow', 'deep-research', 'search-first', 'documentation-lookup', ...common],
  };
}

/**
 * The kit of a station for this project: crew.config.json stations.<name>.skills, or the default, kept to the
 * skills the project has. → { station, skills, missing }
 */
export function kitFor(station, { config = {}, present }) {
  const want = config.stations?.[station]?.skills ?? defaultKits()[station] ?? [];
  const uniq = [...new Set(want)];
  return { station, skills: uniq.filter((s) => present.has(s)), missing: uniq.filter((s) => !present.has(s)) };
}

/** The skills the project has, by name. */
export const presentSkills = (root) => new Set(root && existsSync(join(root, 'agents', 'skills')) ? projectSkills(root).map((s) => s.name) : []);

/** A crew task next result with the station and its kit added (artifacts.kit and one next action). */
export function withKit(result, { config, root, present }) {
  const station = stationOf(result?.artifacts);
  if (!station || result.status === 'error') return result;
  const kit = kitFor(station, { config, present: present ?? presentSkills(root) });
  const line = kit.skills.length ? `station ${station}: use the skills ${kit.skills.join(', ')}` : null;
  return {
    ...result,
    artifacts: { ...result.artifacts, kit: { station, skills: kit.skills } },
    next_actions: line ? [...(result.next_actions ?? []), line] : result.next_actions,
  };
}
