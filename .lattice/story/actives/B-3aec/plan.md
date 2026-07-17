# B-3aec Execution Plan

## CHK-001 — Bound unattended host startup and execution

### Outcome
Automatic candidate routing refuses any launcher whose canonical unattended readiness is not positively established. The shared host runner distinguishes startup silence from total runtime, reports first-output timing and terminal reason, kills/reaps the child exactly once, and releases capacity on timeout or abort.

### Design
Reuse the existing canonical headless readiness classifier and the existing streaming host_run lifecycle. Add an optional startup or first-output deadline beside the existing total deadline. Clear the startup timer on the first stdout or stderr byte. Preserve backward-compatible defaults for callers that do not opt into startup control. Candidate proposal routing must perform readiness admission before invoking the proposal executor, while the actual execution watchdog remains necessary for probe-to-spawn drift.

### Verification
Use injected readiness rows, spies, and deterministic local Node child processes only. Cover positive readiness, every non-ready state, delayed first output, stderr-first output, silent startup timeout, early-output then total timeout, caller abort, timer/close/error races, child reap, and immediate slot reacquisition. Assert diagnostic-only fakes cannot set review or production assurance.

### Rollback
The startup deadline and readiness enforcement have separate configuration controls. Roll back launcher-specific startup budgets without disabling fail-closed unattended admission. Existing total timeout remains the final bound.

## CHK-002 — Complete and verify candidate routing specificity contracts

### Outcome
Generic lattice/proofbound/core/handlers vocabulary is recorded and filtered without causing a full-corpus scan. Exact relatedDocs, exact paths, registry references, typed risks, and current reviewer evidence remain protected candidates. Truncation escalates only when omitted relevance can affect the selected cutoff, and artifacts explain the decision consistently across shadow, warn, and enforce.

### Design
Retain the landed document-frequency implementation and extend its typed artifact explanation rather than replacing it. Separate structured risk signals from title/description/checklist prose. Materialize protected explicit sources before statistical filtering. Compute relevance-aware truncation from omitted score versus selected cutoff, with deterministic query-group and cutoff evidence. Carry configured rollout mode through handler, artifact, renderer, and gate.

### Verification
Use synthetic corpora and injected host proposals. Cover threshold equality and above-threshold filtering, generic-only floods, mixed specific terms, query/host permutation, each protected explicit-source class, below-cutoff safe truncation, cutoff-affecting escalation, malformed relevance evidence, typed high-risk escalation, and identical routing decisions with mode-specific presentation/gating.

### Cross-item scenarios
An admitted productive host may propose generic terms; those terms remain advisory and frequency-filtered, while explicit protected inputs survive. An unready or startup-timed-out host contributes no proposal and cannot force ambiguity or full scan by its absence alone. Host timeout diagnostics and candidate escalation reasons stay separate typed facts.

### Sequencing
Implement and verify shared host-run behavior first, then wire candidate readiness admission, then complete routing artifact semantics. Before final TEST evidence or assurance, synchronize main once and run validation only on the final merged material.
