# Plan: B-88c7 inventory critic dispatch compatibility

## CHK-001: Separate inventory critic dispatch from topology proof prerequisites

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/story-dispatch.ts, packages/main/src/core/process-fact-registry.ts, scripts/verify-process-fact-contract.mjs, packages/main/templates/agents/proof-or-stop-review-topology-critic.md, .proof-or-stop-codex/agents/proof-or-stop-review-topology-critic.md, .claude/agents/proof-or-stop-review-topology-critic.md
- Modify: packages/main/src/core/prompt-registry.ts (registered exact prompt reconstruction digest)
- Test: packages/main/src/tasks/review-inventory-handler-smoke.ts

- Modify: packages/main/src/core/prompt-role-contract-registry.ts, packages/main/src/handlers/review-run.ts, packages/main/src/core/review-run.ts

**Execution**:
Use current signed OPEN inventory and REVIEW round to select completeness-only critic instructions. Preserve reviewer dispatch digest, host identity and round bindings. Outside that exact context preserve strict topology implementation provenance. Do not modify topology receipt signing helpers. Update canonical role and managed mirrors to obey the selected responsibility. Add real CLI regression cases before the fix, including ordinary-author success, invalid/missing/closed/stale inventory refusal, and no topology receipt authority. Keep completed-lane and independent-identity checks intact.

**Verify**:
- Build packages/main and packages/utils using their registered build commands.
- node packages/main/dist/tasks/review-inventory-handler-smoke.js prints its PASS marker.
- node scripts/verify-process-fact-contract.mjs --quiet prints Process-fact contract verification passed.
- Re-run the actual B-0208 critic dispatch using the repaired CLI, without fabricating its implementation history.
- Complete configured validate and DONE-required commands after current review evidence and certification admission.

**DoneWhen**:
- Valid inventory completeness dispatch works without dedicated implementer authorship.
- Invalid contexts cannot select the inventory-only path and topology proof protections remain intact.
- All declared executable intents have tool-owned evidence and independent review results.

## Verified finding F-001 repair
Register an immutable inventory-completeness role contract and select it only from a signed OPEN epoch matching the Story and review round, in both dispatch and ReviewRun creation. Reconstruct signed envelope integrity from the registered semantic digest so inventory finalization preserves historical verification. Reject unknown or tampered digests. Keep the default topology contract and receipt authority unchanged. Extend the real handler witness to full-envelope dispatch and run creation, ordinary-author success, invalid contexts, and post-finalization verification while retaining the legacy path.

## Verified F-002 and F-003 acceptance-blocking repair

- Modify packages/main/src/handlers/certification-window.ts; test packages/main/src/tasks/certification-window-smoke.ts. Existing dispatch/run, process registry/verifier and inventory smoke remain scoped.
- Authenticate and compare critic dispatch responsibility and inventory epoch at new ReviewRun creation, rejecting cancellation, finalization, rebegin and topology-to-inventory stale dispatch before publication; require redispatch. Preserve historical signed-run verification after finalization.
- Classify only canonical packages/main/templates/agents/*.md assets as manifest-semantic, consistent with rendered host agent assets. Bind blob changes/deletions, retain unknown siblings and ambiguous classification refusal, and exercise actual domain-hash derivation.
- Extend existing full-envelope handler regressions and process contract. Run certification-window smoke and the actual B88 template-domain probe, then refresh tool-owned coverage and independent reviews before PRE_CERT/validation.

- Modify packages/main/src/core/prompt-contracts.ts to type and digest-bind critic responsibility (topology-proof or inventory-completeness with epoch, wave, material/story-files cutoff). Reject missing or tampered context only for new critic run creation in both prompt modes; retain historical signed-run verification and metadata-only freshness semantics.

## Verified F-004 historical dispatch repair

- Modify packages/main/src/core/prompt-envelope.ts in addition to the existing scoped prompt contracts, run producer/consumer, handler smoke and process registry/verifier. Persist exact dispatchBindingDigest as an optional authenticated envelope field for new runs; historical verification resolves and validates that original dispatch. New-run latest/live checks remain unchanged.
- For pre-field history, require exact original launcherSpecDigest reconstruction from stored intent references/defaults. If original inputs are not recoverable, refuse without latest-dispatch or prompt-only fallback.
- Regression: create A/run A, cancel and begin B, dispatch/run B, verify both historical A and B; remove/tamper A binding while B remains valid and require refusal, retain stale A new-run refusal. Verify full/incremental envelope contracts and canonical legacy reconstruction.


### Verified F-005: selected eligibility contract

- Modify: packages/main/src/core/review-incremental-context.ts and the already scoped prompt envelope, producer, verifier, handler tests and process-fact contract files.
- Thread the same selected registered role semantics into incremental eligibility. New signed envelopes authenticate the eligibility semantic marker; historical records without it retain their original default-role eligibility calculation. Never infer the current responsibility from a prior envelope.
- Verify a real signed prior inventory PASS with unchanged role and material has no false FULL_ROLE_CONTRACT_CHANGED. Verify topology/inventory transitions retain FULL_ROLE_CONTRACT_CHANGED, optional marker tampering fails, and old/new historical envelopes stay verifiable after finalization.
- RED/GREEN: node /private/tmp/B-88c7-inventory-eligibility-probe.mjs; selector B-88c7 inventory eligibility contract: PASS.
