# B-fd03 Plan — Lattice rollout_check and command semantics

## CHK-001
Record M1 rollout findings and publish Lattice install guidance.

Steps:
- Update README and docs guide with Lattice CLI 0.3.5 local/global refresh flow: build packages/main, npm install -g ./packages/main, verify lattice/koala versions.
- State that lattice is the primary command and koala is a legacy alias.
- Document M1 observed project classes: main repo pass, external project warning/drift, non-git project warning.
- Keep Codex-specific bin/koala-codex.js references where they are adapter entrypoints, not general user CLI guidance.

Verify:
- grep docs for primary examples: lattice check, lattice doctor, lattice session_brief, lattice rollout_check.
- Ensure docs still mention koala only as legacy alias, historical state, adapter, or package identity.

## CHK-002
Make user-facing CLI help and hints prefer lattice.

Steps:
- Update CLI long help / hint rendering so user command examples say lattice by default.
- Update story_create, dispatch, checklist reload, validation stale hints, doctor/check/session text where they recommend user commands.
- Keep koala-review-* lane IDs, .koala paths, KOALA_* env vars, @koala-agent/core, and bin/koala-codex.js names unchanged.
- Add a small helper if needed so help text can consistently choose the primary command label.

Verify:
- lattice story_create --help does not recommend koala story_create/session_brief in user examples.
- lattice session_brief next-step text prefers lattice.
- Legacy koala alias still works and reports itself as legacy.

## CHK-003
Add read-only lattice rollout_check command.

Steps:
- Add a core rollout checker that accepts explicit projects and optional root scan.
- For each project, collect path, git/non-git status, lattice/koala version/realpath, lattice_config_doctor status, session_brief status, doctor status, check status, and transcript lifecycle readiness.
- Normalize project result to pass/warn/fail with nextAction and short evidence snippets.
- Register rollout_check in cli-engine/registry under a Lattice-oriented category.
- Default to read-only: no check --apply, no repair, no writes to scanned projects.

Verify:
- JSON output is stable and includes summary counts.
- Text output is compact and actionable.
- Non-project and external-project cases become WARN/SKIP style results, not opaque failures.

## CHK-004
Verify rollout_check and lattice command semantics across real projects.

Steps:
- Add smoke tests for rollout_check using temporary fixture projects.
- Add checks for transcript lifecycle readiness using the B-f3db path classification rule.
- Add tests for help/hint strings that should prefer lattice while preserving koala alias compatibility.
- Record a TEST transcript from real project patrol over Orchestrate, Koala/Koala, plasmid, minicell, OpenCli, and avalon.

Verify:
- npm --prefix packages/main run build.
- npm run test:process-fact-contract.
- npm run test:flow-stability-smoke.
- npm run lint:tasks.
- npm run test:rollout-check-smoke or the equivalent package task.
- lattice rollout_check --projects <real paths> --json shows per-project PASS/WARN/FAIL with next actions.

## Non-goals
- Do not rename .koala state directories.
- Do not rename koala-review-* reviewer lanes.
- Do not rename @koala-agent/core.
- Do not remove the koala binary alias.
- Do not mutate external projects during rollout_check.
