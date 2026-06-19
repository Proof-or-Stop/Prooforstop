## Trigger Event
On 2026-06-19, after story B-5d18 (commit c2c124342) DONE-merged to local main, the operator expected the version to auto-increment but it did not. Investigation confirmed the DONE merge flow (done-effects.ts runDoneMainPackageBuildAfterMerge) already auto-REBUILDS packages/main/dist when build inputs change, but NO auto version bump exists anywhere (no git hook, husky, npm script, or handler logic; 0.3.6 to 0.3.7 to 0.3.8 were all manual chore:bump commits). This story builds the missing capability.

## Key Insights
The version lives in THREE sync points that rollout-check (rollout-check.ts ~line 302) enforces consistent: root package.json, packages/main/package.json, and lattice-brand.ts LATTICE_CLI_VERSION. Any auto-bump MUST update all three atomically or rollout-check fails. The natural insertion point is the DONE post-merge effect that already runs under the main write-lock and already rebuilds dist; bumping the version files there BEFORE the rebuild means the rebuilt dist reports the new version with no extra build step.

## Solution Tradeoffs
Bump patch-only on qualifying merges (operator decision), and only when material code changed by reusing the existing isDoneMainRuntimeBuildInput / shouldBuildDoneMainPackageForChangedPaths trigger so metadata-only (.lattice) merges never churn the version. Avoid semantic feat/minor inference (fragile signal) and avoid bumping on every DONE merge (version churn, diluted meaning). The bump commits on main under the existing DONE merge-lock so concurrent DONE merges serialize and never collide.

## Conversational Texture
The operator wants merge-to-local-main to auto-increment the version as a turnkey capability, having just hit the gap on B-5d18 and manually bumped to 0.3.9. They care that releasing feels automatic and that the three version points never silently drift out of sync.
