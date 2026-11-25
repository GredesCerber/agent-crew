// Versions as SemVer 2.0 orders them, pre-releases included: 0.13.0-rc.1 < 0.13.0-rc.2 < 0.13.0 < 0.13.1.
// Pure functions, no dependencies: the version gate (outdated_crew), the PR stamp and crew up --join use them.

/** A version in text: 1.2.3 or 1.2.3-rc.1 (an optional leading v; build metadata after + is ignored). */
export const VERSION_RE = /v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?/;

/** → { core: [major, minor, patch], pre: [identifiers] } or null. */
export function parseVersion(v) {
  const m = new RegExp(`^${VERSION_RE.source}$`).exec(String(v ?? '').trim());
  if (!m) return null;
  return { core: m.slice(1, 4).map(Number), pre: m[4] ? m[4].split('.') : [] };
}

/** -1 / 0 / 1 as SemVer orders a and b; null when either is not a version. */
export function compareSemver(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  // a pre-release comes before its release
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1; // fewer identifiers sort first (rc < rc.1)
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) > Number(q) ? 1 : -1; continue; }
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}
