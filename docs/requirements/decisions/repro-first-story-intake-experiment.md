# Repro-First Story Intake Experiment

Status: B-0aa1 candidate-only MVP implemented.
Date: 2026-06-24.
Architecture baseline: `docs/evidence/evidence-platform-architecture.md`.

This document defines the Repro-First intake workflow. Repro-First captures
reviewed red evidence and optional spike evidence before creating the formal
delivery story. It improves story quality without creating a parallel DONE path.

## Purpose

For code-verifiable tasks, development can start with evidence instead of a
guess:

```text
problem report
  -> repro_probe
  -> repro_review_set
  -> optional spike_record / spike_review_set
  -> story_create_from_repro
  -> normal INIT_CHECK / PLAN / DEV / REVIEW / TEST / DONE
```

The product hypothesis is that code-verifiable bugfixes need fewer review loops
when the baseline failure is reproduced and reviewed before the story enters
implementation.

## Applicability

Use Repro-First for deterministic, code-verifiable work:

- parsers, validators, and normalization defects;
- CLI behavior regressions;
- lifecycle gates, locks, hashes, signatures, and receipt bugs;
- data transformations with known inputs and outputs;
- previously fixed bugs that need regression retention.

Do not require Repro-First for pure documentation edits, visual taste decisions,
urgent production incidents, or work that requires secrets/production-only data.

## Candidate-Only Boundary

Pre-story artifacts are immutable evidence candidates only:

- `repro_probe`;
- `repro_review_set`;
- `spike_record`;
- `spike_review_set`;
- `red_green_relation_create`;
- `red_green_relation_evaluate`;
- `regression_matrix_review_set`;
- `story_create_from_repro`.

They are not REVIEW, TEST, DONE, Authority, or production-gate proof.

Canonical artifact kinds used by Evidence Runtime are hyphenated:

- `repro-probe`
- `repro-review`
- `spike-record`
- `spike-review`
- `red-green-relation`
- `red-green-relation-evaluation`
- `regression-matrix-review`
- `story-evidence-binding`

CLI command names stay underscore-style, while artifact kinds stay canonicalized.
Storage for pre-story artifacts follows `.proof-or-stop/evidence/`.

### Canonical red/green binding

`red_green_relation_create` only records the baseline/current candidate linkage.
`red_green_relation_evaluate` records the derived evaluation result and must be
evaluated under the same runtime contract: no caller-side `commandEquivalence`
patch or bypass field; relation integrity is established from references.

Recommended required references for evaluation are:

- `baselineProbeArtifactRef`
- `currentProbeArtifactRef` (or explicit current command digest)
- `acceptanceRowRef`

The evaluation output can only be promoted to `red-green-relation-evaluation`
using verifier-produced digests and command-equivalence checks in the runtime.

Promotion is not an in-place scope mutation. `story_create_from_repro` creates a
new immutable `story-evidence-binding` that binds:

- story id;
- probe id and digest;
- repro review id and digest;
- optional spike id and digest;
- optional matrix review id;
- derived checklist refs;
- derived verification intent refs.

The original candidate remains `evidence-candidate`. Current green
`verificationEvidence` is produced later by DEV/TEST.

`story_create_from_repro` should only create a single immutable binding artifact
with replayable digest references (`storyId`, `sourceArtifactDigests`,
`checklistDigest`, `verificationIntentDigest`) and must not create
`verificationEvidence` directly.

## Probe Contract

`repro_probe` records the baseline observation:

| Field | Meaning |
|---|---|
| `candidateId` | Stable candidate id for this intake effort. |
| `taskSummary` | User-visible problem statement. |
| `eligibility` | Why the task is code-verifiable. |
| `reason` | Why the probe was created. |
| `commandSpec` | Structured command descriptor. |
| `expectedFailure` | Failure the baseline should show. |
| `expectedFailurePattern` | Pattern distinguishing the intended bug from setup noise. |
| `executionStatus` | `not_run`, `run_attempted`, or `confirmed_failing`. |
| `observedFailureSummary` | Human-readable summary. |
| `boundedOutputExcerpt` | Small non-secret excerpt. |
| `producerObservedClass` | `target-bug`, `bootstrap-noise`, `environment-noise`, or `unknown`. |
| `baselineHeadHash` | Optional git HEAD hash for the baseline where the probe was recorded. |
| `materialHash` | Optional material hash for the baseline where the probe was recorded. |

A probe can support Repro-First story creation only after a matching
`repro_review_set` records `verdict=red-reviewed` and
`reviewedFailureClass=target-bug`.

## Spike Contract

`spike_record` is disposable exploration linked to a probe. It answers why the
failure happens, how broad the scope is, and whether a clean fix seems feasible.

`spike_review_set` records whether the spike conclusion is confirmed,
inconclusive, or rejected. Spike artifacts may inform the future story, but they
are not delivery evidence.

## Red-Green Relation

`red_green_relation_create` links a baseline command/pattern to a current
command/pattern. `red_green_relation_evaluate` fails closed unless:

- the relation digest matches when supplied;
- the probe exists;
- the probe has a `red-reviewed` + `target-bug` review;
- the probe was not merely `not_run`;
- the baseline and current command specs match for the MVP comparison;
- both expected failure patterns are present.

The evaluation itself remains candidate-only. It does not complete a story.

## Story Creation

`story_create_from_repro` delegates to the existing `story_create` handler. It
must not write story files directly, bypass background validation, bypass
scope/execution boundaries, or create current `verificationEvidence`.

The resulting story still follows the normal lifecycle:

```text
INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE
```

## MVP Commands

| Command | Result |
|---|---|
| `repro_probe` | Creates a `repro-probe` artifact. |
| `repro_probe_get` | Reads a probe by artifact id. |
| `repro_review_set` | Creates a `repro-review` artifact. |
| `spike_record` | Creates a `spike-record` artifact. |
| `spike_review_set` | Creates a `spike-review` artifact. |
| `red_green_relation_create` | Creates a relation artifact. |
| `red_green_relation_evaluate` | Creates a fail-closed evaluation artifact. |
| `regression_matrix_review_set` | Creates a candidate matrix review artifact. |
| `story_create_from_repro` | Creates a story through existing story_create and writes a candidate binding. |

## Verification

The B-0aa1 smoke test is:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/repro-first-candidate-smoke.js
```

Expected final line:

```text
repro-first candidate smoke passed
```

The smoke proves the happy path, digest binding for nested command specs,
review-required relation evaluation, mismatch fail-closed behavior, rejected
probe blocking, story binding creation, and absence of `verificationEvidence`
from the candidate binding.
