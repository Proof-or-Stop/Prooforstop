# B-3010 Runtime-Owned Agent Asset Inventory Plan

## Objective

Implement the first executable slice of the runtime-owned agent assets plan. The CLI should mechanically report where agent prompt assets resolve from, classify project-local prompt copies, and expose the result through existing diagnostics. This story is read-only for external project prompt assets. It does not delete, repair, migrate, or claim Authority completion.

## CHK-001

Create a small AgentAssetResolution projection in `packages/main/src/core/agent-asset-resolution.ts`. It should read the package prompt registry, compute the registry hash, inspect `.claude/agents` and `.Codex/agents`, and classify files as absent, matches-runtime, stale, or override. The projection must include a local Non-authority boundary and must not contain Authority completion fields.

## CHK-002

Consume the projection from existing diagnostics instead of adding a broad new workflow. Preferred surfaces are `verify_codex` / codex adapter checks and `rollout_check`. Output should include mode, promptRegistryHash, asset classification summary, and clear next action text. The checks must remain read-only.

## CHK-003

Detect stale project-local prompt assets without repair. A project with no prompt asset directories should be accepted as runtime-owned. Matching generated local prompts should be classified as matches-runtime. Modified local files should be classified as stale or override and left untouched.

## CHK-004

Add a regression smoke that builds temporary projects for absent, matching, stale, and full/local asset cases. The smoke must print a measurable token accounting line using bytes/4 approximate tokens and explicitly state that provider billing tokens are unavailable to the local CLI. Existing prompt-token and prompt-registry smokes must still pass.

## CHK-005

Complete Lattice lifecycle closure locally. REVIEW, TEST, delivery-check, summary, and DONE evidence must separate `localNonAuthorityAudit` from `authorityServerPath`. No local result may claim `receiptVerified`, `productionDone`, `authorityDone`, or `fullAuthorityDone`.

## Non-Goals

- No automatic deletion of `.claude/agents` or `.Codex/agents`.
- No migration command in this story.
- No broad artifact isolation framework.
- No Authority Server receipt claim without actual verified receipt.

## Token Accounting Rule

Record only mechanically measurable bytes and approximate tokens. The local CLI cannot observe provider billing tokens for this conversation or external host runs, so the final evidence must say that exact billing token usage is unavailable.
