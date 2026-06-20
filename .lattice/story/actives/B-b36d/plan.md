# B-b36d Plan

## CHK-001 Rename and reposition the design around lifecycle readiness instead of pipeline execution

Goal: make the primary design read as a lifecycle readiness check, not an execution conveyor.

Actions:
- Rename the primary document title and introduction to Lattice Lifecycle Proof-Or-Stop Readiness Check.
- Use Lifecycle Readiness Check as the short name for the V1 concept.
- Replace V1-facing StoryPipelineReport language with StoryReadinessReport.
- Keep the existing broader automation material only as Full Vision / later layers.
- Update the SVG/title/alt text and navigation references if the file is renamed.

Verification:
- Grep the revised doc for the new title, short name, and StoryReadinessReport.
- Confirm remaining pipeline/story_pipeline terms are either historical/full-vision/later-command references or deliberately absent from V1.
- Confirm the document still preserves the full vision rather than deleting the roadmap.

Stop conditions:
- Do not implement CLI commands or schema changes in this story.
- Do not claim remote, production, or Authority completion.

## CHK-002 Constrain V1 to a read-only readiness control tower with exact next actions

Goal: make V1 a safe evidence radar that reads readiness and prints blockers, owners, and minimum next actions.

Actions:
- Add a V1 command surface such as lifecycle_check / story_readiness that is read-only by default.
- State V1 reads phase, git/worktree status, artifact snapshot, freshness, validation, reviewer lane status, delivery context status, and delegated done_prepare dry-run output.
- State V1 does not write evidence, launch reviewers, sign delivery checks, advance phases, refresh hashes, or replace done_prepare.
- Move PLAN skeleton generation, artifact producers, reviewer batching, refresh delegation, and top-level orchestration into later staged layers.

Verification:
- Grep V1 sections for read-only/no-mutation language.
- Confirm next actions include owner, reason, and exact command when available.
- Confirm DONE target delegates to done_prepare rather than calculating DONE readiness independently.

Stop conditions:
- If a section implies V1 mutation, rewrite it or move it to Full Vision.

## CHK-003 Patch the concrete contract gaps found in review

Goal: convert verified review gaps into precise document contracts.

Actions:
- Add exact rollback next-action commands for REVIEW to DEV and TEST to DEV paths.
- Split delivery blockers into artifact-only, material rework, manual decision, and external/remote categories with distinct owners and next actions.
- Rename default options to runCommands/writeEvidence or readOnly defaults so they cannot be mistaken for executable DONE automation.
- Clarify done_prepare report reuse around pre-merge and post-merge HEAD: pre-merge dry-run reports can explain blockers; mutation or new HEAD requires rerun before DONE readiness.
- Add a bounded refresh-only rule: one refresh pass per artifact snapshot, then rerun_required or manual if still stale.
- Remove degraded single-host gate-consumable wording from V1.

Verification:
- Grep the document for REVIEW to DEV, TEST to DEV, delivery blocker categories, runCommands/writeEvidence, preMergeHead/postMergeHead, and refresh pass limit language.
- Confirm the text prohibits direct hash rewriting and unbounded refresh loops.
- Confirm metadata-only waivers are narrow and cannot waive validation, review, delivery check, remote receipt, or DONE readiness.

Stop conditions:
- If a contract requires code implementation to be true, mark it as future implementation scope rather than claiming it already exists.
