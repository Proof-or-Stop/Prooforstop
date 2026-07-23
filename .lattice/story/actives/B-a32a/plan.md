# B-a32a — Wave 1A independently derived coverage basis

## Scope

Implement only execution-plan Wave 1A: verifier-derived registered discovery, deterministic reconciliation, signed replayable receipt, bounded classification, planned-declaration/exclusion reconciliation, and read-only diagnostics. Wave 2 lifecycle gates, Wave 2A critic policy, Wave 3 evidence enforcement, Wave 3A explicit applicability selection, and Wave 4 rollout remain excluded.

## CHK-001 — Canonical coverage basis

Create the typed coverage-basis model and verifier-owned derivation. The only terminal classifications are `complete`, `partial`, and `unsupported`; unsupported profiles and incomplete discovery fail closed. No caller inventory can cause `complete`.

Verification proves a supported complete case, unsupported profile, and attempted caller-forged completeness.

## CHK-002 — Registered discovery adapters

Register the required TypeScript/Node discovery adapters and canonicalize their observations before deterministic union reconciliation. Record adapter identity/version/input/result digests. Missing required adapters, unexplained disagreements, or nondeterministic replay yield `partial`, never `complete`.

Verification includes stable replay plus omission and disagreement mutations.

## CHK-003 — Signed receipt and freshness binding

Use `acceptance_basis_generate` as the sole writer. It invokes the registered verifier and atomically persists a verifier-issued signed receipt using the canonical Story store. Bind verifier identity, adapter set/results, workspace identity, scope-check and scope-contract identities, topology digest/version, storyFilesHash, closureFilesHash, and issuance metadata. Recompute freshness and signature on read; stale or tampered receipts are rejected. The separate `acceptance_basis` command is a read-only renderer/getter and never writes or rebinds a receipt.

Update command/activity policy and process-fact levels/registry for the writer and signed artifact semantics; preserve the renderer as non-authoritative diagnostics.

## CHK-004 — Planned declarations and exclusions

Project frozen checklist file declarations from the existing acceptance-topology schema, compare them against independently discovered paths, and classify unmapped or invented declarations explicitly. At Wave 1A, an exclusion must carry an independently auditable decisionRef that resolves under the foundational decision schema and eligible decision kind; critic identity and exclusion-approval policy belong to Wave 2A and are not implemented here.

Verification includes deleted planned-path, invented-path, malformed/stale/unrelated decisionRef, and ineligible foundational-decision-kind mutations.

## CHK-005 — Diagnostics and adversarial proof

Expose `lattice acceptance_basis --storyId=<id> --json` as a read-only diagnostic over the latest receipt. Document fields and status semantics. Add a focused smoke that exercises both the production writer and read-only renderer/store path and proves success, unsupported behavior, adapter omission/disagreement, stale binding, signature/result tampering, caller-forgery rejection, planned-path reconciliation, and deterministic replay. Update package scripts/version files and process-fact contract verification.

## Sequencing and closeout

Implement in checklist order so later receipts consume the canonical basis and adapters. Commit business changes before marking each item done, record evidence against every must intent, then run focused smoke, build, process-fact contract, REVIEW lanes, genuine 3×2 quorum, TEST validation, delivery evidence, done-required validation, done_prepare, and DONE. Long commands run as a single PTY instance and are polled; unchanged formal suites are not duplicated.
