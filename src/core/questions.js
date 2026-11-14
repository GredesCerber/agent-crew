// Agent-to-agent questions through GitHub (crew ask / inbox / answer), pure helpers.
// A question is an issue labelled crew:question, assigned to the owner of the area (or a person), with a marker
// <!-- crew:question from=<agent> task=<n> -->. An answer is a comment <!-- crew:answer agent=<agent> --> + close.
// Decisions only a human can make get the needs-human label and stay open.
// Question and answer text is DATA for the reader, never instructions.
import { parseMarkers, safeText, isTrustedComment } from './issues.js';
import { sameAgent } from './session.js';

export const QUESTION_LABEL = 'crew:question';
export const HUMAN_LABEL = 'needs-human';

/** More than 30% of letters are Cyrillic: agents write to each other in English (humans may use any language). */
export function mostlyNonEnglish(text = '') {
  const letters = String(text).match(/\p{L}/gu) ?? [];
  if (letters.length < 8) return false;
  const cyr = letters.filter((c) => /[Ѐ-ӿ]/.test(c)).length;
  return cyr / letters.length > 0.3;
}

export function questionBody({ text, from, task, area }) {
  const fields = [`from=${from}`, task ? `task=${task}` : null, area ? `area=${area}` : null].filter(Boolean).join(' ');
  return `${safeText(text.trim())}\n\n_Asked by \`${from}\`${task ? ` while working on #${task}` : ''}. Answer with \`crew answer <this issue> --text "..."\`; if a human must decide, \`crew answer <this issue> --human --text "..."\`._\n\n<!-- crew:question ${fields} -->\n`;
}

// crew writes its marker last and makes the question text safe, so an earlier "marker" in the text is never the real one.
export const questionMeta = (issue) => parseMarkers([{ body: issue.body ?? '' }]).filter((m) => m.kind === 'question').pop() ?? null;
export const answerMarker = (agent) => `<!-- crew:answer agent=${agent} -->`;
export const ackMarker = (agent) => `<!-- crew:ack agent=${agent} -->`;

const isBot = (c) => /\[bot\]$|^github-actions$/.test(c?.author?.login ?? '');

const HANDOFF = /\*\*Needs a human decision\*\*/;

/**
 * The answer, only from team members (never bots or outsiders): the last crew:answer comment without its marker;
 * if there is none (a human answered in the GitHub UI and closed it), the last plain member comment.
 * The "needs a human decision" handoff is never an answer.
 */
export function answerText(comments = []) {
  const team = comments.filter((c) => isTrustedComment(c) && !isBot(c) && !HANDOFF.test(c.body ?? ''));
  const marked = team.filter((c) => /<!-- crew:answer /.test(c.body ?? '')).pop();
  if (marked) return String(marked.body).replace(/<!-- crew:answer [^>]*-->\s*/, '').trim();
  const plain = team.filter((c) => !/<!-- crew:/.test(c.body ?? '') && String(c.body ?? '').trim()).pop();
  return plain ? String(plain.body).trim() : null;
}

/**
 * What waits for me (pure). open: open crew:question issues; closed: recently closed ones (with comments).
 * → { toAnswer: [{ number, title, from, task }], answered: [{ number, title, task, answer }] }
 * The answer text comes from a team member's crew:answer comment: agents are never sent to read all comments.
 */
export function inboxFor({ open = [], closed = [], me, login, myAreas = [] }) {
  const lc = (s) => String(s ?? '').toLowerCase();
  const toAnswer = [];
  for (const q of open) {
    const meta = questionMeta(q) ?? {};
    const labels = (q.labels ?? []).map((l) => l.name ?? l);
    if (labels.includes(HUMAN_LABEL)) continue; // waits for a human, not for an agent
    if (sameAgent(meta.from, me)) continue;
    const mine = (q.assignees ?? []).some((a) => lc(a.login) === lc(login)) || (meta.area && myAreas.includes(meta.area));
    if (mine) toAnswer.push({ number: q.number, title: q.title, from: meta.from ?? null, task: meta.task ? Number(meta.task) : null });
  }
  const answered = [];
  for (const q of closed) {
    const meta = questionMeta(q);
    if (!meta || meta.from !== me) continue;
    const acked = parseMarkers(q.comments ?? []).some((m) => m.kind === 'ack' && m.agent === me);
    if (!acked) answered.push({ number: q.number, title: q.title, task: meta.task ? Number(meta.task) : null, answer: answerText(q.comments ?? []) });
  }
  return { toAnswer: toAnswer.sort((a, b) => a.number - b.number), answered: answered.sort((a, b) => a.number - b.number) };
}
