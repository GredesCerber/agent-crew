# evals: comparing agents on reference tasks

`crew eval` runs agents (Claude Code, Codex, and their models) on the same tasks and computes pass@1, pass@k,
consistency, time and cost. This is how you check that a change to `templates/product/AGENTS.md`, skills or roles
did not make the agents worse.

```bash
crew eval --dry-run                                  # validate tasks and show the plan (no agents are started)
crew eval --agents claude,codex --runs 3             # a real run: 3 tasks x 2 agents x 3 runs = 18 launches
crew eval --agents claude:opus,claude:sonnet --task fix-off-by-one --keep
```

| Flag | What it does |
|---|---|
| `--agents` | hosts from `adapters/`, comma-separated; a model goes after a colon: `codex:gpt-5`. Default: `hosts` from `crew.config.json` |
| `--tasks` | a folder with `*.json` or a single file (default `evals/tasks`, looked up from the cwd, then in the tool itself) |
| `--task` | only these tasks, comma-separated |
| `--runs` | runs per task and agent (default 3) |
| `--dry-run` | only validate tasks and show the plan |
| `--keep` | do not delete the working copies (the path is in `raw[].workdir` of the report) |

## How one run goes

1. **A fresh copy of the repo.** With `commit`: `git clone` of the repository that contains `repo`, then checkout of that commit;
   without `commit`: a copy of the current folder state (without `.git` and `node_modules`) + `git init` and a commit.
   The initial state is tagged `crew-eval-base`. The copy lives in the OS temp folder and is deleted after the run.
2. **The agent.** `adapter.headless({ prompt, model, cwd })` -> the command runs without a shell with `cwd` set to the copy.
   The timeout is the task's `timeout_s` (default 900 s).
3. **Hidden tests.** Files from `judge_files` are copied into `.crew-eval/` of the copy **after** the agent has finished, so the agent never sees them.
4. **Judges** run in order; the task passes if all of them pass.
5. **Record:** pass/fail, time, cost (if the agent reports it, e.g. `total_cost_usd` in
   `claude --output-format json`; otherwise `null`), exit code.

If an agent's binary cannot start, its remaining runs are skipped with an `agent_failed` error and the report is a warning.

## Task format (`evals/tasks/*.json`)

```json
{
  "name": "fix-off-by-one",
  "description": "Fix an off-by-one error in pagination",
  "repo": "../fixtures/mini-app",
  "files": ["src/pager.js"],
  "prompt": "In src/pager.js the function paginate ... Verify with: npm test.",
  "judge": [
    { "type": "command", "command": "node --test .crew-eval/fix-off-by-one.judge.mjs" },
    { "type": "command", "command": "node --test" },
    { "type": "command", "command": "git diff --quiet crew-eval-base -- test/pager.test.js", "expect_exit": 1 },
    { "type": "grep", "pattern": "TypeError", "files": ["src/cart.js"] }
  ],
  "judge_files": ["judges/fix-off-by-one.judge.mjs"],
  "commit": "abc1234",
  "timeout_s": 600
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | unique name: `a-z0-9._-` |
| `description` | no | one line for humans |
| `repo` | yes | folder of the fixture repo, **relative to the task file** |
| `files` | no | files the task is about (a hint for humans; the default for `grep` without `files`) |
| `prompt` | yes | what the agent receives, verbatim |
| `judge` | yes | a non-empty list of deterministic judges |
| `commit` | no | sha the repo is pinned to (reproducibility across days). Without it the current folder state is used, which suits fixtures inside this repo: their version is pinned by the tool's own commit |
| `judge_files` | no | *crew extension*: hidden tests, relative to the task file; placed into `.crew-eval/` after the agent has finished |
| `timeout_s` | no | *crew extension*: agent timeout in seconds |

### Judges

| `type` | Fields | Passes when |
|---|---|---|
| `command` (alias `pytest`) | `command`, `expect_exit` (0), `timeout_s` (300) | the command, run in the copy root (via a shell), returns `expect_exit` |
| `grep` | `pattern` (JS RegExp), `files` (a path, a glob like `src/**/*.js`, or an array), `flags`, `absent` | the pattern is found in at least one file; with `absent: true`, in none |

`llm` judges are not supported: the result must be deterministic. To check "did not touch the contract" or
"added a test", compare with the initial state: `git diff --exit-code crew-eval-base -- contracts/`.

## Compatibility with the agent-eval format

The format intentionally follows [agent-eval](https://github.com/joaquinhuigomez/agent-eval), so the tasks can
also be run with it (after reviewing its source). The differences are JSON instead of YAML (no dependencies) and two extension fields.

| agent-eval (YAML) | crew eval (JSON) |
|---|---|
| `name`, `description`, `prompt`, `files`, `commit` | the same |
| `repo: ./my-project` (relative to the launch cwd) | `repo` is **relative to the task file** |
| `judge: - type: pytest / command` + `command` | the same (`pytest` = `command`) |
| `judge: - type: grep` + `pattern`, `files` | the same; plus `absent`, `flags` |
| `judge: - type: llm` | not supported |
| none | `judge_files`, `timeout_s`, `expect_exit` (crew extensions; agent-eval ignores them) |
| `agent-eval run --agent claude-code --runs 3` | `crew eval --agents claude --runs 3` |
| a separate git worktree per run | a temporary copy/clone per run (a worktree of a fixture inside the tool repo is not possible) |

YAML -> JSON by hand: `prompt: |` becomes a string with `\n`, lists become arrays. For agent-eval, put the hidden tests from
`judge_files` into the repo at the pinned commit and replace `.crew-eval/...` in the commands with their path.

## Report metrics

`artifacts.results` is per agent and task, `artifacts.agents` is per agent averaged over tasks,
and the full report with every run is `.crew/evals/eval-<time>.json`.

| Metric | How it is computed |
|---|---|
| `pass_at_1` | share of successful runs, c / n |
| `pass_at_k` | probability of at least one success in k = n runs (the unbiased estimator of Chen et al.: 1 - C(n-c, k) / C(n, k)) |
| `consistency` | share of runs that match the majority: max(c, n-c) / n. 1 means the agent behaves the same every time (consistently solves or consistently fails). In agent-eval "consistency" is c/n; here that is `pass_at_1` |
| `avg_time_ms` | average agent working time (judges excluded) |
| `avg_cost_usd` / `total_cost_usd` | if the agent reports cost; otherwise `null` |

## Fixture and tasks

`fixtures/mini-app/` is a small dependency-free Node module with `node:test` tests: a cart, pagination,
HTTP handlers and the contract `contracts/health.json`.

| Task | What it checks |
|---|---|
| `fix-off-by-one` | find and fix an off-by-one error, add a regression test |
| `add-input-validation` | input validation with clear errors, without breaking the old behavior |
| `handler-per-contract` | implement a route strictly per the contract, without changing the contract or hardcoding the version |

A new task: a file `tasks/<name>.json` + (if needed) a hidden test `tasks/judges/<name>.judge.mjs`. The check that a
task is not already solved and that the judges really catch it lives in `test/eval.test.js` (`npm test`).
