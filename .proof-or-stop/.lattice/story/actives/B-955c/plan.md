# B-955c Execution Plan

## CHK-001
Freeze the responsibilities of Evidence Environment, EEA, Host Adapter, Domain Pack, Evidence Platform, Proof Admissibility, and Gate. Update the architecture and support matrix without assigning storage, truth, or completion authority to an adapter.

## CHK-002
Implement environment descriptor, invocation, command specification, receipt, normalized envelope, reason codes, read-only registry, legacy boundary mapping, canonical digests, and fail-closed normalization.

## CHK-003
Adapt receipts from the existing policy-authorized DONE-required validation executor as the execute-local reference path, and project existing Quantum read-receipt-only adapters into the common contract. Add no process launcher.

## CHK-004
Add the evidence-environment-adapter smoke covering registry validation, determinism, identity mismatch, non-pass status, receipt-only command injection, completion fields, provider substitution, untrusted producer identity, unsupported distinct-host quorum, Windows implicit-shell identity, and compound-shell identity.

## CHK-005
Update the paper-facing execution plan, Evidence Platform architecture, and README with M0-M5 implementation evidence, current support, limitations, and an explicit Level B external-manuscript handoff boundary. M6 remains open until an external manuscript revision and digest are bound.

## CHK-006
Reuse the done-required-evidence proof surface, DONE_REQUIRED consumer, Proof Admissibility reason codes, and existing lifecycle Gate. EEA receipts may support only declared claims and consumers, and adapters never receive completion authority.

## Verification order
Build first, then run EEA, Pack, Quantum, DONE-required, validation-reuse, documentation, and process-fact checks. Any fail-closed regression returns the Story to DEV.

## Out of scope
Do not implement Lean, Rosetta, AlphaFold, PINN solver, browser, database, CI, or Kubernetes adapters. Do not add remote Authority, arbitrary Pack-driven execution, or distinct-host quorum without a pinned cryptographic producer registry.
