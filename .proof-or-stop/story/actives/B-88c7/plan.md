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
