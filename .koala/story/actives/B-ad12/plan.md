# B-ad12 Plan

## CHK-001
Add the durable review run data model and handler. Extend core types/store with review-runs.json, implement sign/verify helpers, add review_run_start CLI schema/registry wiring, and record head/material hash from the current git state. The command should reject invalid reviewer lanes or missing active review round.

## CHK-002
Thread reviewRunId through review_pass_set and finding_add, including pass-only finding normalization. Extend signed finding/pass payloads and verification to validate the referenced review run. Update REVIEW gate and reviewer status to require valid current-round run-bound evidence for current stories while retaining compatibility for legacy stories without a currentReviewRound. Keep flow-fact-policy and testing-infra truth-source semantics synchronized.

## CHK-003
Update reviewer prompts, story dispatch text, process-fact registry, command policy, phase tools, and verify-process-fact-contract so review_run_start/review-runs.json are first-class gate evidence. Prompt guidance must cover every REVIEW lane that can emit pass/finding evidence across packages/main/templates/agents plus .claude/.Codex mirrors: concept, quality, test-coverage, docs, behavior, and channel.

## CHK-004
Add regression coverage in flow-stability/field-regression/review-pass smokes and process-fact contract checks. Cover happy path run-bound evidence and adversarial missing/stale/wrong-lane/wrong-round/pre-review evidence rejection with actionable gate messages.
