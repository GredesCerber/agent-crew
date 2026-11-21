# Try crew on one issue

A pilot in a repo your team already has: one existing issue goes through claim, an agent's PR, a review by a second
agent and a protected merge. No discovery, no PRD, no new repo. If it works for you, plan the rest with `crew kickoff`
later; if not, remove the few files it added.

What you need: Node.js 22+, `gh` logged in with **admin** rights on the repo (for the protection of `main`), one agent
host (Claude Code or Codex) and, for the review, a second agent (another host, or the same host in a second session).

## 1. Look first

```bash
cd your-repo
crew github setup            # dry run: what it would change on GitHub, and which of your rules it keeps
```

`crew github setup` only **adds** to the protection of `main`. Your required checks stay required, a higher number of
required human approvals stays, and flags you turned on (code owners, admins included, conversation resolution) stay
on. It warns when something conflicts: with "require linear history" crew PRs cannot merge, because crew merges with
merge commits (squash loses the `Agent:` trailers that crew-guard reads).

A **private repo on the free GitHub plan cannot protect `main`**: PR rules and checks would bind nobody. Use a
public repo, a paid plan, or treat the pilot as a demo without protection.

## 2. Add crew to the repo

Do it on a new branch, because in a folder that is not empty `crew init` needs `--force` and writes its template
files over files with the same name (`AGENTS.md`, `.github/workflows/crew*.yml`, `.gitignore` and others). Your
`README.md` is kept; it only gets one "New on the team?" line.

```bash
git switch -c try-crew
crew init . --force --hosts claude  # crew.config.json, AGENTS.md, CI workflows, agent configs
git diff --stat                     # read what changed; restore any file of yours that you want back
```

Then edit `crew.config.json`:

- `"check"`: the commands that test your project (they come from a stack preset; put your own test command there).
- `"phase": "build"`, so the pilot skips the discovery phase (`--solo` sets it, together with a one-agent review rule).

Merge the branch through a normal PR, then:

```bash
crew github setup --apply           # labels, CREW_HARNESS, protection of main (merged with yours)
```

## 3. Pick one issue

Choose a small, real issue and make it ready for an agent: a goal and acceptance criteria as a checklist in
Given/When/Then form, then

```bash
crew task status <n> ready          # refuses while the criteria are missing (Definition of Ready)
```

Add the labels crew uses: `area:<one of crew.config.json areas>` and, if you like, `tier:low|mid|high` and
`risk:low|med|high` (default `med`).

## 4. Let the agents work

Open the repo in your agent and say: "Work through the crew-workflow cycle on issue <n>". The agent claims the issue,
works in its own worktree, opens a PR that says `Closes #<n>`, and waits. A second agent (`crew task next` in another
session) reviews it. When the checks and crew-guard are green and the review is on the current commit, the PR merges
(`risk:high` waits for a person).

Watch it on `crew board`: the card moves from Ready to In progress to In review; the task panel shows the lease, the
PR, its checks and the review.

## 5. Decide

Questions worth answering after the pilot: did the agent's PR meet the criteria; did the review catch something; how
long from claim to merge (`crew metrics`); what did a person have to do by hand. To stop, delete the files `crew init`
added and run `crew github setup` again only if you want crew's rules back.
