## Trigger Event
On 2026-07-01, verifying two Codex code-review claims against the code confirmed both: review_run_start signs review-run hashes computed from signedWorkspaceRoot instead of the resolved metadataRoot (packages/main/src/core/review-run.ts:310 captureReviewRunSnapshot; consumers at :686 and :826). Related prior work: B-6666 F-001.

## Key Insights
currentMaterialHash/currentStoryFilesHash exclude story metadata via loadConfig(metadataRoot). On a wrapper-root layout with a custom storyDir, computing from signedWorkspaceRoot silently misses that storyDir and folds metadata into both hashes. captureReviewRunSnapshot never accepts metadataRoot, so the correct sibling fallback in buildReviewRunWorkspaceBinding is bypassed because a non-empty wrong value is always passed in. The two consumer freshness calls pass signedProjectRoot as metadataRoot, so production and consumption are symmetrically wrong.

## Solution Tradeoffs
Thread metadataRoot into captureReviewRunSnapshot/diagnoseReviewRunSnapshot at the source (fixes both material and story hashes at once) and into the two consumer freshness checks via run.workspaceBinding?.metadataRoot ?? projectRoot, rather than only patching storyFilesHash or relying on the already-bypassed fallback. Keep plain-repo / default-storyDir behavior byte-identical, matching how the DONE gate (done-oracle/done-prepare/verifier) already threads a distinct metadataRoot.

## Conversational Texture
The user asked to verify two Codex claims, both confirmed against the code, then requested the full Story flow with a red test + spike to nail the reproduction before any edit, since this touches signing / freshness gate semantics and must go through the state machine rather than a direct edit.
