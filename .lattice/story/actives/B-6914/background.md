## Trigger Event
On 2026-07-09, story B-90d6 reached DONE after changing CLI drivability code, docs/CLI.md, and tests, but package version remained 0.3.170 and no B-90d6 artifact or capability release provenance was visible. Investigation showed the changed path predicate would have required a bump, but the final merge was a fast-forward recovery-like path rather than the complete DONE post-merge finalizer.

## Key Insights
The product problem is not merely one missed number. Proofbound already has a normal DONE auto patch bump, but abnormal completion and done_recover can bypass or under-apply that finalizer. Separately, the documented version discipline says lockfiles are part of the synchronized version state, while the current bump code only updates package.json, packages/main/package.json, and LATTICE_CLI_VERSION.

## Solution Tradeoffs
Keep package semver separate from non-runtime artifact and capability ledgers, but ensure every runtime-changing DONE completion site runs the same version finalization before build/release ledger work. Avoid broad release/publish automation; remote publish remains human-approved. Prefer a focused regression over a larger release manager rewrite.

## Conversational Texture
The user is rightly worried that DONE without a consumable version makes CLI optimizations invisible to playbook memory and installed runtime users. The fix should be concrete and mechanical, with output and tests that make future agents unable to silently miss the version boundary again.
