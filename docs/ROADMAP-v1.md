# Roadmap v1: hardening after the v0 audit

Source: an audit of v0 against agent-harness-construction and agent-eval (2026-11-07). The order is the priority. Steps 1-10 are implemented; the rest is tracked in issues.

## Step 1. Fix MCP tools running in the project root instead of the claimed worktree
`crew task claim` creates a worktree `../<repo>-wt-<id>`, but the MCP server runs in the project root and every command uses `process.cwd()`. As a result `crew_check`, `crew_commit` and `crew_pr_open` called over MCP would check and commit **main in the root** instead of the task branch. Through the CLI (from the worktree) everything works.
Criteria: commands have an optional `cwd` argument; `crew_task_claim` returns it in `artifacts`; test: claim -> check -> commit over MCP with `cwd` lands in the task branch.

## Step 2. Fix lease expiry for agents that commit but never heartbeat
The docs promise "the lease is extended by activity", but `crew task sweep` looked only at comment markers and the issue's `updatedAt`. Pushes to the task branch did not update them, so a live agent lost its task after 45 minutes.
Criteria: `crew commit` (or sweep, by the last commit of the `crew/<id>-*` branch) extends the lease; test: a task with a commit 10 minutes ago is not returned to the queue.

## Step 3. Add the crew:pause kill switch to task next and task claim
Agents used to have to check the emergency stop themselves from the AGENTS.md text, which violates the "rules live in code" principle.
Criteria: while an issue labeled `crew:pause` is open, `task next`/`claim` return a `paused` error with `stop_when`; a test for it.

## Step 4. Add per-step timeouts to crew check
A hung test or dev server blocks an agent forever.
Criteria: a `timeout_s` field per step (default 600); on timeout, `ci_red` with `cause_hint: timeout`; a test.

## Step 5. Add CI protection for crew.config.json, workflows and AGENTS.md
An agent could "go green" by replacing `check` in `crew.config.json` with `true`, or by weakening a workflow, because CI ran them from the PR branch.
Criteria: the `crew-guard` check rejects a PR that changes `crew.config.json`, `.github/**`, `AGENTS.md`, `agents/**`; the guard workflow runs from `main` (`pull_request_target`) and `crew check` on a PR uses the base commit's config.

## Step 6. Implement crew worker: a headless loop with a fresh session per task
Loop: check pause -> `task next` -> `claim` -> start the agent through `adapter.headless()` in the worktree with a prompt from the crew-workflow skill -> wait for a PR or blocked -> next task. A new session per task means compaction at the phase boundary.
Criteria: `crew worker --host codex|claude --area --tier --max-tasks`; stops on pause, the task limit and 3 failures in a row; a test with a fake adapter. (A `--budget` flag is still open.)

## Step 7. Implement a crew metrics event log
Without data you cannot tell whether the tool got better.
Criteria: every command writes an event to `.crew/metrics.jsonl` (command, task, agent, status, duration); `crew metrics` computes completion rate, retries per task and claim-to-PR time per agent.

## Step 8. Implement crew eval with agent-eval compatible tasks
Compare Claude and Codex (and their models) on the same tasks. The task format follows agent-eval (prompt, pinned commit, deterministic judge); see `evals/README.md`.
Criteria: `evals/tasks/*.json`; `crew eval --agents claude,codex --runs 3` in a fresh copy; a report with pass@1, pass@k, time and cost; CI runs `--dry-run` on PRs touching `templates/product/AGENTS.md`, `skills/`, `roles/`, `evals/`.

## Step 9. Add crew github setup for branch protection, variables and labels
Setting up a product repo used to mean manual clicks in Settings.
Criteria: `crew github setup` enables protection of main (PR + green `check` and `crew-guard`), sets the `CREW_HARNESS` variable, syncs labels; idempotent; dry run by default.

## Step 10. Design the crew kickoff command
A command that creates issues in bulk, deterministically, from a `docs/prd.md` with task blocks, while the LLM writes only the PRD.
Criteria: a task block format in the PRD, validation (`crew task lint`) and issue creation, gated by approval.

## Step 11. Triage external review findings
Go through reports from independent reviewers, confirm or reject each finding, and turn the critical ones into tasks.

## Step 12. Document platform lessons
`git config --global core.longpaths true` on Windows in the preflight checklist and README, and a "Known limitations" section.

## Step 13. Dress rehearsals on a fake brief
Run the whole flow with a full team, on their own machines, against a timer. After each rehearsal, file a list of breakages as issues.
