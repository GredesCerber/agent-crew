// Captain handover: who may act as captain when the captain (or the captain's agent, out of usage) is away.
// The repo owner picks the rule in crew.config.json → captain_handover (crew up asks, crew captain policy changes it):
//   off       only the captain plans, decides on ideas and gets questions for a human (the default);
//   deputies  the captain may hand the role to one of the listed deputies for a while;
//   team      the captain may hand it to anyone with write access.
//   fallback_hours > 0: if the captain shows no activity for that long, the first deputy acts automatically.
// Handovers are comments with markers in one issue labelled crew:captain; only the captain's own comments count.
// Pure helpers, no network.
import { parseMarkers } from './issues.js';

export const CAPTAIN_LABEL = 'crew:captain';
export const CAPTAIN_TITLE = 'crew captain: handover log';
export const HANDOVER_MODES = ['off', 'deputies', 'team'];
const lc = (s) => String(s ?? '').toLowerCase();

/** The rule with defaults filled in (a project without the key: off). */
export function handoverPolicy(config = {}) {
  const h = config.captain_handover ?? {};
  const mode = HANDOVER_MODES.includes(h.mode) ? h.mode : 'off';
  const deputies = [...new Set((Array.isArray(h.deputies) ? h.deputies : []).map((d) => String(d).replace(/^@/, '')).filter(Boolean))];
  const hours = Number(h.fallback_hours);
  return { mode, deputies, fallback_hours: mode !== 'off' && Number.isFinite(hours) && hours > 0 ? hours : 0 };
}

/** The rule in plain words, for the repo owner (crew up) and anyone running crew captain. */
export function explainPolicy(config = {}) {
  const p = handoverPolicy(config);
  const cap = config.captain ? `@${config.captain}` : 'the captain';
  const lines = [`Captain: ${cap}. Only the captain plans (kickoff), accepts or rejects ideas, and gets questions that need a human.`];
  if (p.mode === 'off') lines.push('Handover: off. Nobody else can act as captain; if the captain is away, those things wait.');
  if (p.mode === 'deputies') lines.push(`Handover: to deputies only (${p.deputies.length ? p.deputies.map((d) => `@${d}`).join(', ') : 'none listed yet'}). The captain runs "crew captain handoff @login --hours N"; it ends by itself or with "crew captain back".`);
  if (p.mode === 'team') lines.push('Handover: to anyone with write access. The captain runs "crew captain handoff @login --hours N"; it ends by itself or with "crew captain back".');
  if (p.fallback_hours) lines.push(`Automatic: if the captain shows no activity for ${p.fallback_hours} h, ${p.deputies[0] ? `@${p.deputies[0]}` : 'the first deputy'} acts as captain until the captain is back.`);
  lines.push('Change it: crew captain policy --mode off|deputies|team [--deputies a,b] [--fallback_hours N] (a change of crew.config.json, reviewed by a human).');
  return lines;
}

/** May the captain hand the role to login under this rule? -> null or the reason it may not. */
export function handoffProblem(login, config = {}, { members = [] } = {}) {
  const p = handoverPolicy(config);
  const who = lc(String(login ?? '').replace(/^@/, ''));
  if (!who) return 'whom to hand over to: crew captain handoff @login';
  if (who === lc(config.captain)) return 'that is the captain already';
  if (p.mode === 'off') return 'handover is off in crew.config.json (captain_handover.mode)';
  if (p.mode === 'deputies' && !p.deputies.some((d) => lc(d) === who)) return `@${who} is not a deputy (${p.deputies.join(', ') || 'none listed'})`;
  if (p.mode === 'team' && members.length && !members.some((m) => lc(m) === who)) return `@${who} has no write access to this repo`;
  return null;
}

export const handoffMarker = ({ to, until }) => `<!-- crew:handoff to=${to} until=${until} -->`;
export const handbackMarker = () => '<!-- crew:handback -->';

/**
 * Who acts as captain now (pure). comments: comments of the crew:captain issue; captainActiveAt: the captain's last
 * activity (ISO) or null when unknown. -> { login, why: 'captain'|'handoff'|'fallback', until? }
 * Only the captain's own handoff/handback comments count, and a handoff to someone the rule does not allow is ignored.
 */
export function actingCaptain({ config = {}, comments = [], captainActiveAt = null, members = [], now = Date.now() } = {}) {
  const captain = config.captain ?? null;
  const p = handoverPolicy(config);
  if (!captain || p.mode === 'off') return { login: captain, why: 'captain' };
  const own = comments.filter((c) => lc(c.author?.login) === lc(captain));
  const last = parseMarkers(own).filter((m) => m.kind === 'handoff' || m.kind === 'handback').pop();
  if (last?.kind === 'handoff') {
    const until = Date.parse(last.until ?? '');
    if (Number.isFinite(until) && until > now && !handoffProblem(last.to, config, { members })) {
      return { login: last.to, why: 'handoff', until: new Date(until).toISOString() };
    }
  }
  const quiet = captainActiveAt ? now - Date.parse(captainActiveAt) : NaN;
  if (p.fallback_hours && p.deputies[0] && Number.isFinite(quiet) && quiet > p.fallback_hours * 3_600_000) {
    return { login: p.deputies[0], why: 'fallback' };
  }
  return { login: captain, why: 'captain' };
}

/** Captain powers: the captain always, plus whoever acts as captain now. A team without a captain: anyone. */
export function hasCaptainPowers(login, config = {}, acting = null) {
  if (!config.captain) return true;
  const me = lc(login);
  return !!me && (me === lc(config.captain) || (!!acting?.login && me === lc(acting.login)));
}
