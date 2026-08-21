# Cross-Story Agent Session Performance: Root Causes and Prioritized Optimization Plan

Status: implementation decision record for B-5a15 (U-03)
Scope: reduce repeated verification work without weakening freshness, receipt, review, or DONE guarantees.

## Evidence boundary

This document is the source-backed plan for the U-03 implementation. Its primary
inputs are:

- `.proof-or-stop/story/actives/B-5a15/background.md` and `plan.md`;
- `packages/main/src/core/causal-evidence.ts`;
- `packages/main/src/handlers/checklist.ts` and `packages/main/src/handlers/verifier.ts`;
- `packages/main/src/core/evidence-freshness.ts`, `certification-window.ts`, and
  `runtime-artifact-registry.ts`;
- the causal-evidence, verifier-preflight, and tool-executed-evidence smoke tests.

The background records repeated per-intent execution, commit/import failure
reruns, and overly coarse freshness as the U-03 trigger. This record does not
claim an independent benchmark or a historical timing measurement; those claims
remain inputs to be measured by the story's verification evidence.

## Problem and outcome

Verification-heavy stories can repeat the same command for multiple intents,
rerun a command after a canonical evidence import or Git closeout failure, or
invalidate specialized evidence because an unrelated whole-tree change moved
`materialHash`. The desired outcome is observable and bounded:

1. exact execution identities are run once per batch;
2. a failed canonical import retries the import transaction, not the command;
3. unrelated whole-tree drift does not silently make specialized evidence fresh
   or trigger a needless specialized rerun; and
4. a related material or dependency change invalidates every affected node and
   never leaves a false-fresh result.

## U-03a: unique execution, CAS receipt, and import retry

`createCausalExecutionKey` in `causal-evidence.ts` builds the content-addressed
identity from the realpath working directory, structured command/bootstrap
specification, explicit inputs and `storyFilesHash`, effective redacted
environment, runtime/tool version, and selector-policy data. A selector is
identified by its stable selector ID and policy digest, not by a display count.

`createCausalEvidenceBatch` groups exact execution keys. The batch executes one
key once and evaluates each intent's selector independently against bounded,
redacted output. A PASS receipt is reusable only when its identity, schema,
status, material binding, selector coverage, and causal fields verify; failed,
timed-out, cancelled, partial, skipped, or incomplete receipts are not upgraded
into reusable PASS evidence.

The receipt path is separate from canonical checklist import. The CAS receipt is
written before canonical import, while `importCausalEvidenceReceipt` validates
the key, receipt hash, material identity, writer lease, and current facts before
performing the idempotent import transaction. Import retries may repeat the
transaction, but the receipt is not overwritten and the command is not rerun.
The story-scoped receipt/index paths are registered in
`runtime-artifact-registry.ts` as runtime artifacts excluded from the behavioral
material hash, so their persistence does not create a false material change.

The checklist handler has a separate safety rule: caller-supplied receipt fields
are untrusted. On bulk re-persist, trusted provenance can be carried only from
the existing on-disk row after semantic and material checks. Freshness hashes are
server-owned; exact semantic re-persistence may retain the old binding, while a
changed semantic field receives the current binding and cannot inherit authority.

## U-03b: dependency domains and precise invalidation

`causal-evidence.ts` models dependency nodes with declared dependency IDs and
input hashes. `evaluateCausalDependencies` computes the affected transitive
closure, distinguishes complete identity from strict fallback, and reports
`affectedNodeRerun`, `unrelatedSpecializedRerun`, `falseFresh`, and the explicit
`storyFilesHashAdvisory` state. A missing, ambiguous, legacy, or uncomputable
identity fails closed to strict material freshness.

`storyFilesHash` is secondary evidence, not a replacement for whole-tree
`materialHash`. A story-owned change is stale. Matching story files with changed
whole-tree material can only produce an explicit re-attestation advisory where
the consumer permits it; it is never a silent rebind and never rewrites stored
hashes. `CertificationWindow` consumes the signed causal dependency decision and
rejects stale affected-node bypasses. DONE-required build and full-suite
validation remains strict on whole-tree drift.

## Prioritized delivery

| Priority | Slice | Acceptance signal |
| --- | --- | --- |
| P0 | U-03a execution identity and one-run batching | unique execution keys equal the command execution plan; selector coverage is independent |
| P0 | U-03a CAS receipt and canonical import retry | receipt bytes remain immutable; import failure does not increment command reruns |
| P1 | U-03b dependency domains and closure | only affected nodes rerun; incomplete identity uses strict fallback |
| P1 | U-03b certification and freshness consumption | signed decisions reject stale affected nodes; unrelated drift is advisory only where allowed |
| P1 | lifecycle integration and metrics | review, coverage, validation, and DONE gates remain authoritative |

## Invariants

- A PASS from old material cannot satisfy a gate after a real related change.
- A stored receipt is never rewritten or rebound to a new material hash.
- A canonical import failure does not rerun the already completed command.
- A receipt collision, tampered key, incomplete selector set, or missing identity
  fails closed.
- Metrics are diagnostic facts, not waivers and not substitutes for review,
  coverage, validation, or DONE-required evidence.
- Unrelated whole-tree drift is visible as an advisory when a consumer permits
  the downgrade; it is never treated as fully fresh by implication.

## Verification matrix

The implementation evidence should include the focused causal-evidence and
verifier-preflight tests, the built smoke tasks, and the configured routine
validation. The full root test remains a separate broader check because the
configured validation list is not the complete root test list.

At minimum, retain coverage for:

- key identity changes and selector-level coverage;
- receipt reuse, collision/tamper rejection, and failed-run non-reuse;
- import retry with zero command reruns;
- dependency closure, unrelated drift advisory, related invalidation, and
  false-fresh zero;
- preflight refusal before child launch and last-moment state revalidation; and
- semantic evidence mutation receiving fresh server-owned bindings.

## Non-goals

This story does not own review-epoch design, generic session ownership policy,
or all later scoped re-review behavior. It does not weaken the reviewer,
coverage, validation, or DONE gates, and it does not turn diagnostic metrics into
completion authority.
