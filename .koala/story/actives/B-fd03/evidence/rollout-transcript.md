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
- Current B-fd03 worktree git status was unchanged before/after the command: `9` porcelain lines before, `9` after.

Acceptance reconciliation:

The real-project acceptance evidence is intentionally conservative: this run does not claim every project is production-ready or PASS. It records the scanner's actual `warn`/`fail` statuses and the CLI output contract's per-project `nextAction` field so an operator can audit why a project is blocked without running write-capable repair paths. The status mix below is therefore the expected diagnostic outcome for the current local fleet, not a weakened pass condition.

Per-project status:

| Project | Status | Key probe status | Project `nextAction` | Transcript/story scope |
| --- | --- | --- | --- | --- |
| `/Users/jek/Documents/Work/Orchestrate` | fail | `runtime_footprint=fail`; `managed_assets=warn`; `doctor_readonly_subset=fail`; git dirty count 0 | compatibility launcher is using an external Koala development engine; project package.json/node_modules are not required | pass: `AGENTS.md=true`, `KOALA/CLAUDE guide=true`, `.koala/story=true`, `activeStories=259` |
| `/Users/jek/Documents/Work/Koala/Koala` | warn | `runtime_footprint=warn`; `managed_assets=warn`; `doctor_readonly_subset=warn`; git dirty count 0 | compatibility launcher is using an external Koala development engine; project package.json/node_modules are not required | pass: `AGENTS.md=true`, `KOALA/CLAUDE guide=true`, `.koala/story=true`, `activeStories=1` |
| `/Users/jek/Documents/Work/plasmid` | fail | `managed_assets=fail`; `runtime_footprint=warn`; git dirty count 1 | Run lattice check manually, review unsafe items, then use lattice check --apply or --upgrade only after operator approval. | warn: `AGENTS.md=true`, `KOALA/CLAUDE guide=true`, `.koala/story=false` |
| `/Users/jek/Documents/Work/minicell` | warn | `runtime_footprint=warn`; `managed_assets=warn`; git dirty count 9 | compatibility launcher is using an external Koala development engine; project package.json/node_modules are not required | warn: `AGENTS.md=true`, `KOALA/CLAUDE guide=true`, `.koala/story=false` |
| `/Users/jek/Documents/Work/OpenCli` | warn | non-git project; `runtime_footprint=warn`; `managed_assets=warn`; no agent guides | compatibility launcher is using an external Koala development engine; project package.json/node_modules are not required | warn: `AGENTS.md=false`, `KOALA/CLAUDE guide=false`, `.koala/story=false` |
| `/Users/jek/Documents/Work/avalon` | fail | `managed_assets=fail`; `runtime_footprint=warn`; git dirty count 133 | Run lattice check manually, review unsafe items, then use lattice check --apply or --upgrade only after operator approval. | warn: `AGENTS.md=true`, `KOALA/CLAUDE guide=true`, `.koala/story=false` |

Self-worktree sanity command:

```bash
node packages/main/dist/cli.js --root /Users/jek/Documents/Work/Orchestrate/.worktrees/B-fd03 rollout_check --projects=/Users/jek/Documents/Work/Orchestrate/.worktrees/B-fd03 --json
```

Self-worktree result:

- Status: `fail`
- Project `nextAction`: compatibility launcher is using the repository-local Koala dist runtime; run `npm --prefix packages/main run build` after core edits.
- Reason: runtime footprint is intentionally conservative for the Lattice source tree while this DEV worktree has source/doc/evidence edits in flight; `doctor_readonly_subset` also fails because git is dirty and runtime is fail.
- Managed assets: pass (`OK=45`, no missing/stale/incompatible items).
- Transcript/story scope: pass, including current story `B-fd03:DEV`.

Verification commands run during this refresh:

```bash
npm --prefix packages/main run build
npm run test:rollout-check-smoke
npm run test:lattice-cli-migration-smoke
node packages/main/dist/tasks/session-brief-prompt-sync-smoke.js
npm run test:process-fact-contract
npm run test:command-ownership-contract
git diff --check
node packages/main/dist/cli.js --root /Users/jek/Documents/Work/Orchestrate/.worktrees/B-fd03 rollout_check --projects=/Users/jek/Documents/Work/Orchestrate,/Users/jek/Documents/Work/Koala/Koala,/Users/jek/Documents/Work/plasmid,/Users/jek/Documents/Work/minicell,/Users/jek/Documents/Work/OpenCli,/Users/jek/Documents/Work/avalon --json
```

All commands above passed. The rebuilt `rollout_check` command returned the conservative real-project statuses shown in the table.

Global CLI refresh / alias verification:

```bash
npm install -g ./packages/main
lattice --version
koala --version
lattice check
lattice doctor --format=json
lattice rollout_check --projects=/Users/jek/Documents/Work/Orchestrate/.worktrees/B-fd03 --json
lattice story_create --help
```

Global verification result:

- `lattice --version` prints `Lattice CLI 0.3.5 (lattice; legacy alias: koala)`.
- `koala --version` prints `Lattice CLI 0.3.5 (lattice; invoked through legacy alias koala)`.
- `lattice check` reports `Runtime mode: compatibility-launcher`, `Runtime source: repo-local-dist`, and `Lattice managed asset check: OK`.
- `lattice doctor --format=json` exits successfully and reports `runtime.summary.status=fail` for this self-project because the global `koala`/core realpaths point at the B-fd03 worktree while the canonical expected paths are the main Orchestrate tree. This is a development-time diagnostic failure, not a write or repair action.
- Bare global `lattice rollout_check` returns schema `lattice.rollout_check.v1` and scans the story worktree. It reports `status=fail` for the dirty DEV worktree because runtime facts are conservative for a self-project with in-flight source edits; managed assets and transcript/story scope still pass.
- `lattice story_create --help` prints `lattice story_create` and the long-help examples now use `lattice`.
