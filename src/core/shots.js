// Before/after screenshots for tasks that change how the product looks.
// The executor takes "before" at the start of the task (base code) and "after" when done;
// `crew pr open` embeds both into the PR so reviewers and humans see the visual change.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SHOTS_DIR = '.crew/shots';
export const PHASES = ['before', 'after'];

/** Files whose change usually changes what users see. */
const UI_RE = [
  /^web\//, /^design\//, /^app\//, /^frontend\//, /^ui\//,
  /\.(css|scss|sass|less|styl|html|htm|vue|svelte|tsx|jsx)$/i,
];
export const isUiFile = (p) => {
  const f = String(p).replace(/\\/g, '/');
  return !/(^|\/)(tests?|__tests__|e2e)\//.test(f) && !/\.(test|spec)\.[jt]sx?$/.test(f) && UI_RE.some((re) => re.test(f));
};
export const uiFiles = (files = []) => files.filter(isUiFile);

/** Screen name: letters, digits, dash. Used as part of a file name. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Only plain http(s) URLs without characters a shell could interpret. Rejected on the RAW input
 * (not after URL encoding): quotes, backtick, $, \, whitespace, < > | ; and % ^ ! (cmd.exe expands
 * %VAR% even inside double quotes).
 */
export function safeUrl(url) {
  if (/[\s"'`$\\<>|;%^!]/.test(String(url))) return null;
  try {
    const u = new URL(String(url));
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    const s = u.toString();
    return /^[A-Za-z0-9:/?#[\]@!$&()*+,;=%._~-]+$/.test(s) && !/[`$"'\\]/.test(s) ? s : null;
  } catch {
    return null;
  }
}

export const shotPath = (id, name, phase) => `${SHOTS_DIR}/${id}/${name}-${phase}.png`;

/** Playwright CLI command line (run through the shell so npx resolves on Windows). */
export function captureCommand({ url, file, width = 1280, height = 800 }) {
  return `npx --yes playwright screenshot --full-page --viewport-size=${Number(width)},${Number(height)} "${url}" "${file}"`;
}

/** Shots present for a task: { name: { before: path|null, after: path|null } }. */
export function listShots(root, id) {
  const dir = join(root, SHOTS_DIR, String(id));
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const m = /^([a-z0-9][a-z0-9-]*)-(before|after)\.png$/.exec(f);
    if (!m) continue;
    (out[m[1]] ??= { before: null, after: null })[m[2]] = `${SHOTS_DIR}/${id}/${f}`;
  }
  return out;
}

/** Markdown section for the PR body. Images are pinned to the head commit so links survive branch deletion. */
export function shotsSection({ repo, sha, shots }) {
  const names = Object.keys(shots).sort();
  if (!names.length) return '';
  const img = (p) => (p ? `![](https://github.com/${repo}/blob/${sha}/${p}?raw=true)` : '_missing_');
  const rows = names.map((n) => `| ${n} | ${img(shots[n].before)} | ${img(shots[n].after)} |`);
  return ['## Before / After', '', '| Screen | Before | After |', '|---|---|---|', ...rows, ''].join('\n');
}
