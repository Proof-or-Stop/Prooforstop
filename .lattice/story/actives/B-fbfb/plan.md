## CHK-001: Classify the five proof admissibility convergence gaps

**Owner**: main-agent

**Goal**: Keep the Red/Repro classification explicit before code changes.

**Steps**:
- Use `lattice gap_analyze {"format":"json"}` as the current red signal.
- Confirm four gaps are existing implementation-to-scanner mapping gaps.
- Confirm `verifierVersionSupported` needs real evaluator semantics.
- Keep the unrelated medium `currentDoneMaterialBinding` no-test gap outside this story.

**Files**:
- Read: `packages/main/src/core/proof-admissibility.ts`
- Read: `packages/main/src/core/proof-admissibility-binding.ts`
- Read: `packages/main/src/tasks/gap-analyze.ts`

**Verify**:
- `lattice gap_analyze {"format":"json"}` shows the same five high gaps before implementation.

**Rollback**:
- No source changes in this step.

## CHK-002: Implement verifier version admissibility support

**Owner**: main-agent

**Goal**: Add a real `verifierVersionSupported` contract to the shared evaluator.

**Steps**:
- Add a current proof admissibility verifier version constant.
- Add `verifierVersion` to admissibility checks.
- Add `supportedVerifierVersions` to proof surface definitions or an equivalent default support function.
- Reject missing verifier version with `missing_required_field`.
- Reject unsupported verifier version with a deterministic reason code.
- Have `buildProofAdmissibilityDiagnostic` inject the current verifier version for normal gate diagnostics.

**Files**:
- Modify: `packages/main/src/core/proof-admissibility.ts`
- Modify: `packages/main/src/core/proof-admissibility-gates.ts`
- Test: `packages/main/src/tasks/proof-admissibility-smoke.ts`
- Test: `packages/main/src/tasks/proof-admissibility-hardening-smoke.ts`

**Verify**:
- Direct evaluator accepts the current verifier version.
- Direct evaluator rejects missing verifier version.
- Direct evaluator rejects unsupported verifier version and cannot set `productionDoneEligible`.

**Rollback**:
- Revert only the verifier-version constant/check/test changes if they create false blocks.

## CHK-003: Bind schema and contract checks to convergence requirements

**Owner**: main-agent

**Goal**: Let `gap_analyze` see the existing schema/contract implementation facts without weakening requirements.

**Steps**:
- Add scanner-visible `@task B-fbfb` facts near the implemented checks/tests.
- Include the exact phrases `supportedSchemaVersion`, `contractVersionSupported`, `unsupported_schema_version`, and `unsupported_contract_version`.
- Do not rewrite `gap_analyze` matching or delete requirement text.

**Files**:
- Modify: `packages/main/src/core/proof-admissibility.ts`
- Modify: `packages/main/src/tasks/proof-admissibility-smoke.ts`

**Verify**:
- `lattice gap_analyze {"format":"json"}` no longer reports these four mapping gaps.
- Existing schema/contract smoke assertions still pass.

**Rollback**:
- Remove only the B-fbfb annotation blocks if scanner mapping causes unexpected annotation validation failures.

## CHK-004: Verify high convergence gaps are closed

**Owner**: main-agent

**Goal**: Prove the five targeted high gaps are gone while unrelated work stays out of scope.

**Steps**:
- Run build.
- Run proof admissibility smoke.
- Run proof admissibility hardening smoke.
- Run `lattice gap_analyze {"format":"json"}`.
- Run `lattice convergence_check`.
- Record verificationEvidence on checklist items.

**Files**:
- Test: `packages/main/src/tasks/proof-admissibility-smoke.ts`
- Test: `packages/main/src/tasks/proof-admissibility-hardening-smoke.ts`

**Verify**:
- Build passes.
- Smokes pass.
- The five high proof-admissibility gaps are absent.

**Rollback**:
- If convergence still reports the same five gaps, stop before server receipt cleanup and inspect scanner-visible annotation text.
