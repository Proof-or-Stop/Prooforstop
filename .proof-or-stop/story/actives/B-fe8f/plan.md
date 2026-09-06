# Plan: B-fe8f Finding Ledger and Runtime Evidence Integrity

Execution is serial and dependency-safe: audit-first RED, Story 3A ledger, exact CAS and operation receipts, Story 3B runtime evidence through real CLI adapters, registry/query/dependency boundaries, then full GREEN. B-03b7 and B-e6d9 remain outside this worktree until their declared prerequisites are DONE and merged.

## CHK-001: RED: audit current primitives and reproduce only remaining Story 3 contract failures

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: none
- Create: packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs
- Test: packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs

**Verify**:
- `node packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs` prints `red.audit_summary:` and only genuine `red.genuine_contract_failure:<reason>` markers
- `proof-or-stop red_evidence_create` records the real failure, target, baseline hashes and expected GREEN command
- `proof-or-stop red_green_relation_create` plus `red_green_relation_evaluate` bind an unchanged assertion and prove the pre-fix target still fails
- Existing serialized Finding writes and Store atomic replacement remain passing characterization

**DoneWhen**:
- Production files are read-only audit inputs; the RED commit creates only the executable RED artifact plus CLI-owned evidence
- Every remaining gap has an isolated reproduction and pre-fix HEAD/material binding
- Official red evidence and a digest-bound relation exist and cannot be substituted or weakened
## CHK-002: Implement Story 3A fenced exactly-once Finding ledger writes

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/store.ts, packages/main/src/core/types.ts, packages/main/src/handlers/finding.ts, packages/main/src/core/mkdir-lock.ts
- Create: packages/main/src/core/finding-ledger.ts
- Test: packages/main/src/tasks/finding-ledger-runtime-smoke.ts

**Verify**:
- First run `npm --prefix packages/main run build`; mechanical evidence then pins the single allowlisted entrypoint `node packages/main/dist/tasks/finding-ledger-runtime-smoke.js` (no shell chaining)
- Output includes `ledger.concurrent_unique_appends: PASS rows=100 uniqueRecordIds=100`
- Output includes `ledger.idempotent_replay: PASS replays=100 newRows=0 sameIds=true`
- Output includes durable commit, stale fence, crash recovery, legacy binding, mixed transaction and lock-compatibility PASS markers

**DoneWhen**:
- Record IDs are collision-resistant and independent of mutable array length
- Idempotency replay returns original semantic and receipt IDs
- One fenced transaction durably publishes the complete snapshot only after file and directory sync
- Unsupported storage/capability assumptions and stale writers write nothing

## CHK-003: Implement exact-record CAS and signed FindingLedgerReceipt consumers

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**:
- Modify: packages/main/src/core/types.ts, packages/main/src/core/store.ts
- Create: packages/main/src/handlers/finding-ledger.ts
- Test: packages/main/src/tasks/finding-ledger-runtime-smoke.ts

**Verify**:
- `ledger.receipt_contract: PASS signedFields=complete`, `ledger.exact_record_cas: PASS committed=true`, and stale CAS zero-write markers pass
- `ledger.assessment_proposal_atomic: PASS proposalRows=1 receiptRows=1 recursiveReceipts=0`
- Assessment proposal authority/signature/exact-union/missing/stale/proposal-final rejection matrix passes
- Mandatory-repair classify/close and expiry-policy append-only, idempotency and half-visibility markers pass

**DoneWhen**:
- FindingLedgerReceipt matches the accepted schema/signature and never recursively receipts itself
- Exact record bytes, IDs/hashes, current chain head and prior ledger digest are checked under one fence
- append_assessment_proposal atomically persists one immutable proposal and one receipt; replay returns original IDs
- Mandatory-repair and expiry-policy records are append-only, unique, idempotent and atomic with manifest references
## CHK-004: Implement content-addressed RuntimeEvidenceReceipt and artifact stability checks

**Owner**: lattice-implementer
**DependsOn**: CHK-003
**Files**:
- Modify: packages/main/src/core/types.ts, packages/main/src/core/evidence/artifact-store.ts, packages/main/src/handlers/finding-ledger.ts, packages/main/src/registry.ts, packages/main/src/cli/command-catalog.ts, packages/main/src/core/command-policy.ts, packages/main/src/core/config.ts
- Create: packages/main/src/core/runtime-evidence-receipt.ts
- Test: packages/main/src/tasks/finding-ledger-runtime-smoke.ts

**Verify**:
- Real `finding_runtime_evidence_run` and `finding_runtime_evidence_verify` CLI handlers execute and verify the production adapter
- `runtime.content_addressed_receipt: PASS blobs=complete signature=valid`
- append_runtime_receipt replay returns the original record/receipt IDs with zero new rows
- append_runtime_receipt crash/retry leaves one complete record and no half-visible/duplicate rows
- Artifact stability, freshness, privacy, trust/storage, tamper, realpath and TOCTOU matrices pass

**DoneWhen**:
- Commands, outputs, allowlisted/redacted environment and artifact manifest use immutable content-addressed blob refs
- Runtime receipt binds source/material, toolchain, producer, trust and canonicalization policy
- append_runtime_receipt uses the Story 3A exactly-once ledger and recovers original IDs after crash/retry
- Build-in-progress and pre/during/post mutation cannot mint a current receipt
- Receipt proves executed bytes only and changes no lifecycle semantics
## CHK-005: Register Story 3 process facts and expose a protected read-only ledger query contract

**Owner**: lattice-implementer
**DependsOn**: CHK-003, CHK-004
**Files**:
- Modify: packages/main/src/registry.ts, packages/main/src/core/process-fact-levels.ts, packages/main/src/core/process-fact-registry.ts, scripts/verify-process-fact-contract.mjs
- Create: none
- Test: scripts/verify-process-fact-contract.mjs, packages/main/src/tasks/finding-ledger-runtime-smoke.ts

**Verify**:
- `node scripts/verify-process-fact-contract.mjs`
- Registry authority split and persistence non-authority markers pass
- `query.protected_read_only: PASS signedRows=true pathsExposed=0`
- `dependency.lifecycle_gate: PASS B-03b7=blocked_by_B-fe8f B-e6d9=blocked_by_B-fe8f+B-03b7 transitionWrites=0`
- Registry, command/phase, forbidden-import and path-leakage mutations fail

**DoneWhen**:
- Atomic persistence and gate-eligible runtime evidence are registered at distinct authority levels
- Bare persistence rows cannot block, pass, unblock or transition lifecycle
- finding_ledger_query returns signed deterministic complete rows without protected paths
- B-03b7 cannot advance before B-fe8f DONE/merged and B-e6d9 cannot advance before both prerequisites DONE/merged
## CHK-006: GREEN: prove ledger atomicity and runtime freshness contracts

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004, CHK-005
**Files**:
- Modify: package.json, package-lock.json, packages/main/package.json, packages/main/src/core/lattice-brand.ts
- Create: packages/main/src/tasks/finding-ledger-runtime-smoke.ts
- Test: packages/main/src/tasks/finding-ledger-runtime-smoke.ts, packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs, scripts/verify-process-fact-contract.mjs

**Verify**:
- Final smoke includes `Finding ledger integrity: PASS`, `Runtime evidence integrity: PASS`, and `green.story3_matrix: PASS`
- Official RED/GREEN relation evaluates baseline fail/current pass with unchanged assertion
- Merged-state dependency matrix releases B-03b7 only after B-fe8f and B-e6d9 only after both prerequisites
- Version smoke proves one patch increment across root/main packages, lockfile, lattice-brand.ts, local CLI and installed CLI
- `node scripts/verify-process-fact-contract.mjs` and routine TEST validation pass

**DoneWhen**:
- Every genuine RED turns GREEN without weakening the relation
- Complete concurrency, operation, runtime, tamper, query, registry, dependency, rollback and migration matrices pass
- Existing characterized behavior remains green
- CLI patch version is synchronized because this Story changes runtime behavior
- B-03b7 depends only on the merged schema-neutral contract and B-e6d9 remains unimplemented
