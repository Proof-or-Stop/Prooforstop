# B-271e Execution Plan

## Outcome
Contradictory delivery promises fail before persistence with reason delivery_promise_outcome_contradiction; valid states continue normally. A fast independent production test-seam guard rejects arbitrary SMOKE/TEST-controlled filesystem or process targets while accepting ordinary env reads and mechanically sanitized bounded controls.

## CHK-001 — Make PASS evidence envelopes total and contradiction-safe

### Semantic owner and consumers
Create pure core/delivery-promise-outcome.ts as the total normalizer used by delivery_check_set, machine, and done-oracle. Command-catalog schema independently rejects the same contradictions at the CLI boundary. Update types plus L4 process-fact registry/levels and verify-process-fact-contract so all writer/reader consumers are mechanically pinned. Routine validation reuse behavior is unchanged; its existing complete mutation matrix is regression reference only.

### Exact accepted table
- status=met or verified normalizes to verified; the handler may derive verifiedBy=status:<status> to preserve documented current behavior; evidence is optional. waiverReason is forbidden.
- status=waived requires waiverReason length at least 30; verifiedBy is forbidden; evidence may explain the waiver but cannot convert it to verification.
- status=unverified is always unresolved/blocking; evidence is allowed as explanation, but verifiedBy and waiverReason are forbidden.
- missing status is legacy-compatible only as exactly one of: nonempty verifiedBy means verified, waiverReason length at least 30 means waived, or neither means unresolved. verifiedBy plus waiverReason is contradictory.
- empty strings normalize as absent before classification. Unknown statuses fail schema/runtime validation.

### Persistence and gate behavior
The handler classifies every row before signing or store.writeDeliveryCheck. Any invalid row aborts the entire write with stable reason delivery_promise_outcome_contradiction plus docPath. machine and done-oracle use the same classification and fail closed on invalid or unresolved rows, including hand-written legacy artifacts.

### Verification
Extend delivery-check-freshness and flow-stability smokes with accepted controls, every single-field mutation, pairwise contradictions, direct-handler and CLI paths, pre-write no-artifact assertion, and DONE readiness consumption. Run build, both smokes, process-fact contract, and validation-evidence-reuse smoke to prove no reuse change.

## CHK-002 — Block production test seams from reaching side-effect sinks

### Guard boundary
Create packages/main/src/tasks/production-test-seam-guard.ts as a fast TypeScript AST guard over packages/main/src/core and packages/main/src/handlers only. Wire it into lattice.config.json routine validate commands and root package.json npm test. Task source is excluded from its production scan.

### Forbidden flows
Reject SMOKE/TEST-named environment values that flow directly or through simple local aliases into filesystem path sinks mkdir/write/rm/rename and into process executable/argument sinks exec/execFile/spawn. Diagnostics identify source file, env key, sink, and stable reason. No whole-repository or interprocedural taint engine is added.

### Accepted controls
Allow ordinary environment reads with no side-effect flow; validated PATH/runtime selection; envPositiveInt-style positive integer values; explicit finite enum parsing that selects fixed constants; and fixed commands whose only env influence is a bounded sanitized number/enum. These are recognized by AST/data-flow rules and positive fixtures, never by whole-file allowlist. done-prepare stays unchanged only if it passes these mechanical rules.

### Verifier seam migration
Remove arbitrary LATTICE_VALIDATE_LOCK_SMOKE_POST_COMMAND_READY_FILE/HOLD_FILE path capability from production verifier. Preserve the lock-order race test with a capability-limited internal mechanism unavailable from CLI/environment and unable to accept caller-selected paths, then update validate-execution-lock smoke.

### Verification
Negative fixtures cover direct and simple-local env path to writeFileSync/mkdir/rm/rename and env executable/args to spawn/exec. Positive fixtures cover PATH reads, bounded numeric and enum controls, fixed commands, and task-only code. Run build, the new guard, validate-execution-lock smoke, and routine/root wiring assertions.

## Sequencing and rollback
Implement CHK-001 first, then CHK-002, one implementation commit each. Do not weaken explicit unverified rejection to preserve malformed artifacts. If guard false positives appear, narrow modeled flows/sanitizers and add exact controls; never add blanket file allowlists. No external hosts, network operations, fixture-directory edits, done-prepare timeout refactor, unrelated evidence migration, or review-policy changes.
