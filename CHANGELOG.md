# Changelog

All notable changes to agent-crew. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).
Every PR adds a line under **Unreleased**; a release renames that section to the version and date.

## [Unreleased]

### Changed
- A new roadmap in `docs/ROADMAP.md` (0.10: keep the promises; 0.11: fewer things to watch; later; not planned); `docs/ROADMAP-v1.md` is archived and the README roadmap points to it.

## [0.9.1] — 2026-11-21

From an independent review of 0.9.0.

### Fixed
- `crew kickoff --apply` reads the phase from main's `crew.config.json`: after a publish that failed to push, a retry no longer skips the discovery gate and still publishes the switch to `build` (before, main could stay in `discovery` and crew-guard failed every code PR).
- `crew discover status` reads `docs/discovery.md`, `docs/decisions.md` and the PRD from main, and requires the local `docs/prd.md` to match the reviewed PRD on main: ticking boxes locally or rewriting the PRD next to a reviewed stub no longer ends discovery.
- Solo: a ready `risk:high` PR is left to the person (`human: true` in the queue): `crew task next` does not hand it to the agent and `crew merge-ready` skips it, as documented.
- `crew init --force` keeps an existing `README.md` and only adds the newcomer line under its first heading.
- `discovery_phase` and `spike_in_build` check both ends of a rename (`git mv spikes/x.js src/x.js` and `git mv src/app.js docs/` no longer pass).
- `crew discover plan` errors carry `cause_hint`, `retry` and `stop_when` (crew/v1).
- Docs: the discovery allowlist also includes `README.md` and `JOIN.md`; the discovery skill no longer suggests `spikes/` in the build phase; `JOIN.md` asks to update only when the local crew is older than the pinned one; `--skip_discovery` is described as a human's call that crew cannot enforce.
- README (EN/RU) brought up to date: `risk:high` needs one review (not two) and a person merges it; the roadmap no longer lists auto-merge and the digest as future work; the discovery step, the captain and handover, ideas and questions, the team status, the new crew-guard rules (`discovery_phase`, `spike_in_build`, `outdated_crew`, waivers) and the files a new project gets are described; steps numbered 1–7.

## [0.9.0] — 2026-11-20

### Added
- **Join with one message.** Once added to the repo, a newcomer tells their agent "Join the development of owner/repo": the product README points to `JOIN.md`, which walks the agent through the machine check, the crew version the repo pins, `crew up --join` and the first task. `crew up --join` checks the local crew against `CREW_HARNESS` and says to start right away in the same session (a restart only adds the MCP tools). Codex projects set `CREW_AGENT=codex` for Codex terminal commands. The digest lists people with access but no area ("Joined without an area").
- **Discovery phase.** New team projects start in `phase: discovery`: crew-guard lets PRs touch only `docs/` and `spikes/` (`discovery_phase`), and after the plan `spikes/` is not changed any more (`spike_in_build`). `crew discover plan [--apply]` turns the `crew-research` blocks of `docs/discovery.md` into research tasks (time budget in the title; rules: facts with sources vs assumptions, a position, the decisions log, spikes, `--human` questions for organizers). `crew discover status` checks the exit criteria (research closed, no human questions open, a decision recorded, the exit checklist, the PRD on main through a reviewed PR); `crew kickoff --apply` waits for it (`--skip_discovery` is the human override) and switches the phase to `build`. The digest shows the phase and research over budget. New templates `docs/discovery.md`, `docs/decisions.md` and the skill `crew-discovery`. Existing projects (no `phase`) stay in build.
- **Solo mode.** `crew init --solo` / `crew up --solo`: no discovery gate, no second-agent review (`review.approvals: 0`), one host, no captain handover; CI, crew-guard rules and the protected `main` stay, `risk:high` still waits for the person.

## [0.8.1] — 2026-11-18

From a first-time-user smoke run.

### Fixed
- `crew check` on a fresh project, where every step is skipped (no tests yet), says "Nothing was verified" with a warning instead of "All checks green" (`artifacts.verified: false`); `crew pr open` still works.
- `crew status`, `crew digest` and other GitHub commands in a project with no GitHub remote yet give `no_remote` with how to connect it (`crew up --repo`, or `git remote add`), instead of a raw gh error and "report in the issue".
- `crew adapters build` says "all N files already up to date (M of them local to this machine)" instead of "files updated: 0 of N", which read like a failure.
- `crew task lint` and `crew captain` outside a project give `not_a_project` instead of "PRD not found" or answers as if a project existed.
- A mistyped command gets "Did you mean ...?" (`crew taks next` → `crew task next`, swapped letters count as one typo).

## [0.8.0] — 2026-11-16

### Added
- Captain handover, a rule the repo owner chooses at `crew up` (`--handover off|deputies|team`, `--deputies`, `--fallback_hours`) and changes with `crew captain policy`: off (only the captain), deputies (the captain may hand the role to listed people), team (to anyone with write access), plus an optional automatic fallback to the first deputy after N hours of captain silence. `crew captain handoff @login --hours N` / `crew captain back` record it in a `crew:captain` issue (only the captain's own comments count); `crew captain` shows who acts now. The acting captain can run kickoff, decide on ideas and gets questions that need a human; the digest shows who acts. `crew up` explains the chosen rule in plain words for the repo owner.
- Ideas: when a person suggests something outside the current task, the agent records it with `crew idea` (English summary plus the person's own words) instead of building it, and keeps working. The captain sees waiting ideas in `crew task next` (a reminder, never a blocker), the digest and the board (Accept / Reject buttons), and decides with `crew idea accept <n>` (a `needs-spec` task, then the usual spec and DoR check) or `crew idea reject <n> --reason`. Only the captain's GitHub login can decide.

## [0.7.1] — 2026-11-15

Fixes from an independent review of 0.6.0–0.7.0.

**Upgrading:** once `CREW_HARNESS` pins 0.7.1, open crew PRs made with 0.7.0 or older turn red (`outdated_crew`, not waivable). Each author updates crew and runs `crew pr open` again in the task folder; it refreshes the version stamp. PRs from a headless worker need someone to do that in the worker's task folder. Agent names from 0.7.0 set by hand (`claude@pc-2`) are not treated as siblings: drop the manual `CREW_AGENT_ID` and let crew name sessions.

### Security
- One identity per session: terminal `crew` calls resolve the session's own name (the worktree pin, or the only live session on the machine); with several live sessions and no pin, every command that writes under the agent's name refuses with `ambiguous_agent` instead of guessing.
- Session names: a second session on a machine is `claude@pc#2` (was `claude@pc-2`), so machines whose names end in digits (`lab-1`, `lab-2`) are never mistaken for sessions. Names with a model (`claude/opus@pc`) stay intact in the CLI. A new session claims its slot from the base name, never from a live sibling's.
- Sibling sessions count as the same agent for review: a session cannot review its own or a sibling's PR, and `crew pr review` also checks the commits' `Agent:` trailers. Work and answers still go to the exact session.
- Waiving `not_crew_pr` no longer lets the author approve: the commits' agents (and, with no known agent, the GitHub account that opened the PR) cannot review it. Review markers from bots never count.
- The "Changes acceptance" section only relaxes the acceptance rule when a team member (owner, member, collaborator) wrote the issue.
- `crew merge-ready` merges with `--match-head-commit`, so a push after the review cannot slip in.
- Session locks live in a per-user folder (never one another account owns), are refreshed while the session runs, and go stale after 30 minutes without a refresh; only one session at a time may take over a stale lock, so two sessions never get the same name.
- Questions: the answer reaches the asker as text: a member's `crew:answer` comment, or the members' plain replies in GitHub after it (never outsiders, bots or the hand-off note; a quote reply counts); question and answer text cannot forge markers; `crew ask` rejects unknown areas; an agent cannot answer its own question; `crew inbox --ack` only touches questions.
- `crew guard` fails crew PRs opened with a crew older than the repo's `CREW_HARNESS` (`outdated_crew`), using a version stamp `crew pr open` writes and refreshes; a crew PR without a stamp counts as older.

### Fixed
- `crew task next`: questions and answers come before `resume`, so an answer from `crew ask` reaches an agent mid-task; a deleted issue behind a worktree no longer breaks it.
- An approved PR with a red `crew-guard` is a `fix` for its author (`crew guard --pr N` names the rule); an approved PR waiting for checks shows as such in `crew status`, the digest and on the board instead of vanishing.
- The sweep job promotes tasks right after `merge-ready` (merges made by CI trigger no workflows).
- `requires:` finds `npm`/`pnpm`/`yarn` on Windows and treats tools that reject `--version` (go, java) as installed.
- `crew upgrade --apply` plans against the default branch (its PR lists those changes), never re-adds areas a project removed, counts untracked files as uncommitted work, and returns to your branch (or detached commit) if anything fails.
- Board and digest: moving a task back to `ready` also ends an old claim; a failed collaborators call is not cached; stale leases use the owner's markers (like the sweep) in both; members with an open PR are not idle.
- The MCP server reports the real crew version (it said 0.1.0). README: install is from npm (it still said "no registry"), no hard-coded old git tag, and the hackathon claim links the public repo it comes from.
- Release workflow: the tag must be on `main`, the CHANGELOG section is checked before staging, and npm is pinned.

## [0.7.0] — 2026-11-14

### Added
- `crew pr logs <n>`: the failing step of a red check's CI log (not the post-job cleanup), so agents stop asking humans to copy logs from the browser.
- `crew task next` returns `kind: resume` first when this agent left a claimed task unfinished on this machine (the session died, e.g. out of usage) — no more "ready but never submitted".
- `crew doctor` warns when the crew MCP server is not wired for a host (`.mcp.json`, `.claude/settings.json`, `.codex/config.toml`).

### Changed
- `crew task status <n> ready` is open to anyone, agents included, and checks the Definition of Ready itself (an `area:*` label and a real Given/When/Then criterion); `--force` is the human override. Teams no longer stall when the product lead is away.
- Claude settings also pre-approve `crew.cmd`, and AGENTS.md tells agents to call crew through the MCP tools, which host permission checks do not refuse.

### Fixed
- Running crew outside the project folder gives `not_a_repo` with how to `cd` (PowerShell and cmd), instead of a raw "not a git repository" from git or gh.
- README: on Windows use `crew.cmd` when PowerShell blocks scripts.

## [0.6.1] — 2026-11-14

### Added
- `crew board` shows a captain panel on top: counters (ready, in progress, need a human, stale leases, PRs waiting, open questions, idle members) and the lists behind them — the same status `crew digest` posts.

## [0.6.0] — 2026-11-14

### Added
- `crew board`: a local task board in the browser — queue by status, PRs waiting; set assignee, status and priority by hand without spending agent tokens. Listens on 127.0.0.1 only, per-run token, Host check.
- Priority labels `priority:high` / `priority:low`; `crew task next` hands out high-priority tasks first within the same owner group.
- `crew upgrade [--apply]`: brings an existing project up to the installed version (AGENTS.md, roles, skills, workflows, templates, playbooks, agent configs, new config keys) and migrates projects made with hackathon-harness (`hk`). Opens a PR for a human to merge.
- `crew ask` / `crew inbox` / `crew answer`: questions between agents through GitHub issues (`crew:question`), routed to the owner of the area; `--human` hands a decision to a human (`needs-human`). Questions and answers show up in `crew task next`. Agents must write to each other in English.
- A unique agent name per session on one machine (`claude@pc`, `claude@pc-2`, …) taken by the crew MCP server; `crew task claim` pins it into the task worktree.
- `crew merge-ready`: deterministic merge of ready PRs (review, green `check` and `crew-guard`) that auto-merge will not take; the scheduled sweep job runs it.
- `crew digest [--post]`: team status without an LLM (needs a human, stale leases, PRs waiting, open questions, idle members). The sweep job keeps it in one pinned issue labelled `crew:digest`, without @-pinging anyone, so nobody has to keep an agent session polling the repo.
- `crew pr waive <n> --rule <r> --reason "..."`: a recorded human waiver of paperwork rules (`closes`, `agent_trailer`, `not_crew_pr`) for one commit of a PR made outside crew. Protected files, acceptance tests and review cannot be waived.
- Check steps can declare `requires: ["docker", …]`: skipped locally with a note when the tool is missing, failing in CI.
- Tasks in the `design` and `research` areas (or with `independent: true`) do not wait for the skeleton; `crew task lint` warns when all of someone's tasks wait for other people's work.

### Changed
- `crew pr open` refuses when the branch conflicts with `main` (checked with `git merge-tree`, listing the files) and when the local crew is older than the repo's `CREW_HARNESS`.
- A `v*` tag stages the version on npm through trusted publishing (`npm stage publish`; a maintainer approves it with 2FA) and creates the GitHub Release with notes taken from this file.
- Legacy `hk:` markers and `hk/<id>-` branches are read as their `crew` equivalents, so migrated projects keep their tasks, leases and reviews.

### Fixed
- `crew upgrade` deletes only the four known legacy skills and branches from the repo's default branch.

## [0.5.0] — 2026-11-13

### Added
- Published to npm as `@gredescerber/agent-crew`; CI installs the pinned version from the public registry.
- Release workflow on `v*` tags via npm trusted publishing (skips versions already on npm).

## [0.4.1] — 2026-11-13

### Fixed
- Installing from GitHub works on npm 12+ (`--allow-git=all`).

## [0.4.0] — 2026-11-13

First public release (rebuilt from the private hackathon-harness).

### Added
- `crew shots before|after`: Playwright screenshots for UI tasks; `crew pr open` adds a Before / After table to the PR.
- `crew task cleanup`: removes worktrees of closed tasks whose work is saved.
- Version check: `crew doctor` and `crew task next` tell you when your crew is outdated.

### Changed
- Renamed `hk` → `crew`; everything agent-facing is in English; agents talk to each human in that human's language.
- Positioned as a development environment for agent teams; hackathon features are an optional event mode.
- Installed from the public GitHub repo instead of private GitHub Packages; squash and rebase merges are disabled by `crew github setup` (they dropped trailers).
- `crew up` warns when `main` cannot be protected (private repo on GitHub Free).
