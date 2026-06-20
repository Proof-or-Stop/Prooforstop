# B-3321 Plan

## Execution Boundary

Do:
- Create `docs/requirements/decisions/done-full-test-gate-execution-plan.md`.
- Document the verified DONE/full-test gate failure mode and the future implementation plan.
- Treat source/config/code paths as read-only evidence anchors for this story.
- Include implementation milestones, rollout policy, migration handling, validation commands, and 3-round/2-host audit requirements.

Do not:
- Implement runtime DONE gate code.
- Modify `lattice.config.json`, `package.json`, pre-push hooks, or TypeScript sources.
- Run full `npm test` in this planning story.
- Claim current main is red without running the full suite.

Stop conditions:
- Any reviewer asks to implement code instead of writing the plan.
- The document would require changing gate semantics during this story.
- Scope gate flags a write outside the target document.

Allowed modified file:
- `docs/requirements/decisions/done-full-test-gate-execution-plan.md`

Read-only evidence anchors:
- `lattice.config.json`
- `package.json`
- `packages/main/src/handlers/verifier.ts`
- `packages/main/src/handlers/phase-gates.ts`
- `packages/main/src/core/done-oracle.ts`
- `.githooks/pre-push`
- related lifecycle/testing decision docs

## CHK-001 Document the current failure mode and scope boundary

Steps:
1. State the exact verified failure mode: configured `validate.commands` is narrower than root `npm test`.
2. Cite the current command counts: 8 validate commands versus 22 root test steps.
3. Explain the code path: configured validation suppresses fallback discovery; TEST writes `test-evidence.json`; DONE consumes that artifact.
4. Clarify the edge case: this proves a gate gap, not that current main is red.
5. Record explicit non-goals for this story.

Verification:
- `rg` checks the document contains the source anchors and the red/current-main caveat.
- `git diff -- docs/requirements/decisions/done-full-test-gate-execution-plan.md` confirms only the target document changed.

## CHK-002 Specify the target gate design and rollout plan

Steps:
1. Choose the dedicated DONE/release-required validation profile as the target direction.
2. Define a candidate config model without freezing final implementation names prematurely.
3. Specify evidence shape: command receipts, pass/fail status, HEAD/material/storyFilesHash, stale/fail recovery hints.
4. Define Orchestrate self-host default policy: root `npm test` is required before local DONE/release closure.
5. Define external project behavior: opt-in/configurable, with no Orchestrate-specific cost by default.
6. Include rollout phases: schema, runner, done-oracle row, self-host config, migration, docs, and release/push alignment decision.
7. Include rollback/de-escalation and emergency bypass policy without claiming strong DONE.

Verification:
- Document includes milestones and stop conditions.
- Document rejects prompt-only policy and lists required code touchpoints for the future implementation story.

## CHK-003 Record validation and 3 round / 2 host audit requirements

Steps:
1. List concrete future smoke scenarios: missing full evidence blocks; failing full evidence blocks; stale full evidence blocks; configured subset green does not unlock DONE.
2. List minimal implementation validation commands, including build, focused smoke, `lattice validate`, and root `npm test` for final self-host proof.
3. Define expected artifacts and DONE row names for the future implementation.
4. Require 3 distinct review rounds with 2 independent hosts over the final material hash for the implementation story.
5. Document in-flight story handling and emergency/degraded handling.

Verification:
- Document includes 3x2 requirements using Codex CLI, Claude Code CLI, and Antigravity CLI naming where applicable.
- Document states degraded or bypass paths cannot claim full assurance, Authority, production, or full DONE strength.
