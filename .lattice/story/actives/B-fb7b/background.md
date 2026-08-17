## Trigger Event
During B-3783 (2026-08-14, DONE-required validation), the root npm test full suite failed only because packages/utils/dist/index.js was not built. validate.commands[0] auto-built packages/main but nothing built packages/utils, so full-suite sub-tests that invoke bin/lattice.js hit bootstrap-runner.js and exited with Missing build artifacts. The utils build had to be run by hand to recover, costing time.

## Key Insights
The full suite runner has no pretest step, and none of the 93 validate.commands entries build utils (they all run node packages/main/dist/... directly, needing only main). Only bin/lattice.js and the full-suite sub-tests that spawn it require packages/utils/dist, so the utils build is silently mandatory yet never automated. dist is gitignored, so rebuilding it during bootstrap does not dirty the tree — the existing main build in validate.commands[0] already proves build-in-validation is safe.

## Solution Tradeoffs
Prefer a minimal idiomatic fix: a root pretest script building both packages/main and packages/utils before the suite, mirroring the existing main-only build but closing the utils gap where utils is actually needed. This avoids touching the sensitive worktree-creation handler or adding auto-build magic to bootstrap-runner.js; the interactive bin/lattice.js recovery hint stays as-is for humans running commands directly.

## Conversational Texture
The user repeatedly hit worktree-needs-utils-build as a recurring pitfall and wants it permanently filled so nobody must remember to build utils by hand; the fix should be small, aimed at the real automated pain (done_required / full suite), and must not expand scope into worktree bootstrapping.
