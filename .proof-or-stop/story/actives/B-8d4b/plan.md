# B-8d4b Execution Plan

## Scope and decision

Implement an experiment-only, read-only role-prompt A/B replay harness under `experiments/role-prompt-ab-replay/`. Reuse the canonical prompt measurement, digest, availability, and usage semantics already established by Stories 1-2. Do not add a production handler, lifecycle command, incremental eligibility, role migration, or budget gate. Historical code is data only and must never be executed.

## CHK-001 — Define and pin the replay experiment contract and sample corpus

Create a versioned canonical protocol and corpus manifest. Pin two arms, exact shared material inputs, model and controllable sampling metadata, estimator/contract versions, seeded run order, at least three repeats, and three classes with at least two samples each. Every critical/high oracle pins stable identity, semantic category, severity, trigger, source/claim binding and independent adjudication evidence. Validate digests, floors, duplicates and post-hoc mutation. Provider/tool/seed/cache dimensions that are not observable remain unavailable with a stable reason.

Verification: protocol/corpus selfcheck proves deterministic experiment identity and rejects any frozen-field mutation, missing class/repeat floor, duplicate sample or invalid adjudication.

## CHK-002 — Build a read-only historical-material replay harness

Reconstruct only pinned Git blobs or committed snapshot data by content digest; never checkout or execute historical code. Build both arms from one canonical material object and permit only the preregistered prompt-contract difference. Measure UTF-8 bytes, logical lines, estimated tokens, repetition and content digests using the canonical algorithms. Normalize ordering and paths deterministically. Reject caller-supplied results/digests, mutable live Story paths, traversal, symlink escape and cross-arm input drift.

Verification: repeated and reversed-order runs preserve core digests; meaningful material/model/tool/contract byte changes alter digests; source and current Story state remain byte-identical.

## CHK-003 — Record dispatch usage and finding measurements in an isolated experiment ledger

Write append-only identity-keyed rows only inside the experiment namespace. Bind every row to experiment/cell/attempt IDs and exact input, prompt, model/contract and finding-set digests. Keep assembled estimate, known dispatch, provider input/output/cache creation/cache read and latency/disposition as separate availability-aware dimensions. Preserve reported zero, keep missing dimensions null/unavailable, and do not double-count estimates after provider data. Reject raw prompt/completion/tool arguments, secrets, forged authority/gate flags, malformed counts and duplicate attempts.

Verification: schema and replay tests prove stable rows, retry identity, summary reconciliation and `gateEvidence=false`; production process-fact and normal usage-ledger consumers cannot ingest experiment rows.

## CHK-004 — Fail closed and prove production evidence zero drift

Compute per-metric conclusions: a valid assembled-prompt metric may be evaluable while provider cost remains unavailable. Missing/tampered/version-skewed material, arm asymmetry, incomplete sample floors, missing adjudication or invalid recall denominator yields `INCONCLUSIVE` with stable reason codes and no savings/recall claim. Capture canonical production evidence snapshots before and after normal, tamper, crash and retry selfchecks; require identical digests and no new production process event. Update the canonical decision document with delivered commands, claim boundary and current Story 3 status only after executable verification passes.

Verification: focused selfcheck covers valid replay, unavailable provider data, tamper/missing/version drift, retry/crash, experiment-artifact injection and production evidence no-drift. Run package build and relevant existing prompt/usage smokes to prevent contract regression.

## Sequencing and rollback

Implement in checklist order. Each item becomes done only after its mapped verificationIntent has command-backed evidence. Since output is experiment-only, rollback is deletion of the new experiment namespace and its documentation status update; production role flags and lifecycle gates remain untouched. Any discovery that requires a new production command, executing historical code, or enabling Story 4-7 behavior stops as scope drift and returns to PLAN.
