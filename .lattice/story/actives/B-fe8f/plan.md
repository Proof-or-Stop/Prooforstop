# Plan: B-fe8f Finding Ledger and Runtime Evidence Integrity

Execution order is deliberately serial: audit-first RED, Story 3A ledger, exact CAS/receipt, Story 3B runtime evidence, registry/query boundary, then full GREEN. B-03b7 and B-e6d9 remain outside this worktree until this Story is accepted and merged.

## CHK-001: RED: audit current primitives and reproduce only remaining Story 3 contract failures

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/store.ts, packages/main/src/handlers/finding.ts, packages/main/src/handlers/checklist.ts
- Create: packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs
- Test: packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs

**Verify**:
- `node packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs` prints `red.audit_summary:`
- Every demonstrated remaining contract prints `red.genuine_contract_failure:<reason>` and exits non-zero at the recorded pre-fix HEAD
- Existing serialized Finding write and Store atomic-replace behavior print passing characterization markers rather than fabricated failures

**DoneWhen**:
- The audit cites current source primitives and classifies each accepted Section 9.3 contract
- Each remaining gap has an executable, isolated RED and a pre-fix HEAD/material binding
- No production behavior or GREEN implementation is changed in the RED commit

## CHK-002: Implement Story 3A fenced exactly-once Finding ledger writes

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/store.ts, packages/main/src/core/types.ts, packages/main/src/handlers/finding.ts, packages/main/src/core/mkdir-lock.ts
- Create: packages/main/src/core/finding-ledger.ts
- Test: packages/main/src/tasks/finding-ledger-runtime-smoke.ts

**Verify**:
- `npm --prefix packages/main run build && node packages/main/dist/tasks/finding-ledger-runtime-smoke.js`
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
- Output includes `ledger.receipt_contract: PASS signedFields=complete`
- Output includes `ledger.exact_record_cas: PASS committed=true`
- Output includes `ledger.stale_cas: PASS semanticWrites=0`
- Receipt mutation, atomic bundle, callback crash and revoke/apply serialization matrices all pass

**DoneWhen**:
- FindingLedgerReceipt matches the accepted Section 6 schema and signature domain
- Exact record bytes, record IDs/hashes, current chain head and prior ledger digest are checked under one fence
- Conflict or callback refusal writes zero semantic rows
- Replay returns original IDs and never creates recursive receipts

## CHK-004: Implement content-addressed RuntimeEvidenceReceipt and artifact stability checks

**Owner**: lattice-implementer
**DependsOn**: CHK-003
**Files**:
- Modify: packages/main/src/core/types.ts, packages/main/src/core/evidence/artifact-store.ts
- Create: packages/main/src/core/runtime-evidence-receipt.ts
- Test: packages/main/src/tasks/finding-ledger-runtime-smoke.ts

**Verify**:
- Output includes `runtime.content_addressed_receipt: PASS blobs=complete signature=valid`
- Output includes `runtime.artifact_stability: PASS pre=true during=true post=true`
- Freshness, privacy, trust/storage, tamper, realpath and TOCTOU mutation matrices all pass

**DoneWhen**:
- Commands, outputs, environment and artifact manifest use immutable content-addressed blob refs
- Receipt binds source/material, toolchain, producer, trust and canonicalization policy
- Build-in-progress and pre/during/post artifact mutation cannot mint a gate-eligible receipt
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
- Story smoke prints `registry.story3_fact_contract: PASS`
- Story smoke prints `query.protected_read_only: PASS signedRows=true pathsExposed=0`
- Non-authority, command/phase, dependency and path-leakage mutation markers pass

**DoneWhen**:
- Atomic persistence and gate-eligible runtime evidence are registered at distinct authority levels
- Bare persistence rows cannot block, pass, unblock or transition lifecycle
- Public query rows are signed, deterministic and complete without protected paths
- Missing or tampered rows return deterministic refusal rather than partial results

## CHK-006: GREEN: prove ledger atomicity and runtime freshness contracts

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004, CHK-005
**Files**:
- Modify: package.json, packages/main/package.json
- Create: packages/main/src/tasks/finding-ledger-runtime-smoke.ts
- Test: packages/main/src/tasks/finding-ledger-runtime-smoke.ts, packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs, scripts/verify-process-fact-contract.mjs

**Verify**:
- `npm --prefix packages/main run build && node packages/main/dist/tasks/finding-ledger-runtime-smoke.js`
- Final output includes `Finding ledger integrity: PASS`, `Runtime evidence integrity: PASS`, and `green.story3_matrix: PASS`
- `node scripts/verify-process-fact-contract.mjs`
- `proof-or-stop validate --story=B-fe8f` in TEST after review evidence is complete

**DoneWhen**:
- Every genuine RED passes without weakening its assertion
- The complete concurrency, replay, CAS, crash, legacy, runtime, tamper, query, registry, rollback and dependency matrix passes
- Existing audit-characterized correct behavior remains green
- B-03b7 can depend only on the schema-neutral ledger/query contract and B-e6d9 remains unimplemented
