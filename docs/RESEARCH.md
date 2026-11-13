# Prior art: what we looked at (November 2026)

A short survey of what already exists. Stars and activity come from third-party aggregators; check the repositories directly before borrowing anything.

| Project | What it is | What we take | How we differ |
|---|---|---|---|
| [CCPM](https://github.com/automazeio/ccpm) (Claude Code PM) | PRD -> epics -> GitHub Issues -> parallel agents in worktrees | The closest to us: Issues as the queue, a worktree per task, traceability | Claude only; we support any vendor and add task leases, cross-agent review and an optional event mode |
| [codex-dispatch](https://github.com/anthhub/codex-dispatch) | A Claude Code plugin that hands tasks to parallel Codex workers in worktrees | The idea of "Claude plans, Codex executes" | We do not depend on one "main" agent |
| [worktree-codex](https://github.com/inuyashayang/worktree-codex) | A Python orchestrator: subtasks -> agents in worktrees + a dashboard | A dashboard as an idea for `crew status` v2 | A central orchestrator on one machine; ours runs on each person's own machine |
| [SwarmGit](https://pypi.org/project/swarmgit/) | A CLI for Claude Code, Aider, Codex, OpenCode; merges branches one at a time | Sequential merging, which is our integrator role | n/a |
| [Orchestrator catalog](https://openalternative.co/categories/ai-coding-agent-orchestrators/using/github) | Desktop apps that run dozens of agents in worktrees | Can be used **on top of** crew as a UI | They are about one machine; we are about a team and GitHub |
| ECC (`epic-claim`, `epic-decompose`, `orch-*`) | Coordination and development skills for Claude Code | A skill profile per role (`ecc/profile.json`) | The crew protocol works without ECC |

## Standards we build on
- **AGENTS.md**: shared instructions for agents (Codex, Cursor, Copilot, Gemini CLI, OpenCode and others).
- **Agent Skills**: `SKILL.md`; Codex looks for project skills in `.agents/skills/`, Claude in `.claude/skills/`.
- **MCP**: Codex reads the project `.codex/config.toml` (`[mcp_servers.<name>]` tables, secrets via `env_vars`) only in trusted projects; Claude Code uses `.mcp.json`.

## Conclusion
We found no ready-made **cross-vendor team** solution: existing tools either target one vendor (CCPM) or orchestrate agents on a single machine. Our niche is a thin protocol on top of GitHub that any agent understands, plus protection against the usual failure modes of shared repos (rules, integration, a main branch that is always releasable).

## Sources
- https://github.com/automazeio/ccpm, https://hn.svelte.dev/item/44960594
- https://github.com/anthhub/codex-dispatch
- https://github.com/inuyashayang/worktree-codex
- https://pypi.org/project/swarmgit/
- https://openalternative.co/categories/ai-coding-agent-orchestrators/using/github
- https://developers.openai.com/codex/concepts/customization
- https://www.tembo.io/blog/codex-cli-mcp, https://dev.to/eliran_kotzero_e1781dc487/one-mcp-server-three-configs-claude-code-cursor-and-codex-1em0
