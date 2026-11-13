# Set up agent-crew: instructions for the agent

This file is read by an **agent** (Claude Code or Codex), not by a human. The human sends one message (ready-to-paste texts are at the end), and the agent walks through the steps on its own, stopping only where a human is needed.

## Rules for the agent

- Follow the steps in order. Every `crew` command returns JSON with `status`, `next_actions` and `artifacts`. Read it instead of guessing.
- `crew up` can be re-run with the same arguments: finished steps are skipped (`state: skipped`) and the command continues from where it failed.
- **Never type passwords, tokens or codes.** Logging in to GitHub, Claude and Codex is the human's job. Ask them and wait.
- Do not install anything without the human's consent. Propose the install command and run it after a "yes".
- `artifacts.human_steps` lists what only a human can do. Relay these steps briefly, as a list, with links.
- On an error (`status: error`), do what `error.retry` says. If `error.stop_when` applies or the same error repeats twice, stop and show the human the `summary` and `cause_hint`.
- **Language.** Everything you write to GitHub (issues, PRs, commits, comments) and everything agents write to each other is English. Answer the human in the human's language.

## Step 0. The machine and the tool itself

1. Check the tools: `node --version` (22+ needed), `git --version`, `gh --version`.
   If something is missing, propose an install command to the human:

   | | Windows | macOS |
   |---|---|---|
   | Node.js 22 | `winget install OpenJS.NodeJS.LTS` | `brew install node@22` |
   | git | `winget install Git.Git` | `brew install git` |
   | GitHub CLI | `winget install GitHub.cli` | `brew install gh` |

   On Windows, a new terminal is needed after installing so PATH refreshes. Also run `git config --global core.longpaths true`, otherwise git fails on task worktrees and `node_modules`.
2. Check `gh auth status`. If not logged in, ask the human to run `gh auth login` (GitHub.com -> HTTPS -> log in through the browser) and wait.
3. Check `crew --version`. If the command is missing, install the tool straight from the public GitHub repo (no registry, no token):

   ```bash
   npm install -g github:GredesCerber/agent-crew#v0.4.0
   ```

   Alternative: clone and link.

   ```bash
   gh repo clone GredesCerber/agent-crew ~/agent-crew
   ```

   In PowerShell write `$HOME` instead of `~`: external programs do not expand `~`. Then, in `~/agent-crew`, check out the latest release (`git tag --sort=-v:refname`, take the first, `git checkout <tag>`) and run `npm link`. There are no dependencies; `npm link` only puts the `crew` command on PATH.
4. Run `crew --version` again, then `crew doctor`.

## Captain: create the project

Take the parameters from the human's message. If something is missing, ask once for everything at the same time:

- `--repo <owner>/<name>`: the new product repo.
- `--stack web-node | web-fastapi`: the stack (React + Node.js or React + FastAPI).
- `--invite alice,bob`: GitHub logins of the members.
- `--public`: a public repo. On the free GitHub plan a private repo cannot have branch protection, and the `github-setup` step fails with HTTP 403. Unless the human says otherwise, use a public repo (or they need GitHub Pro/Team).
- `--hosts claude,codex`: agent hosts (default `claude,codex`).
- Optional event mode: `--start <ISO> --end <ISO>` (with a time zone, e.g. `2026-11-10T10:00:00+03:00`) and `--event-name "<name>"`. Without them, compliance checks are off.

Run from the folder **in which** the project should be created:

```bash
crew up <folder> --repo <owner>/<name> --stack web-node --invite alice,bob --public
```

The command does the following on its own:
1. creates the project (`crew init`);
2. writes `events/event.json` (event mode only);
3. makes the first commit;
4. creates the GitHub repo and pushes;
5. invites the members;
6. sets up protection of `main`, the labels and `CREW_HARNESS`.

Then:

1. Relay `artifacts.human_steps` to the human (for example, confirming project trust in Codex).
2. Check CI: `gh run list -R <owner>/<name> -L 3`. If a run failed early, rerun it: `gh run rerun <id> -R <owner>/<name>`. Wait for the result and make sure the status is `success`. If it fails again, show the human the last lines of `gh run view <id> -R <owner>/<name> --log-failed`.
3. Tell the human what to send to the members: the "Member" message from the end of this file with the repo filled in.
4. Tell the human how to start agents in the project folder (`next_actions` from `crew up`). The current session must be restarted inside the project folder, because agent configs are read at startup.

## Captain: the plan from the brief (after everyone has joined)

Only the **captain** plans: `crew up` wrote their login to `crew.config.json -> captain`, and `crew kickoff --apply` refuses for anyone else. In a new session in the project folder (branch `main`), send the "Plan" message from the end of this file together with the brief. The agent then:
1. puts the brief into `docs/brief.md` and analyzes it (skill `crew-brief-analysis`, including the "Stack" section);
2. writes `docs/prd.md` (skill `crew-kickoff`) with a `crew-team` block: who owns which area, and the captain as `review`;
3. shows the plan (`crew kickoff`) and waits for "approved";
4. runs `crew kickoff --apply`: tasks are assigned to the area owners and the plan is pushed to main;
5. works the loop: `/loop 10m Work the crew-workflow loop`. Reviews and merges reach the captain first.

## Member: join the project

Run from the folder **in which** the project should appear:

```bash
crew up --join <owner>/<name>
```

The command does the following on its own:
1. accepts the invitation to exactly this repo;
2. clones it;
3. configures git;
4. builds the local agent configs (`.mcp.json`, `.codex/config.toml`, skills).

Possible stops:
- `no_access`: the captain has not invited the human yet. The human asks the captain, then repeat the same command.
- `no_config`: the captain has not set the project up yet. Wait and repeat.

Then relay `human_steps` and `next_actions` to the human:
- **Claude Code**: open the project folder.
- **Codex**: start it with `CREW_AGENT=codex`:
  - PowerShell: `$env:CREW_AGENT='codex'; codex`;
  - bash: `CREW_AGENT=codex codex`.

  On the first start, confirm trust in the project.

The first message to the agent in a new session (Claude Code, with `/loop`, so the agent checks the queue every 10 minutes on its own):

> /loop 10m Work the crew-workflow loop: take reviews and tasks of your area from crew task next and do them. Do not plan or run kickoff; the captain does that.

**Codex** has no `/loop`, so the loop runs right in the chat: `crew task next --wait 20` waits for work for up to 20 minutes by itself (verified: Codex waits for a long command and runs many laps in one turn). The first message:

> Work the crew-workflow loop without stopping and do not ask me between tasks. One lap: run `crew task next --wait 20` in the terminal and do what its next_actions say (fix: your own PR, merge: merge it, review: review per the crew-review skill, task: claim it, build to the acceptance criteria, crew check, crew commit, crew pr open), then run `crew task next --wait 20` again. If it answers "no free tasks" three times in a row, write me a short summary and stop. Do not plan or run kickoff; the captain does that.

If Codex nevertheless ends its turn, tell it "continue the loop".

A member **never plans**: no PRD, no `crew kickoff`. If the repo has no tasks yet, they wait for the captain.

## Ready-to-paste messages for the human

Copy into a Claude Code or Codex chat and fill in your values. You can write to the agent in your own language: it answers you in that language, but everything it writes to GitHub stays English.

**Captain:**

> Set up our agent-crew. If the `crew` command is missing, install it with `npm install -g github:GredesCerber/agent-crew#v0.4.0`. Then read the `docs/AGENT-SETUP.md` of that package (or fetch it from github.com/GredesCerber/agent-crew) and do step 0 and the "Captain" section. Parameters: repo `<owner>/<name>`, public, stack `web-node`, members `<alice>,<bob>`. Create the project in the current folder. Do not type passwords: tell me what you need from me as a list.

**Plan (captain, after everyone has joined):**

> You are the captain. Put the brief below into `docs/brief.md`, analyze it with the crew-brief-analysis skill (including the "Stack" section), then use the crew-kickoff skill to write `docs/prd.md` with a crew-team block: take the members from `gh api repos/{owner}/{repo}/collaborators`; roles: `<me>` is backend and review, `<alice>` is frontend, `<bob>` is design and research. Show the plan (`crew kickoff`) and wait for my "approved". After that run `crew kickoff --apply` and work the loop: `/loop 10m Work the crew-workflow loop`. Do not type passwords.
>
> <brief>

**Member:**

> Connect me to the project. If the `crew` command is missing, install it with `npm install -g github:GredesCerber/agent-crew#v0.4.0`. Then read the `docs/AGENT-SETUP.md` of that package (or fetch it from github.com/GredesCerber/agent-crew) and do step 0 and the "Member" section for the repo `<owner>/<name>`. Do not type passwords: tell me what you need from me as a list.
