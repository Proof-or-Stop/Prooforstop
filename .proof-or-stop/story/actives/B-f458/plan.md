# B-f458 M4.C1 Closeout Scope Trust Boundary

## Outcome
Canonical closeout metadata is trusted only through a closed path-and-writer set, semantic scope changes remain review-significant, and malformed or forged artifacts fail closed.

## Constraints
- Keep `scope_contract_acknowledge` DEV/REVIEW-only.
- Do not consolidate prompt bodies or overlap B-9188's `milestone-closeout.json` registration.
- Path trust never implies gate admissibility without schema, hash, freshness, provenance, lane, and semantic checks.
- A new review round never inherits an old pass without a separately designed signed re-attestation contract.

## CHK-001
Define explicit closed scope-defining and closeout-evidence classifications in the lifecycle/process-fact contracts. Bind each trusted path to its canonical CLI writer and reject unknown paths or mismatched writers.

## CHK-002
Create a shared deterministic composite semantic-scope digest over scope-contract rules plus relevant acknowledgement content/provenance, the validated milestone ledger, and the validated slice plan. Thread it through review-run binding and metadata-only reuse checks.

## CHK-003
Add shared runtime validators for milestone ledger, slice plan, parent rollup, and persisted delivery context. Recompute embedded ledgerHash, planHash, and rollupHash before use; make the canonical delivery-context writer validate the same shape consumed by readers.

## CHK-004
Classify canonical `parent_ledger_rollup_set` output as closeout evidence and preserve TEST when product/material diff and composite scope are unchanged. Keep source/test/docs and semantic-scope mutations routed through DEV/REVIEW.

## CHK-005
Add contract and transition regressions for each retention condition independently: product/material diff, existing scope binding, composite digest, allowlisted canonical closeout provenance, embedded validation, TEST acknowledgement rejection, and current-review-round isolation.

## Verification
Run the focused M4.C1 contract/regression suite, process-fact contract verification, relevant ProofStory/scope/delivery smoke suites, TypeScript build, and routine `lattice validate`. Each checklist's exact user-visible PASS line must appear in normal output.

## Rollback
The shared trust module and registry additions are isolated from prompt bodies. Reverting this story restores prior classification/retention behavior without reverting B-3928 or B-9188.
