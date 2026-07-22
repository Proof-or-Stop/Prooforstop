# B-a32a — Wave 1A independently derived coverage basis

## Scope

Implement only execution-plan Wave 1A: verifier-derived registered discovery, deterministic reconciliation, signed replayable receipt, bounded classification, planned-declaration/exclusion reconciliation, and read-only diagnostics. Wave 2 lifecycle gates, Wave 2A critic policy, Wave 3 evidence enforcement, Wave 3A transport, and Wave 4 rollout remain excluded.

## CHK-001 — Canonical coverage basis

Create the typed coverage-basis model and verifier-owned derivation. The only terminal classifications are `complete`, `partial`, and `unsupported`; unsupported profiles and incomplete discovery fail closed. No caller inventory can cause `complete`.

Verification proves a supported complete case, unsupported profile, and attempted caller-forged completeness.

## CHK-002 — Registered discovery adapters

Register the required TypeScript/Node discovery adapters and canonicalize their observations before deterministic union reconciliation. Record adapter identity/version/input/result digests. Missing required adapters, unexplained disagreements, or nondeterministic replay yield `partial`, never `complete`.

Verification includes stable replay plus omission and disagreement mutations.

## CHK-003 — Signed receipt and freshness binding

Persist a verifier-issued signed receipt using the canonical story store. Bind verifier identity, adapter set/results, workspace identity, scope-check and scope-contract identities, topology digest/version, storyFilesHash, closureFilesHash, and issuance metadata. Recompute freshness and signature on read; stale or tampered receipts are rejected.

Update command/activity policy and process-fact levels/registry for the new signed read-only artifact semantics.

## CHK-004 — Planned declarations and exclusions

Project frozen checklist file declarations from the existing acceptance-topology schema, compare them against independently discovered paths, and classify unmapped or invented declarations explicitly. Exclusions require decision references and eligible independent approval evidence; absent eligibility cannot hide basis paths.

Verification includes deleted planned-path, invented-path, and ineligible-exclusion mutations.

## CHK-005 — Diagnostics and adversarial proof

Expose `lattice acceptance_basis --storyId=<id> --json` as a read-only diagnostic. Document fields and status semantics. Add a focused smoke that exercises the production handler/store path and proves success, unsupported behavior, adapter omission/disagreement, stale binding, signature/result tampering, caller-forgery rejection, planned-path reconciliation, and deterministic replay. Update package scripts/version files and process-fact contract verification.

## Sequencing and closeout

Implement in checklist order so later receipts consume the canonical basis and adapters. Commit business changes before marking each item done, record evidence against every must intent, then run focused smoke, build, process-fact contract, REVIEW lanes, genuine 3×2 quorum, TEST validation, delivery evidence, done-required validation, done_prepare, and DONE. Long commands run as a single PTY instance and are polled; unchanged formal suites are not duplicated.
