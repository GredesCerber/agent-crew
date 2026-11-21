// crew merge-ready [--dry_run] — merge every PR that is ready (review done, check and crew-guard green) but that
// GitHub auto-merge will not merge itself (risk:high, or auto-merge not enabled). Deterministic, no LLM:
// the sweep job runs it every 15 minutes, so merging no longer depends on an agent session with usage limits.
import { ok } from '../core/output.js';
import { gh, ghJson } from '../core/exec.js';
import { loadConfig } from '../core/config.js';
import { prQueue } from '../core/queue.js';

const PR_FIELDS = 'number,title,body,headRefOid,createdAt,isDraft,author,labels,comments,statusCheckRollup,mergeable,isCrossRepository,autoMergeRequest';

export default {
  name: 'merge-ready',
  summary: 'Merge PRs that are ready (review + green check and crew-guard) but are not auto-merged; for the scheduled CI job',
  agent: false,
  args: [{ name: 'dry_run', type: 'boolean', description: 'only list what would be merged' }],
  run({ dry_run = false } = {}, deps = {}) {
    const { config, root } = deps.config ? { config: deps.config, root: '.' } : loadConfig();
    const prs = deps.prs ?? ghJson(['pr', 'list', '--state', 'open', '--limit', '50', '--json', PR_FIELDS], { cwd: root, allowFail: true }) ?? [];
    const ready = prQueue(prs, { me: 'crew-merge-ready', login: null, reviewers: [], config }).filter((x) => x.kind === 'merge' && !x.human);
    const merged = [];
    const failed = [];
    if (!dry_run) {
      for (const p of ready) {
        // --match-head-commit: merge exactly the reviewed commit; a push since then makes GitHub refuse the merge.
        const r = (deps.gh ?? gh)(['pr', 'merge', String(p.number), '--merge', '--delete-branch', ...(p.sha ? ['--match-head-commit', p.sha] : [])], { cwd: root, allowFail: true });
        (r.code === 0 ? merged : failed).push(r.code === 0 ? p.number : { pr: p.number, error: (r.stderr || r.stdout || '').split('\n')[0] });
      }
    }
    return ok(dry_run ? `Ready to merge: ${ready.map((p) => `#${p.number}`).join(', ') || 'none'}` : `Merged: ${merged.map((n) => `#${n}`).join(', ') || 'none'}${failed.length ? `; failed: ${failed.map((f) => `#${f.pr}`).join(', ')}` : ''}`, {
      status: failed.length ? 'warning' : 'success',
      artifacts: { ready: ready.map((p) => p.number), merged, failed },
    });
  },
};
