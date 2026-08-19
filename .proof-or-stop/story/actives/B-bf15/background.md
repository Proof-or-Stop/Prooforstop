## Trigger Event
On 2026-07-10, during story B-70e9 (host-usage-capture lifecycle), the implementer reported in passing that npm run test:autopilot-resume-smoke in packages/main fails with a missing-file error. Investigation confirmed packages/main/package.json:70 references dist/tasks/autopilot-resume-smoke.js whose source src/tasks/autopilot-resume-smoke.ts was deleted by commit 5d3d7bd686 (Complete Authority Server retirement cleanup).

## Key Insights
Only this one npm script points at a deleted source (a scripted audit of every node dist/*.js entry in packages/main/package.json found exactly one stale mapping). The dist file still exists on long-lived checkouts as an untracked stale build artifact, so the failure only surfaces in fresh worktrees — which is exactly where CI-like flows and story worktrees run. run-all-smokes and packages/main/src contain no references to the smoke, and docs/requirements/decisions/autopilot-v2-reliability-execution-plan.md:403 mentions it only as historical B-320f evidence.

## Solution Tradeoffs
Removal is preferred over repointing: the smoke verified checkpoint-ledger-backed resume projection against the Authority boundary, and that subsystem was retired wholesale in 5d3d7bd686; the surviving autopilot-v2-reliability-smoke.ts covers the current autopilot reliability behavior. Recreating an equivalent smoke would resurrect retired-subsystem coverage and is out of scope for a cleanup chore. Historical decision-doc mentions stay untouched as evidence records.

## Conversational Texture
The user filed this as a small pre-existing chore found in passing, explicitly asking for the stale script to be removed or repointed via the normal story workflow. The visible outcome they care about: npm scripts in packages/main all resolve to real, buildable entry points, and no one loses time to a phantom smoke failing in fresh worktrees.
