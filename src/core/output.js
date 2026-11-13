// Single response shape for all crew commands (schema crew/v1).
// Any agent (Claude, Codex, ...) gets the same thing: status, summary, next_actions, artifacts, error.

export const SCHEMA = 'crew/v1';

export function ok(summary, { next_actions = [], artifacts = {}, status = 'success' } = {}) {
  return { schema: SCHEMA, status, summary, next_actions, artifacts, error: null };
}

export function warn(summary, opts = {}) {
  return ok(summary, { ...opts, status: 'warning' });
}

/**
 * Error with a recovery contract: every error carries a cause hint,
 * a safe retry and a stop condition. There are no errors without next_actions.
 */
export function fail(code, summary, { cause_hint = '', retry = null, stop_when = '', next_actions = [], artifacts = {} } = {}) {
  return {
    schema: SCHEMA,
    status: 'error',
    summary,
    next_actions: next_actions.length ? next_actions : retry ? [retry] : ['stop and report in the issue'],
    artifacts,
    error: { code, cause_hint, retry, stop_when },
  };
}

export class CrewError extends Error {
  constructor(code, summary, recovery = {}) {
    super(summary);
    this.code = code;
    this.recovery = recovery;
  }
  toResult() {
    return fail(this.code, this.message, this.recovery);
  }
}

export function render(result, { json }) {
  if (json) return JSON.stringify(result, null, 2);
  const icon = { success: '✔', warning: '!', error: '✖' }[result.status] ?? '?';
  const lines = [`${icon} ${result.summary}`];
  if (result.error) {
    if (result.error.cause_hint) lines.push(`  cause:      ${result.error.cause_hint}`);
    if (result.error.stop_when) lines.push(`  stop if:    ${result.error.stop_when}`);
  }
  for (const [k, v] of Object.entries(result.artifacts ?? {})) {
    lines.push(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  if (result.next_actions?.length) {
    lines.push('  next:');
    for (const a of result.next_actions) lines.push(`    → ${a}`);
  }
  return lines.join('\n');
}
