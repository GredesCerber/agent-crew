# Architecture

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│ 4. Host adapters (generated)        adapters/claude, codex, … │
├───────────────────────────────────────────────────────────────┤
│ 3. Roles and skills (data)          roles/*.md, skills/*/     │
├───────────────────────────────────────────────────────────────┤
│ 2. Tools                            crew: CLI + MCP server    │
├───────────────────────────────────────────────────────────────┤
│ 1. Protocol and enforcement         AGENTS.md, GitHub Issues, │
│                                     Actions, branch protection│
└───────────────────────────────────────────────────────────────┘
```

The rule: **one protocol for everybody, vendor-specific parts only in thin adapters**. Critical rules live in layer 1 (CI), because an agent can ignore text but cannot ignore CI.

## Standards
- **AGENTS.md** for instructions. Codex reads it natively, Claude Code through `CLAUDE.md` containing `@AGENTS.md`.
- **Agent Skills** (`SKILL.md` with `name`/`description` frontmatter) for skills. Claude: `.claude/skills/`, Codex: `.agents/skills/`.
- **MCP** for tools. `crew mcp` is a dependency-free stdio JSON-RPC server.
- **GitHub Issues/PRs + git trailers** for coordination and code provenance.

## Code

```
bin/crew.js              CLI entry point (help, version, mcp, commands)
src/core/output.js     the single crew/v1 response shape + CrewError with a recovery contract
src/core/registry.js   command registry -> the CLI and MCP are both built from it
src/core/exec.js       runs git/gh without a shell; runShell for user check steps
src/core/config.js     crew.config.json (searched up the folder tree), events, CREW_AGENT
src/core/issues.js     the queue in Issues: labels, markers in comments, leases
src/core/prd.js        docs/prd.md -> tasks: crew-team/crew-task/crew-epic block parser, linter, ordering, kickoff plan, issue bodies
src/commands/*.js      one file per command group
src/mcp/server.js      MCP: initialize, tools/list, tools/call
adapters/<host>/       generate() -> config files, headless() -> how to run without a UI
templates/             what crew init copies: product/, stacks/, labels, mcp
```

### A command
```js
export default {
  name: 'task next',              // how to call it
  summary: '...',                  // help + MCP tool description
  agent: true,                     // false: humans only, not exposed over MCP
  args: [{ name: 'area', type: 'string', positional?, required?, enum?, description }],
  run(opts) { return ok('...', { artifacts, next_actions }) },  // or throw CrewError / return fail(...)
};
```

### An adapter
```js
export default {
  id: 'claude', binary: 'claude',
  generate({ config, roles, skills, frontmatter, platform }) {
    return [{ path: '.mcp.json', content: '...', commit: false }]; // commit:false -> goes to .gitignore
  },
  headless({ prompt, model }) { return { cmd, args, env } },     // for crew worker
};
```
`commit: true` means the file is the same for everybody, is committed and is checked in CI (`crew adapters build --check`).
`commit: false` means it depends on the machine (Windows wraps commands in `cmd /c`), so everybody generates it locally.

## Coordination without a server
- **Status** is a `status:*` label on the issue.
- **Lease** is a set of machine-readable markers in comments: `<!-- crew:claim agent=codex/x at=ISO -->`. The owner is the first `claim` after the last `release`, which protects against a race between two agents.
- **Expiry**: `crew task sweep`, run on a schedule in Actions, returns tasks with no activity for longer than `lease_minutes`. Activity is the latest crew marker (or the issue's `updatedAt`) or the latest commit on `origin/crew/<id>-*`, whichever is newer; the decision is the pure function `isStale()` in `src/core/issues.js`.
- **Ownership**: the `crew-team` block of the PRD maps each area to one owner (a GitHub login) and names the reviewers (the `review` role). `crew task next` serves a person their own tasks first, then unowned ones, then other people's areas; PRs awaiting review come before tasks.

## Kickoff: PRD -> Issues
An LLM (the planner) writes only `docs/prd.md` with `crew-team`, `crew-task` and `crew-epic` blocks (format: `skills/crew-kickoff/task-format.md`).
Everything else is deterministic code: `crew task lint` (`lintPrd`, all errors at once, `prd_invalid`) ->
`crew kickoff` (dry run: `planKickoff(parsed, existing)` -> create/skip/changed/orphan) ->
`crew kickoff --apply` (only with an `<!-- crew:prd status: approved … -->` header, otherwise `plan_not_approved`;
sequential `gh issue create` with a 1 s pause and retries on rate limit after 10/30/60 s; a failure midway is `kickoff_partial`).
Idempotency comes from the marker `<!-- crew:task id=T2 hash=… prd=… -->` in the issue body; existing issues are not modified.
Dependencies: every task implicitly waits for the skeleton; a task with dependencies gets `status:waiting` + `<!-- crew:after issues=N,M -->`.
`crew task promote` (the `promote` job in `crew.yml`, run when an issue closes, and `crew task sweep`) moves it to `ready` once all of them are closed;
the decision is the pure `decidePromotions()` in `src/commands/task.js`.

## Design decisions
| Decision | Why |
|---|---|
| Node.js with no dependencies | installs with one command everywhere, nothing to break, fast start |
| Issues instead of our own database | a shared board for humans and every vendor, survives the crash of any agent |
| CLI and MCP from one registry | agents without MCP work through the CLI with the same JSON |
| Stack presets are generators, not code | compatible with event rules about pre-written code |
| Kickoff is code, not an LLM | the LLM writes the PRD, a deterministic idempotent `crew kickoff` creates the issues; the gate is PRD approval |
| ECC is optional | the protocol does not depend on features only Claude has |
