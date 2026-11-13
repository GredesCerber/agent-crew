# AGENTS.md: developing agent-crew itself

These are the rules for agents and humans who **develop agent-crew**.
The rules for a product built with it live in another file: `templates/product/AGENTS.md`.

## Principles
- **Vendor neutrality.** The core (`src/`) knows nothing about Claude or Codex. Everything vendor-specific lives in `adapters/<host>/`.
- **No dependencies.** Node.js 22+ and the standard library only. A new dependency needs an issue with a justification.
- **One response shape.** Every command returns `ok()/warn()/fail()` from `src/core/output.js`. Every error carries `cause_hint`, `retry`, `stop_when`.
- **Rules live in CI, not in prose.** If a rule matters, code must enforce it.
- **Cross-platform.** Windows, macOS, Linux. External commands go through `run()` without a shell.
- **Language.** Everything written to GitHub (issues, PRs, commits, comments) and everything agents write to each other is English. Agents talk to each human in that human's language.

## How to work
1. Tasks are issues in this repo. We follow the same loop as any crew project (`skills/crew-workflow`).
2. A new command: a file in `src/commands/`, registered in `src/core/registry.js`, a test in `test/`.
3. A new host: `adapters/<host>/adapter.js` + a generation test.
4. `npm test` must be green. Tests never touch the network or GitHub.
5. Conventional Commits. One PR, one task.

## Needs human review
- `templates/product/AGENTS.md`, roles and skills: they change agent behavior for everyone.
- `templates/product/.github/workflows/`: these are the protective checks.
- The `crew/v1` response format: change it only together with a schema version bump.
