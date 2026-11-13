// Task lease from inside working commands (crew check, crew commit, crew pr open).
// 1) Renews the lease itself (heartbeat) so an agent working silently for a long time does not lose the task.
// 2) Checks the task is still mine: if sweep returned it to the queue and another agent took it,
//    committing and opening a PR is not allowed, otherwise two agents would open two PRs for one task.
import { viewIssue, comment, currentOwner, ownerActivityAt, marker } from './issues.js';

/** At most one heartbeat comment per this many minutes. */
export const HEARTBEAT_EVERY_MIN = 5;

/**
 * -> { state: 'ok' | 'lost' | 'unknown', owner, heartbeat, error }
 *   ok      - the task is mine (heartbeat: whether a renewal marker was posted);
 *   lost    - another owner, or the task went back to the queue;
 *   unknown - GitHub unavailable (no network, no gh); do not block work, only warn.
 * view/post are replaced in tests.
 */
export function checkLease({ id, me, view = viewIssue, post = comment, now = Date.now(), heartbeat = true, everyMin = HEARTBEAT_EVERY_MIN }) {
  let issue;
  try {
    issue = view(id);
  } catch (e) {
    return { state: 'unknown', owner: null, heartbeat: false, error: e?.recovery?.cause_hint || e?.message || String(e) };
  }
  if (!issue) return { state: 'unknown', owner: null, heartbeat: false, error: `issue #${id} not found` };
  const owner = currentOwner(issue.comments ?? []);
  if (!owner || owner.agent !== me) return { state: 'lost', owner: owner?.agent ?? null, heartbeat: false };
  let beat = false;
  const last = Date.parse(ownerActivityAt(issue.comments, owner) ?? '');
  if (heartbeat && (!Number.isFinite(last) || now - last > everyMin * 60_000)) {
    try {
      post(id, marker('heartbeat', { agent: me, at: new Date(now).toISOString() }));
      beat = true;
    } catch {
      /* renewal is best effort */
    }
  }
  return { state: 'ok', owner: owner.agent, heartbeat: beat };
}

/** Shared "task was taken" response for commit / pr open. */
export function leaseLostError(fail, id, lease, me) {
  return fail('lease_lost', `#${id} is no longer your task${lease.owner ? ` - held by ${lease.owner}` : ' - it was returned to the queue'}`, {
    cause_hint: `the lease expired (no activity for a long time) and the task went back to the queue; or CREW_AGENT (${me}) differs from the one used at claim`,
    retry: `crew task claim ${id} - if the task is status:ready again; otherwise crew task next`,
    stop_when: 'another agent took the task: do not push your branch, leave a note in the issue about what you finished',
    next_actions: [`gh issue view ${id}`, `crew task claim ${id} (if ready)`, 'crew task next'],
  });
}
