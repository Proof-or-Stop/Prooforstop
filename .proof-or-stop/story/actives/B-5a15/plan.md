# Plan: B-5a15 U-03 CausalEvidence DAG

## CHK-001: Give every pinned command a content-addressed execution key and run each unique key once

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/types.ts, packages/main/src/core/causal-evidence.ts, packages/main/src/handlers/checklist.ts
- Create: packages/main/src/core/causal-evidence.ts, packages/main/src/tasks/causal-evidence-smoke.ts
- Test: packages/main/tests/causal-evidence.test.mjs

**Verify**:
- `node packages/main/tests/causal-evidence.test.mjs`
- `npm --prefix packages/main run build`
- `proof-or-stop validate --story=B-5a15`

**DoneWhen**:
- The execution key binds realpath cwd, structured command/bootstrap spec, explicit inputs/storyFilesHash, effective redacted environment, runtime/tool version, and a stable selector-policy digest; structured selector IDs, not display counts, identify selector checks.
- A batch groups only exact keys, does not recursively re-execute aggregate child commands, runs each unique key once, persists one immutable receipt per key, and independently evaluates every selector with bounded redacted output.
- Changed cwd, command spec, inputs, environment, runtime/tool version, selector policy, story, or selector metadata rejects reuse; legacy/incomplete identity executes normally but is never upgraded in place or reused as PASS.
- A receipt collision, tampered key, or changed provenance fails closed; failed, timeout, infrastructure, cancelled, skipped, and partial executions are not reusable, and required coverage must be complete before reuse.

## CHK-002: Write CAS receipts before canonical evidence import and retry the transaction instead of re-running the command

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/causal-evidence.ts, packages/main/src/handlers/checklist.ts, packages/main/src/core/store.ts, packages/main/src/core/runtime-artifact-registry.ts
- Test: packages/main/tests/causal-evidence.test.mjs

**Verify**:
- `node packages/main/tests/causal-evidence.test.mjs`
- `npm --prefix packages/main run build`
- `proof-or-stop validate --story=B-5a15`

**DoneWhen**:
- The command result is persisted as immutable content-addressed bytes before canonical evidence import. The receipt is story-scoped runtime-owned evidence, registered with materialHash exclude, and canonical import references it without adopting pre-existing bytes or rewriting hashes.
- Canonical import/metadata/Git closeout is a separate idempotent transaction. Import failure, staged-before-index failure, or commit failure retries only that transaction; commandRerun and commitFailureReruns stay zero, and the original receipt hash is byte-for-byte stable.
- Retry revalidates the same material, environment, command, policy, lease, index/base, and execution key. Wrong key, tampered/hash-mismatched, raw/unsigned/receiptless, partial, or stale receipt cannot gate and cannot leave fresh-looking dirty state.
- Canonical import is isolated from receipt persistence, does not duplicate evidence, and never overwrites an existing CAS address with a different payload.

## CHK-003: Declare evidence dependency domains and stale only causally affected nodes

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/core/causal-evidence.ts, packages/main/src/core/evidence-freshness.ts, packages/main/src/core/certification-window.ts
- Test: packages/main/tests/causal-evidence.test.mjs

**Verify**:
- `node packages/main/tests/causal-evidence.test.mjs`
- `npm --prefix packages/main run build`
- `proof-or-stop validate --story=B-5a15`

**DoneWhen**:
- Source, test, build-input, manifest-semantic, integration, and review-subject domains are declarative, have distinct dependency hashes, and invalidate only the declared affected transitive closure. Dependency invalidation is shadow-compared before it is consumed; no hash or old output is rewritten or disguised as fresh.
- An unrelated whole-tree merge leaves specialized rerun at zero and emits an explicit advisory only where the causal consumer permits it; a related story-owned change reruns every affected node at 100%, leaves unaffected specialized nodes alone, and falseFresh is zero.
- Missing, ambiguous, legacy, or uncomputable domain identity falls back to strict materialHash freshness. storyFilesHash is secondary and never replaces materialHash; mismatch is stale, missing identity is strict fallback, and matching storyFilesHash plus material drift remains an explicit advisory only.
- CertificationWindow consumes the signed causal decision and rejects stale affected-node bypasses. DONE-required whole-tree validation remains strict; no causal advisory waives it. Current HEAD/materialHash/storyFilesHash bindings reject stale tuples, and signed delivery-check storyFilesHash cannot be forged or used to re-attest unrelated drift.

## CHK-004: Preflight expensive runs for CLI, worktree, Git index, lease, capability, and writable evidence targets

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/core/causal-evidence.ts, packages/main/src/handlers/checklist.ts, packages/main/src/handlers/verifier.ts
- Test: packages/main/tests/causal-evidence.test.mjs

**Verify**:
- `node packages/main/tests/causal-evidence.test.mjs`
- `npm --prefix packages/main run build`
- `proof-or-stop validate --story=B-5a15`

**DoneWhen**:
- Before any expensive child starts, an atomic preflight checks the authoritative CLI and canonical worktree, readable/current Git index, writer identity and lease, provider capability, declared resource availability, and writable evidence target. Runtime metadata dirt may be classified as permitted, but source/material dirt is not silently cleared.
- A failed check names the exact reason and failed resource/path, refuses before child launch, records zero command executions and zero partial evidence, and leaves lease/index/target unmodified. The preflight is not a freshness relaxation and readiness cannot be consumed as freshness.
- Revalidation catches a state change between PASS and launch. Missing, stale, forged, incomplete, or bypassed preflight rejects closed; no lower-level child path can evade the launch gate, and aggregate commands cannot recursively launch children without the same contract.
- Preflight capability/resource declarations and output/progress side-channel handling are bounded and redacted; infra failure is distinct from test failure, and no failed transaction leaves a fresh-looking dirty state.

## CHK-005: Report U-03 correctness and efficiency metrics without reducing assurance

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004
**Files**:
- Modify: packages/main/src/core/causal-evidence.ts, packages/main/src/handlers/checklist.ts, packages/main/src/handlers/verifier.ts, packages/main/src/core/process-fact-registry.ts
- Test: packages/main/tests/causal-evidence.test.mjs

**Verify**:
- `node packages/main/tests/causal-evidence.test.mjs`
- `npm --prefix packages/main run build`
- `proof-or-stop validate --story=B-5a15`
- `npm test`

**DoneWhen**:
- Structured and user-facing output reports intentCount, uniqueExecutionKeys, commandExecutions, cacheHitRate, command reruns, commitFailureReruns, unrelatedSpecializedRerun, affectedNodeRerun, and falseFresh from the canonical execution ledger, including a zero-safe empty plan and mixed reused/new receipts.
- Correctness is fail-closed: legacy or incomplete identity is non-reusable, tampering cannot change metrics, cache acceptance of stale input is zero, commit-failure command reruns are zero, unrelated specialized reruns are zero, affected-node rerun is 100%, and falseFresh is zero.
- Metrics do not count overlapping U-01/U-02 time, do not add a waiver, hide coverage, or remove reviewer/coverage lanes. A metrics PASS cannot advance a story while findings, stale evidence, missing coverage, strict whole-tree drift, or required commands remain unresolved.
- New gate-consumed execution-key, receipt, dependency, preflight, freshness, and metric semantics are registered in the process-fact registry and contract verification; final validation and DONE-required validation remain present and authoritative.
