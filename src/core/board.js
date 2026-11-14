// Task board for humans (crew board): see the queue and steer it by hand without spending agent tokens.
// Pure functions: the model shown on the page, and the gh arguments for each action the page can request.
import { labelValue, marker } from './issues.js';
import { prQueue } from './queue.js';
import { LOGIN_RE } from './prd.js';
import { digestModel } from './digest.js';

export const COLUMNS = ['ready', 'claimed', 'review', 'waiting', 'blocked', 'needs-spec'];
export const PRIORITIES = ['high', 'normal', 'low'];
/** Statuses a human may set from the board. claimed/review belong to the agent's lease and PR flow. */
export const BOARD_STATUSES = ['ready', 'blocked', 'needs-spec', 'waiting'];

const prio = (i) => labelValue(i, 'priority') ?? 'normal';

export function boardModel({ issues = [], prs = [], members = [], questions = [], team = null, config = {}, now = Date.now() } = {}) {
  const columns = Object.fromEntries(COLUMNS.map((c) => [c, []]));
  const other = [];
  for (const i of issues) {
    const status = labelValue(i, 'status');
    if ((i.labels ?? []).some((l) => l.name === 'epic')) continue;
    const card = {
      number: i.number,
      title: i.title,
      status,
      area: labelValue(i, 'area'),
      tier: labelValue(i, 'tier'),
      risk: labelValue(i, 'risk'),
      priority: prio(i),
      assignees: (i.assignees ?? []).map((a) => a.login),
      idle_min: Math.max(0, Math.round((now - Date.parse(i.updatedAt ?? '')) / 60000)) || 0,
    };
    (columns[status] ?? other).push(card);
  }
  const order = { high: 0, normal: 1, low: 2 };
  for (const c of COLUMNS) columns[c].sort((a, b) => order[a.priority] - order[b.priority] || a.number - b.number);
  const queue = prQueue(prs, { me: 'board', login: null, reviewers: [], config, now }).map((x) => ({
    kind: x.kind, number: x.number, title: x.title, risk: x.risk, age_min: x.age, reason: x.reason ?? null, have: x.have ?? null, need: x.need ?? null,
  }));
  // Captain panel: the same status crew digest posts to the pinned issue.
  const digest = digestModel({ issues, prs, questions, team, config, now });
  return { columns, untracked: other.length, prs: queue, digest, members: [...new Set(members)].sort((a, b) => a.localeCompare(b)), generated_at: new Date(now).toISOString() };
}

/**
 * gh arguments for one board action, or { error }. Everything is validated here because the page
 * is only a convenience: the server never passes page input to gh unchecked.
 * current: the issue as listed ({ number, labels, assignees }).
 */
export function actionArgs({ op, value }, current, { members = [] } = {}) {
  if (!current || !Number.isInteger(current.number)) return { error: 'unknown issue' };
  const n = String(current.number);
  const labels = (current.labels ?? []).map((l) => l.name);
  if (op === 'assign') {
    const to = String(value ?? '');
    const now = (current.assignees ?? []).map((a) => a.login);
    if (to && (!LOGIN_RE.test(to) || !members.some((m) => m.toLowerCase() === to.toLowerCase()))) return { error: `${to} is not a member of this repo` };
    const args = ['issue', 'edit', n];
    for (const a of now) if (a.toLowerCase() !== to.toLowerCase()) args.push('--remove-assignee', a);
    if (to && !now.some((a) => a.toLowerCase() === to.toLowerCase())) args.push('--add-assignee', to);
    return args.length > 3 ? { args } : { noop: true };
  }
  if (op === 'status') {
    const to = String(value ?? '');
    if (!BOARD_STATUSES.includes(to)) return { error: `status must be one of ${BOARD_STATUSES.join(', ')}` };
    const from = labels.filter((l) => l.startsWith('status:')).map((l) => l.slice(7));
    if (from.some((s) => s === 'claimed' || s === 'review')) {
      return { error: `#${n} is ${from.join(',')}: an agent holds it — use crew task release ${n} --force first` };
    }
    if (from.length === 1 && from[0] === to) return { noop: true };
    const args = ['issue', 'edit', n, '--add-label', `status:${to}`];
    for (const f of from) if (f !== to) args.push('--remove-label', `status:${f}`);
    // Back to the queue: also end any old claim (e.g. an agent that set blocked while holding it), as crew task release
    // does; otherwise agents get claim_conflict until that lease ages out.
    if (to === 'ready') return { args, comment: `${marker('release', { agent: 'crew-board', at: new Date().toISOString() })}\n↩️ Returned to the queue from crew board.` };
    return { args };
  }
  if (op === 'priority') {
    const to = String(value ?? '');
    if (!PRIORITIES.includes(to)) return { error: `priority must be one of ${PRIORITIES.join(', ')}` };
    const args = ['issue', 'edit', n];
    for (const l of labels.filter((x) => x.startsWith('priority:') && x !== `priority:${to}`)) args.push('--remove-label', l);
    if (to !== 'normal' && !labels.includes(`priority:${to}`)) args.push('--add-label', `priority:${to}`);
    return args.length > 3 ? { args } : { noop: true };
  }
  return { error: `unknown action ${op}` };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The board page. Data comes from /api/board; actions go to /api/action with the per-run token. */
export function renderPage({ token, repo }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>crew board — ${esc(repo)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2433;--muted:#667085;--line:#e3e6ec;--hi:#d92d20;--warn:#b54708;--good:#067647}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f26;--ink:#e6e9ef;--muted:#98a2b3;--line:#2a313b;--hi:#f97066;--warn:#fdb022;--good:#47cd89}}
*{box-sizing:border-box}body{margin:0;font:14px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
header h1{font-size:16px;margin:0}.muted{color:var(--muted)}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;padding:12px 16px}
section h2,#prs h2,.alerts h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:4px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:8px}
.card a{color:var(--ink);text-decoration:none;font-weight:600}.meta{color:var(--muted);font-size:12px;margin:4px 0 6px}
.prio-high{border-left:4px solid var(--hi)}.prio-low{opacity:.75}
.row{display:flex;gap:6px;flex-wrap:wrap}select{font:inherit;font-size:12px;padding:2px 4px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
#prs{padding:0 16px 16px}#prs a{color:var(--ink)}#prs li{margin:4px 0}#msg{color:var(--hi)}
#cap{padding:12px 16px 0}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px}.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.kpi span{color:var(--muted);font-size:12px}.kpi.bad{border-color:var(--hi)}.kpi.bad b{color:var(--hi)}.kpi.warn{border-color:var(--warn)}.kpi.warn b{color:var(--warn)}
.alerts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px;margin-top:8px}.alerts ul{margin:0;padding-left:18px}.alerts li{margin:2px 0}
.ok{color:var(--good)}
</style></head><body>
<header><h1>crew board</h1><span class="muted">${esc(repo)}</span><span class="muted" id="time"></span><span id="msg"></span></header>
<div id="cap"><div class="kpis" id="kpis"></div><div class="alerts" id="alerts"></div></div>
<main id="cols"></main>
<div id="prs"><h2>Pull requests waiting</h2><ul id="prlist"></ul></div>
<script>
const TOKEN=${JSON.stringify(token)};const REPO=${JSON.stringify(repo)};
const COLS=${JSON.stringify(COLUMNS)};const ST=${JSON.stringify(BOARD_STATUSES)};const PR=${JSON.stringify(PRIORITIES)};
const e=(t,a={},...k)=>{const n=document.createElement(t);for(const[x,y]of Object.entries(a)){if(x==='on')for(const[ev,f]of Object.entries(y))n.addEventListener(ev,f);else n.setAttribute(x,y)}for(const c of k)n.append(c);return n};
const sel=(opts,cur,on)=>{const s=e('select',{on:{change:()=>on(s.value)}});for(const[v,l]of opts){const o=e('option',{value:v},l);if(v===cur)o.selected=true;s.append(o)}return s};
async function act(issue,op,value){const r=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json','x-crew-token':TOKEN},body:JSON.stringify({issue,op,value})});const j=await r.json();document.getElementById('msg').textContent=j.error||'';load()}
async function load(){const r=await fetch('/api/board',{headers:{'x-crew-token':TOKEN}});const m=await r.json();if(m.error){document.getElementById('msg').textContent=m.error;return}
document.getElementById('time').textContent='updated '+new Date(m.generated_at).toLocaleTimeString();
const d=m.digest,c=d.counts,k=document.getElementById('kpis');k.replaceChildren();
for(const[n,l,cls]of[[c.ready,'ready',''],[c.claimed,'in progress',''],[c.human,'need a human',c.human?'bad':''],[c.stale,'stale leases',c.stale?'warn':''],[c.prs,'PRs waiting',''],[c.questions,'open questions',''],[c.idle,'idle members',c.idle?'warn':'']])k.append(e('div',{class:'kpi '+cls},e('b',{},String(n)),e('span',{},l)));
const al=document.getElementById('alerts');al.replaceChildren();const busy=d.sections.filter(s=>s.key!=='prs'&&s.lines.length);
for(const s of busy){const ul=e('ul');for(const l of s.lines)ul.append(e('li',{},l));al.append(e('div',{class:'card'},e('h2',{},s.title),ul))}
if(!busy.length)al.append(e('div',{class:'card ok'},'All clear: nobody waits for a human, no stale leases, everyone is busy.'));
const cols=document.getElementById('cols');cols.replaceChildren();
for(const c of COLS){const s=e('section',{},e('h2',{},c+' ('+m.columns[c].length+')'));
for(const t of m.columns[c]){const who=[['','unassigned'],...m.members.map(x=>[x,x])];
const ctl=e('div',{class:'row'},sel(who,t.assignees[0]||'',v=>act(t.number,'assign',v)),sel(PR.map(p=>[p,p]),t.priority,v=>act(t.number,'priority',v)));
if(ST.includes(t.status))ctl.append(sel(ST.map(x=>[x,x]),t.status,v=>act(t.number,'status',v)));
s.append(e('div',{class:'card prio-'+t.priority},e('a',{href:'https://github.com/'+REPO+'/issues/'+t.number,target:'_blank',rel:'noopener'},'#'+t.number+' '+t.title),
e('div',{class:'meta'},[t.area&&('area:'+t.area),t.risk&&('risk:'+t.risk),t.tier&&('tier:'+t.tier),t.assignees.length?('@'+t.assignees.join(' @')):'no owner',t.idle_min+' min'].filter(Boolean).join(' · ')),ctl))}
cols.append(s)}
const ul=document.getElementById('prlist');ul.replaceChildren();
for(const p of m.prs)ul.append(e('li',{},e('a',{href:'https://github.com/'+REPO+'/pull/'+p.number,target:'_blank',rel:'noopener'},'#'+p.number+' '+p.title),' — '+(p.kind==='review'?('waiting for review '+p.age_min+' min ('+p.have+'/'+p.need+')'):p.kind==='merge'?'ready to merge':p.kind==='checks'?'approved, waiting for checks':('waiting for the author: '+p.reason))));
if(!m.prs.length)ul.append(e('li',{class:'muted'},'none'))}
load();setInterval(load,30000);
</script></body></html>`;
}
