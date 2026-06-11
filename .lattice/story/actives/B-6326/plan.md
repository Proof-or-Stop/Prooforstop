# B-6326 Plan

## CHK-001
Create `packages/main/src/core/dirty-worktree.ts` as the shared dirty ownership helper. It will parse porcelain status lines into stable entries, normalize renamed paths, classify via existing `isStoryMetadataPath` and `findRuntimeArtifactEntry`, and keep source/config/fixture/generated-output examples material or unexpected until a later declaration story supplies allowlist data.

## CHK-002
Replace `story-advance.ts` raw dirty summary/hint with helper-rendered category output. `buildDoneChecklist` should keep status `fail` and blocking true when any dirty row exists in this story, but the detail and hint should expose category counts and samples. Session pre-check consumes `buildDoneChecklist`, so avoid a second renderer unless needed. Also update `validation-executor.ts` worktree pollution details to reuse the same classifier vocabulary for `koala validate` side-effect guard output, without downgrading validation pollution failure semantics.

## CHK-003
Add focused smoke coverage for the classifier and dirty output surfaces. Cover Koala story metadata, runtime artifacts, source/config dirty, fixture dirty, and the B-c9f5 BL21 lacZ product output path as undeclared unexpected. Verify the DONE gate hint and validate side-effect guard details include category labels while source/fixture/unexpected dirty still block.

## Validation
Run `npm --prefix packages/main run build`, `npm --prefix packages/main run test:flow-stability-smoke`, `npm --prefix packages/main run test:validation-protocol`, `npm --prefix packages/main run test:verification-freshness-smoke`, and `koala validate --story=B-6326 --json` after evidence is recorded.

## Rollback
If classifier behavior is too broad, revert the new helper integration and keep the existing raw dirty gate. Because this story is policy-conservative, rollback should only affect presentation and tests, not lifecycle state transitions.
