# B-9812 Execution Plan

## CHK-001 — Establish a reproducible full-suite performance and coverage baseline

- Add a machine-readable canonical suite inventory derived from explicit root test members, not directory discovery.
- Record per-member wall time, status, attempt count, resource wait, and bounded output identity.
- Add a deterministic benchmark harness that runs from unique temporary clones after the required build and rejects missing, duplicate, skipped, or reordered required members.
- Preserve the measured 1688.9-second reference as diagnostic provenance without making machine-specific historical timing a gate.

## CHK-002 — Define and enforce a resource-isolation contract for concurrent tests

- Extend the manifest entry schema with an explicit resource class and validate every canonical member.
- Treat independent temporary-root tests as parallel-safe, repository readers as a shared read class, and mutable shared-root or unknown entries as exclusive/serial.
- Replace the unconstrained cursor pool with a scheduler that acquires compatible resource claims before spawn and reports wait time.
- Make timeout and interruption terminate the child process tree and keep the first observed failure terminal in canonical mode.
- Mutation-test shared-resource conflicts, unknown classification, timeout cleanup, and child leakage.

## CHK-003 — Eliminate duplicate acceptance rollout cohorts and repeated CLI cold starts

- Generate the expensive production cohort once per acceptance run and reuse the frozen digest-bound object for the real consumer checks.
- Keep representative production CLI cases for omission, forgery, freshness, and control behavior.
- Move threshold and artifact mutation matrices to the already initialized process while comparing their outputs to the real CLI sentinel path.
- Run independent cohort cases in isolated temporary repositories with bounded concurrency only after proving they do not share Git or runtime state.
- Preserve every diagnostic code, restoration assertion, reviewer lane, quorum, and signed-artifact check.

## CHK-004 — Reduce incremental-context and intent-hardening long tails without losing race coverage

- Split deterministic correctness checks from repeated burn-in loops.
- Keep canonical deterministic mixed-mask cases that kill the same overwrite, ABA, temporal-cutoff, and invalid-binding mutations.
- Expose repeated burn-in as an explicit stress mode and prove the canonical deterministic schedule detects the same injected failures.
- Batch or reuse initialized CLI context for intent-hardening matrices only where differential tests show byte-equivalent status, diagnostics, and persisted evidence.
- Report canonical and stress iteration counts explicitly so coverage cannot shrink silently.

## CHK-005 — Route canonical root npm test through the safe scheduler with complete membership

- Replace the root serial chain with a canonical runner mode driven by a frozen explicit member manifest.
- Keep focused npm test entries for diagnosis, while root npm test invokes the canonical manifest with fail-closed no-retry semantics.
- Validate manifest-to-script and script-to-manifest completeness, uniqueness, entrypoint existence, timeout, and resource class before spawning.
- Emit aggregate JSON and human summary with first-failure status, critical path, worker utilization, and resource-lock waits.
- Keep DONE-required policy pointed at root npm test and add a contract test that detects drift.

## CHK-006 — Prove three consecutive sub-five-minute runs and concurrency safety

- Build packages/main and packages/utils in a clean temporary clone using the same material under test.
- Execute root npm test three consecutive times, requiring each run to pass every canonical member in less than 300000 ms.
- Compare a jobs=1 run with the parallel result for membership, status, and critical evidence equivalence.
- Run deliberate mutations for omitted members, duplicate members, shared-path collision, first-run failure, timeout, process-tree leakage, and forged timing.
- Persist bounded benchmark artifacts outside the source tree and record the exact commands and results as verificationEvidence.
