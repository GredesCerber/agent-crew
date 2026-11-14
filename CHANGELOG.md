# Changelog

All notable changes to agent-crew. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).
Every PR adds a line under **Unreleased**; a release renames that section to the version and date.

## [Unreleased] — 0.6.0

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
