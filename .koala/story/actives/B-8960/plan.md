# B-8960 Plan

## CHK-001 Remove hardcoded runtime reviewer CLI path

Update scripts/verify-runtime-reviewer-contract.mjs so it locates the repository root from import.meta.url and tests packages/main/dist/cli.js from that checkout. Add an explicit existence check with a build hint, and keep the adversarial check that no .worktrees/B-* path is present.

## CHK-002 Block prompt/template reviewRound number drift

Update process fact contract scanning so agent templates and generated mirrors fail on bare reviewRound:number or F-035 numeric reviewRound snippets. Preserve the legitimate story_review.planReviewRound numeric PLAN count distinction while requiring signed finding/review pass reviewRound to remain ISO string.

## CHK-003 Make silent catch audit a baseline gate

Change scripts/audit-silent-catches.mjs from report-only to baseline-gated. Generate a committed baseline of existing uncategorized catch keys, compare current keys against it, and fail on any new uncategorized catch while allowing existing debt to remain explicit.

## CHK-004 Encode fresh-worker evidence boundary

Add hard contract wording/checks that observable worker proof comes from dispatch/process-event/commit evidence, not prompt-only claims. State the truthful boundary: Koala can verify assignment evidence but cannot prove a subagent had no prior context.

## CHK-005 Encode user-value delivery evidence boundary

Add hard contract wording/checks that user-value completion requires transcript/delivery evidence, and must not be represented as fully automated user approval. Keep product acceptance honest: evidence can be required mechanically; subjective user acceptance cannot be faked by prompt text.
