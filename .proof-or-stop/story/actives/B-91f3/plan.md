## CHK-001: Classify Authority production receipt core dependency

**Owner**: main-agent

**Goal**: Identify the exact local core dependency before changing behavior.

**Steps**:
- Confirm `authority-receipt-ref` currently has `productionDoneEligible=true`.
- Confirm the matching smoke currently expects production eligibility.
- Keep Authority client networking and broad historical docs out of scope.

**Files**:
- Read/modify: `packages/main/src/core/proof-admissibility.ts`
- Read/modify: `packages/main/src/tasks/proof-admissibility-smoke.ts`
- Read/modify: `docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md`

**Verify**:
- `rg -n "productionDoneEligible: true|productionDoneEligible" packages/main/src/core/proof-admissibility.ts packages/main/src/tasks/proof-admissibility-smoke.ts`

**Rollback**:
- No behavior change in this classification step.

## CHK-002: Demote production receipt eligibility in local admissibility

**Owner**: lattice-implementer

**Goal**: Remove the local core route that marks server receipt refs as productionDone eligible.

**Steps**:
- Change `authority-receipt-ref` claim policy so production-completion remains evidence/admissibility status but `productionDoneEligible=false`.
- Update smoke expectations so matching authority receipt refs do not set local productionDone eligibility.
- Preserve fail-closed behavior for malformed, missing, stale, or unsupported versions.

**Files**:
- Modify: `packages/main/src/core/proof-admissibility.ts`
- Test: `packages/main/src/tasks/proof-admissibility-smoke.ts`

**Verify**:
- `node packages/main/dist/tasks/proof-admissibility-smoke.js` passes and asserts `productionDoneEligible=false` for the formerly positive authority receipt ref case.

**Rollback**:
- Revert only the claim policy and smoke expectation if local gates unexpectedly require this field.

## CHK-003: Update CLI proof vocabulary and tests

**Owner**: lattice-implementer

**Goal**: Make docs/tests speak in local proof vocabulary: `evidenceScope`, `assuranceLevel`, and admissibility status, not server production completion.

**Steps**:
- Update the proof-admissibility hardening decision doc to say server production receipt is external/future adapter scope.
- Update examples to make local productionDone unsupported by default.
- Keep wording honest: not deleted everywhere, just demoted from the local core path.

**Files**:
- Modify: `docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md`
- Modify/test: `packages/main/src/tasks/proof-admissibility-smoke.ts`

**Verify**:
- `rg -n "production-gate-decision|productionDoneEligible|productionDone = true|external adapter|CLI-first" docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md packages/main/src/tasks/proof-admissibility-smoke.ts`

**Rollback**:
- Keep the doc wording compatible with remaining Authority client code; do not remove external references wholesale.

## CHK-004: Verify local CLI-first admissibility boundary

**Owner**: main-agent

**Goal**: Prove the demotion did not reintroduce high gaps or break proof-admissibility checks.

**Steps**:
- Run build.
- Run proof-admissibility smoke.
- Run proof-admissibility hardening smoke.
- Run gap_analyze and convergence_check.
- Record checklist evidence and proceed through review/test/DONE gates.

**Files**:
- Test: `packages/main/src/tasks/proof-admissibility-smoke.ts`
- Test: `packages/main/src/tasks/proof-admissibility-hardening-smoke.ts`

**Verify**:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/proof-admissibility-smoke.js`
- `node packages/main/dist/tasks/proof-admissibility-hardening-smoke.js`
- `lattice gap_analyze {"format":"json"}`
- `lattice convergence_check`

**Rollback**:
- If high gaps return, stop and inspect changed requirement wording before proceeding to DONE.
