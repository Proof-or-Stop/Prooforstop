# B-271e Execution Plan

## Outcome
A contradictory delivery promise is rejected before artifact persistence with stable reason delivery_promise_outcome_contradiction. Valid promise states still close normally. Production core/handler code cannot route arbitrary SMOKE/TEST environment data into filesystem or process sinks, while ordinary runtime environment reads and sanitized bounded controls remain valid.

## CHK-001 — Make PASS evidence envelopes total and contradiction-safe

### Scope
Create a pure delivery-promise outcome normalizer as the single semantic owner for status, verifiedBy, evidence, and waiverReason combinations. The command schema rejects contradictions at the CLI boundary; delivery_check_set repeats runtime validation before signing/writing; machine and done-oracle consume the same predicate. Existing routine validation reuse semantics remain unchanged and its mutation matrix is a regression reference.

### Accepted states
- status=met or verified requires non-empty verifiedBy/evidence semantics after handler normalization.
- status=waived requires a waiverReason of at least 30 characters and must not carry verification claims.
- status=unverified must not carry verifiedBy or waiverReason and is unresolved/blocking.
- documented legacy rows with missing status are accepted only through one explicit compatibility rule and never convert an explicit unverified status into PASS.

### Files and implementation
Add packages/main/src/core/delivery-promise-outcome.ts; update types, command catalog, delivery handler, machine, done-oracle, process-fact registries, delivery freshness/flow tests, and process-fact contract. Reject before store.writeDeliveryCheck and include the promise path plus stable reason code without leaking content.

### Verification
Generate single-field mutations and pairwise contradictions covering missing, unknown, empty, mutually exclusive, and conflicting values. Run build, delivery-check-freshness smoke, flow-stability smoke, process-fact contract, and validation-evidence-reuse smoke to prove no reuse regression. Positive controls cover met, verified, waived, unresolved unverified, and the explicit legacy compatibility case.

## CHK-002 — Block production test seams from reaching side-effect sinks

### Scope
Bound scanning to packages/main/src/core and packages/main/src/handlers. Flag SMOKE/TEST-named environment values that flow directly or through simple locals into filesystem path sinks mkdir/write/rm/rename and process command or argument sinks exec/execFile/spawn. Exclude tasks and ordinary environment reads. Recognize only explicit bounded numeric/enum sanitizers and fixed-command selection as safe.

### Verifier seam migration
Remove the arbitrary LATTICE_VALIDATE_LOCK_SMOKE_POST_COMMAND_READY_FILE and HOLD_FILE path capability from production verifier logic. Preserve lock-race coverage using a capability-limited mechanism that cannot select arbitrary filesystem paths through CLI/environment input, and update validate-execution-lock smoke to prove the real lock ordering without production arbitrary-write capability.

### Guard implementation
Extend scripts/verify-process-fact-contract.mjs with a bounded TypeScript AST guard and embedded positive/negative fixtures. Negative cases include direct and local-propagated env path into writeFileSync and env executable/args into spawn. Positive cases include PATH/runtime reads, envPositiveInt-style bounded numbers, enum selection of fixed constants, and task-only test code. The live production scan must identify source location and sink in a stable diagnostic.

### Verification
Run build, validate-execution-lock smoke, process-fact contract, and focused negative/positive fixture assertions. Confirm the production scan reports PASS on current core/handlers after migration. No external hosts, network, fixture directory edits, or unrelated done_prepare refactor.

## Sequencing and rollback
Implement CHK-001 and its tests first, then CHK-002. Keep each checklist item in its own implementation commit. If the seam guard creates broad false positives, roll back the guard commit and narrow data-flow/sanitizer semantics; do not add blanket allowlists. If delivery compatibility breaks a valid legacy fixture, document the exact legacy row and encode one explicit compatibility branch rather than weakening explicit unverified rejection.
