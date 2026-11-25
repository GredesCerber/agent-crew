# Roadmap

Where agent-crew goes after 0.9. The order inside a section is the priority. Each item says why it matters and when it counts as done; it becomes an issue when someone starts it.
The history of how we got here is in [`CHANGELOG.md`](../CHANGELOG.md) and [`ROADMAP-v1.md`](ROADMAP-v1.md) (done).

## Where we are (0.12)
- **Team loop:** GitHub Issues as the queue with leases, one task per PR, a review-first `crew task next`, cross-vendor review, `crew-guard` rules from `main`, deterministic merges in CI (`crew merge-ready`).
- **Planning:** a discovery phase with research tasks and recorded decisions, then a PRD approved by a person, then `crew kickoff`.
- **People:** a captain who can hand the role over, ideas and questions as issues, `crew digest` and `crew board` with no LLM involved, joining a project with one message, a solo mode.
- **Hosts:** Claude Code, Codex and Antigravity (its adapter is new: the crew tools, rules and skills were checked live in the app; a full task loop on it is still to be run).
- **0.10** shipped the captain's console (`crew board`) instead of the items below; they move to 0.11.
- **Done for 0.11 so far** (from a Codex review and its advice): `crew up --check` and a stop before the first write when `main` cannot be protected; `crew github setup` keeps a repo's own protection rules and [a pilot on one issue](PILOT.md); the PRD approval is a record of one revision by the captain (no approval by timeout); the board fixes from the review (page key, writes checked against fresh state, release order).

How we pick what comes next:
- Trust first: a rule the docs promise but code does not enforce is a bug.
- Then less babysitting: work a person would otherwise have to watch.
- Then more hosts.

## Now: keep the promises (moved from 0.10)
1. **Session locks per repository.** Locks live in `crew-agents-<user>` for the whole machine, so two sessions in two unrelated repos look like siblings and get `ambiguous_agent`, and `crew doctor` says nothing.
   Done when locks are keyed by repo (remote URL or root path), `crew doctor` lists the live sessions of this repo, and a test runs two repos side by side.
2. **Unfinished work survives a renamed session.** `resume` and fix delivery match the exact agent id. When slot names change between runs (`claude@pc#2` becomes `claude@pc`), the work is orphaned until its lease runs out.
   Done when a new session of the same agent on the same machine picks up its own unfinished task or PR fix, never another agent's, and a test covers the rename.
3. **Pre-release versions.** `outdated_crew` and the `crew up --join` version check compare plain `x.y.z` and cannot stamp or compare `0.10.0-rc.1`.
   Done when semver pre-releases compare correctly (an rc is older than its release) and a test covers it.
4. **Live checks of untested wiring.**
   - Codex terminal identity through `[shell_environment_policy]`: tried in a real Codex session.
   - Claude headless flags for `crew worker` and `crew eval`: verified against the current CLI.
   - The results go into `docs/AGENT-SETUP.md`, replacing the "not yet tried" notes.
5. **A worker budget.** `crew worker --budget` stops after a time limit, or a cost limit when the host reports one, and says how far it got.

## Next: 0.11, fewer things to watch
1. **Nightly checks.** A scheduled workflow runs the full `crew check` (and e2e when the stack has it) on `main`. When it goes red, it opens or updates one `crew:nightly` issue that `crew task next` offers before new work, and closes the issue when `main` is green again.
2. **Review before release, as a step.** The tool asks every product team for an independent review, and its own releases should get one too. `crew release` (or a documented script): run the tests, run a read-only reviewer agent from another vendor or model over `vPREV..HEAD`, write the findings to a file, and refuse to tag while a high finding is open unless a person waives it.
3. **npm release hygiene.** Trusted publishing stages every release, and nothing moves `latest` until a maintainer approves (`0.10.0` waited a day for that).
   - The release checklist in README says this.
   - `crew doctor` in this repo warns when the newest tag is not `latest` on npm.

## Later
- **Gemini CLI and Cursor adapters** (Antigravity is done: a workspace plugin with the crew MCP server).
  - Each adapter goes in `adapters/<host>/`, with the generated files covered by a test, and with MCP and instructions wiring checked live.
  - A host counts as supported only after one real task has gone through the full loop on it.
- **Actions only a person may take.** Agents usually run under their person's GitHub account, so whatever a person can do, their agent can do too: pass `--skip_discovery`, waive a rule, or post the PRD approval comment. The PRD approval is now bound to one revision, given by the captain on `crew board`, and never by timeout; but an agent on the captain's own account could still post it.
  - Options to study: GitHub environments with required reviewers, or a second account for agents (then approvals and waivers can require the person's account).
  - Done when the choice is written down in `docs/ARCHITECTURE.md` and approvals and waivers cannot come from an agent's credentials.
- **A rehearsal of 0.9 with a real team.**
  - Discovery, join with one message and the captain handover have only been tested in unit tests and a solo smoke run.
  - One timed run on a fake brief with three or more people and both vendors, with breakages filed as issues, as in the v1 rehearsals.
- **Metrics on the board.** `crew metrics` already counts completion rate, retries and claim-to-PR time from `.crew/metrics.jsonl`, but the board does not show them yet.
- **The unscoped npm name.** We asked the owner of `agent-crew` to transfer it. If that does not work out, we stay on `@gredescerber/agent-crew`. The `crew` command is the same either way.

## Not planned
- **A hosted service or our own server.** Everything stays in git, GitHub and the user's own machines.
- **Runtime dependencies.** Node 22+ and its standard library only (see `AGENTS.md`).
- **Vendor-specific logic in the core.** It stays in `adapters/`.
- **Agents talking to each other in a chat.** Questions, ideas and decisions stay as issues and files that people can see.
