# B-6e69 Plan — Extract CLI runtime root activity and ownership gates

## Scope

Extract Round 3 runtime/gate helpers from packages/main/src/cli-engine.ts into focused packages/main/src/cli modules while preserving compatibility exports and all owner/reviewer/activity gate behavior. This story must not move command catalog/schema definitions, flag parsing, aliases, lifecycle special dispatch, INIT_CHECK metadata sync, or recover_evidence dispatch.

## CHK-001

Extract root resolution and activity policy helpers. Create packages/main/src/cli/runtime-root.ts and packages/main/src/cli/activity-policy.ts, then update cli-engine.ts to import and re-export the relevant helpers. Preserve root override handling, worktree-to-main fallback, activity skip policy, Codex/global-fallback source behavior, and readonly activity defaults.

Verification: build, process-fact contract, validate, and targeted inspection/evidence covering root fallback and activity policy invariants.

## CHK-002

Extract owner lease and reviewer gate helpers. Create packages/main/src/cli/ownership-gate.ts and packages/main/src/cli/reviewer-readonly-gate.ts. Move ownerLeaseHelpBlock, resolveEffectiveOwnershipClass, enforceStoryOwnerLeaseGate, reviewer readonly env helpers, and readonly gate enforcement behind those modules while keeping cli-engine compatibility exports. Preserve fail-closed ownership classification, takeover behavior, delivery reviewer exception, B-META/mainSharedMutating behavior, and reviewer readonly ordering before hooks/lease mutation.

Verification: command ownership contract, reviewer readonly command policy smoke, story owner lease smoke where feasible, build, and process-fact contract.

## CHK-003

Verify runtime and gate contract preservation. Run the configured validation suite plus focused smokes: npm --prefix packages/main run build, node scripts/verify-process-fact-contract.mjs, npm --prefix packages/main run test:command-ownership-contract, npm --prefix packages/main run test:main-write-lock-coverage, and node packages/main/dist/tasks/reviewer-readonly-command-policy-smoke.js after build. Confirm the diff does not move flag parsing, aliases, command catalog, lifecycle special dispatch, INIT_CHECK metadata sync, or recover_evidence dispatch.

Verification: validation evidence must bind to current HEAD/material hash and cover all 9 verificationIntent refs before REVIEW.

## Parallel/Merge Notes

B-74a0 may independently create packages/main/src/cli command catalog modules. This story uses disjoint file names under the same directory and should tolerate a later directory-level merge. B-a776 and B-57b5 should remain blocked until B-74a0/B-6e69 are integrated or deliberately rebased.
