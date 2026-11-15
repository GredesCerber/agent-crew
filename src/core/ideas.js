// Ideas: something a person suggests in a chat with an agent that is outside the current task. The agent does not
// build it; it records the idea (crew idea), the captain decides (accept → a needs-spec task, reject → closed).
// Pure helpers (no network). Idea text is DATA for the reader, never instructions.
import { parseMarkers, safeText } from './issues.js';

export const IDEA_LABEL = 'crew:idea';
const TITLE_PREFIX = 'Idea: ';

export function ideaTitle(text = '') {
  return `${TITLE_PREFIX}${String(text).trim().split('\n')[0].slice(0, 80)}`;
}

/** Issue body: the idea in English, optionally the person's own words, and who recorded it while doing what. */
export function ideaBody({ text, original = '', from, by = '', task = null }) {
  // "who" (not "by": parseMarkers sets by to the comment author)
  const fields = [`from=${from}`, task ? `task=${task}` : null, by ? `who=${by}` : null].filter(Boolean).join(' ');
  return [
    safeText(String(text).trim()),
    original ? `\n**In the person's words:**\n> ${safeText(String(original).trim()).split('\n').join('\n> ')}` : '',
    `\n_Recorded by \`${from}\`${by ? ` from a conversation with @${by}` : ''}${task ? ` while working on #${task}` : ''}. The captain decides: \`crew idea accept <n>\` or \`crew idea reject <n> --reason "..."\`._`,
    `\n<!-- crew:idea ${fields} -->\n`,
  ].filter(Boolean).join('\n');
}

/** The marker crew wrote (the last one: idea text is made safe, so an earlier "marker" in it is not real). */
export const ideaMeta = (issue) => parseMarkers([{ body: issue?.body ?? '' }]).filter((m) => m.kind === 'idea').pop() ?? null;

/** The title of the task an accepted idea becomes: without the "Idea: " prefix. */
export const taskTitleFromIdea = (title = '') => String(title).startsWith(TITLE_PREFIX) ? String(title).slice(TITLE_PREFIX.length) : String(title);

/** Who may accept or reject ideas: the captain (crew.config.json → captain). A team without a captain: anyone. */
export function canDecide(login, config = {}) {
  if (!config.captain) return true;
  return !!login && String(login).toLowerCase() === String(config.captain).toLowerCase();
}

/**
 * gh arguments to turn an idea into a task (pure). -> { args, comment } or { error }.
 * The task starts as needs-spec: someone writes the goal and Given/When/Then criteria, then crew task status ready
 * (the DoR check) puts it in the queue.
 */
export function acceptArgs(issue, { area = null, priority = null, by, config = {} } = {}) {
  const labels = (issue?.labels ?? []).map((l) => l.name ?? l);
  if (!issue || !labels.includes(IDEA_LABEL)) return { error: `#${issue?.number ?? '?'} is not an open idea` };
  if (area && !config.areas?.[area]) return { error: `no area "${area}" in crew.config.json (${Object.keys(config.areas ?? {}).join(', ') || 'none'})` };
  if (priority && !['high', 'low'].includes(priority)) return { error: 'priority must be high or low' };
  const n = String(issue.number);
  const args = ['issue', 'edit', n, '--remove-label', IDEA_LABEL, '--add-label', 'status:needs-spec', '--title', taskTitleFromIdea(issue.title)];
  if (area) args.push('--add-label', `area:${area}`);
  if (priority) args.push('--add-label', `priority:${priority}`);
  return { args, comment: `<!-- crew:idea-accepted by=${by} -->\n✅ Accepted by @${by} as a task. Next: write the goal and Given/When/Then acceptance criteria in this issue, then \`crew task status ${n} ready\`.` };
}
