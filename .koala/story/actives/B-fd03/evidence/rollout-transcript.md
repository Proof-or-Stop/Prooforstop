# B-fd03 rollout_check real-project transcript

Date: 2026-06-02

Command:

```bash
node packages/main/dist/cli.js --root /Users/jek/Documents/Work/Orchestrate/.worktrees/B-fd03 rollout_check --projects=/Users/jek/Documents/Work/Orchestrate,/Users/jek/Documents/Work/Koala/Koala,/Users/jek/Documents/Work/plasmid,/Users/jek/Documents/Work/minicell,/Users/jek/Documents/Work/OpenCli,/Users/jek/Documents/Work/avalon --json
```

Result:

- Schema: `lattice.rollout_check.v1`
- Product: `Lattice CLI 0.3.5`
- `readOnly: true`
- `macAppRequired: false`
- Summary: `total=6`, `pass=0`, `warn=3`, `fail=3`, `skip=0`
- Safety note: the command does not run `--apply`, `--upgrade`, `--repair`, `--fix`, installers, evidence submission, or receipt verification.
- Current B-fd03 worktree git status was unchanged before/after the command: `25` porcelain lines before, `25` after.

Per-project status:

| Project | Status | Key reason | Transcript/story scope |
| --- | --- | --- | --- |
| `/Users/jek/Documents/Work/Orchestrate` | fail | runtime footprint fails because the compatibility launcher is using an external development engine; managed assets pass; git dirty count 0 | pass: `AGENTS.md=true`, `KOALA/CLAUDE guide=true`, `.koala/story=true` |
| `/Users/jek/Documents/Work/Koala/Koala` | warn | external project config passes; runtime footprint warns; managed assets have 2 `STALE_SAFE` items; git dirty count 0 | pass: `AGENTS.md=true`, `KOALA/CLAUDE guide=true`, `.koala/story=true` |
| `/Users/jek/Documents/Work/plasmid` | fail | managed assets include `MISSING=1`, `STALE_SAFE=17`, `INCOMPATIBLE=1`; git dirty count 1 | warn: `.koala/story=false` |
| `/Users/jek/Documents/Work/minicell` | warn | runtime footprint warns; managed assets `STALE_SAFE=4`; git dirty count 9 | warn: `.koala/story=false` |
| `/Users/jek/Documents/Work/OpenCli` | warn | non-git project; managed assets missing/stale; no agent guides | warn: `AGENTS.md=false`, `KOALA/CLAUDE guide=false`, `.koala/story=false` |
| `/Users/jek/Documents/Work/avalon` | fail | managed assets include `MISSING=17`, `STALE_SAFE=4`, `STALE_LOCAL_EDIT=3`; git dirty count 133 | warn: `.koala/story=false` |

Self-worktree sanity command:

```bash
node packages/main/dist/cli.js --root /Users/jek/Documents/Work/Orchestrate/.worktrees/B-fd03 rollout_check --projects=/Users/jek/Documents/Work/Orchestrate/.worktrees/B-fd03 --json
```

Self-worktree result:

- Status: `warn`
- Reason: runtime footprint warns that the compatibility launcher uses repo-local dist; git is dirty because this story is in DEV.
- Managed assets: pass.
- Transcript/story scope: pass, including current story `B-fd03:DEV`.

Verification commands run:

```bash
npm --prefix packages/main run build
npm run test:rollout-check-smoke
npm run test:lattice-cli-migration-smoke
npm run test:command-ownership-contract
npm run test:process-fact-contract
npm run test:authority-boundary-smoke
npm run lint:tasks
git diff --check
node packages/main/dist/tasks/session-brief-prompt-sync-smoke.js
```

All verification commands passed. `npm run lint:tasks` reported 0 errors and 2 pre-existing task annotation warnings in `src/handlers/story-query.ts`.

Global CLI refresh:

```bash
npm install -g ./packages/main
lattice --version
lattice rollout_check --projects=/Users/jek/Documents/Work/Orchestrate/.worktrees/B-fd03 --json
lattice story_create --help
```

Global verification result:

- `lattice --version` prints `Lattice CLI 0.3.5 (lattice; legacy alias: koala)`.
- `lattice story_create --help` prints `lattice story_create` and the long-help examples now use `lattice`.
- Bare global `lattice rollout_check` returns schema `lattice.rollout_check.v1` and scans the story worktree. It reports `status=fail` for the dirty DEV worktree because runtime facts are conservative for a self-project with in-flight source edits; managed assets and transcript/story scope still pass. This is an expected diagnostic signal, not an entrypoint failure.
