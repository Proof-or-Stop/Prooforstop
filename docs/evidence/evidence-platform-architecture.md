# Evidence Platform Architecture

Status: implementation baseline for the B-0aa1 candidate-only MVP.
Date: 2026-06-24.
Scope: shared local evidence artifact storage for Proofbound / Lattice CLI.

This document defines the evidence storage boundary used by Repro-First intake.
The B-0aa1 slice implements the artifact storage and repro intake portions only.
It does not implement Authority quorum, production gate consumption, ledger
waterlines, or full Proof Admissibility enforcement.

## Architecture Rule

Evidence-looking data must go through a shared evidence service instead of each
handler writing proof files directly. The intended layering is:

```text
CLI / REVIEW / TEST / DONE / Authority
                    |
                    v
             EvidenceRuntime
                    |
       +------------+-------------+
       |                          |
       v                          v
EvidenceArtifactService   ProofAdmissibilityService
       ^
       |
ReproIntakeService
```

B-0aa1 implements the local candidate artifact store and ReproIntakeService
needed for Repro-First intake. ProofAdmissibilityService remains future work.

## Artifact Envelope

Artifacts are immutable JSON envelopes:

```ts
interface EvidenceArtifact<TPayload> {
  artifactId: string;
  artifactKind: ArtifactKind;
  schemaVersion: "lattice.evidence.v1";
  createdAt: string;
  producer: string;
  evidenceScope: "evidence-candidate";
  subjectBinding: SubjectBinding;
  payload: TPayload;
  artifactDigest: string;
}
```

For this MVP, `evidenceScope` is always `evidence-candidate`. Candidate
artifacts are not REVIEW, TEST, DONE, Authority, or production-gate evidence.

## Storage Layout

Local storage lives under `.lattice/evidence`:

```text
.lattice/evidence/
  objects/sha256/<digest>.json
  refs/by-id/<artifactId>.json
  ledger/observed.jsonl
```

The object digest is a SHA-256 hash over a stable canonical subject containing:

- artifact kind;
- schema version;
- producer;
- evidence scope;
- subject binding;
- payload.

The digest intentionally includes nested payload fields such as
`commandSpec.command` and `commandSpec.args`. Rewriting a nested command changes
the digest. Rewriting the same canonical subject is idempotent and returns the
same stored artifact.

## MVP Artifact Kinds

B-0aa1 registers the following local artifact kinds in code:

| Kind | Purpose | Scope |
|---|---|---|
| `repro-probe` | Historical baseline failure candidate. | candidate-only |
| `repro-review` | Human/host review of the probe failure class. | candidate-only |
| `spike-record` | Disposable feasibility/root-cause exploration record. | candidate-only |
| `spike-review` | Review of a spike record. | candidate-only |
| `red-green-relation` | Baseline/current relation descriptor. | candidate-only |
| `red-green-evaluation` | Fail-closed evaluation of a relation. | candidate-only |
| `regression-matrix-review` | Candidate regression coverage review. | candidate-only |
| `story-evidence-binding` | Immutable binding from candidate evidence to a created story id. | candidate-only |

## Consumption Boundary

A candidate artifact may inform STORY_INTAKE. It must not satisfy a lifecycle
completion claim by itself. In particular:

- `story_create_from_repro` may create a story and a `story-evidence-binding`;
- the original candidate artifacts remain `evidence-candidate`;
- the binding does not create current `verificationEvidence`;
- green evidence is produced later by normal DEV/TEST commands;
- DONE/production gates must not consume these candidate artifacts as proof of
  completion.

The next admissibility-hardening story can add claim policies and waterlines on
top of this storage layer.
