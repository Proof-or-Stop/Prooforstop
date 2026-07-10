# B-4a78 Plan

## Objective

Make reviewer read coverage auditable evidence. The story upgrades reviewer read claims from unverifiable prose into signed structured readManifest fields, then adds a mechanical read-log path that can flag self-report mismatches and unrecorded full scans of docs/requirements/decisions/*.md.

## Boundaries

- Keep memory and playbook output advisory only; they do not become gate evidence.
- Preserve scan escalation. A reviewer may perform a broad read when justified, but must record scanEscalationReason.
- Do not weaken role separation or let the story owner self-sign reviewer evidence.
- Keep JSON stdout clean for CLI commands that support --json.

## Milestones

| Milestone | Checklist | Completion signal |
|---|---|---|
| M0 | boundary | Diff and plan stay inside read evidence, prompt, and smoke surfaces. |
| M1 | CHK-001 | scope_check_save rejects missing or invalid readManifest and signs valid readManifest. |
| M2 | CHK-002 | review_pass_set rejects missing or invalid readManifest and signs valid readManifest. |
| M3 | CHK-003 | Reviewer templates and dispatch prompts request the structured readManifest contract. |
| M4 | CHK-004/CHK-005 | Mechanical read-log evidence is digest-bound and mismatch/full-scan cases are flagged. |
| M5 | CHK-006 | Smoke and validation fail on readManifest or mismatch regressions. |

## CHK-001

Extend scope_check_save with a required readManifest field. First locate argument parsing, shape validation, persisted evidence, and signature hash construction. Add a shared normalizer for {filesReadFully, filesTriagedByName, scanEscalationReason}. Reject missing, non-array, non-string, duplicate, unsafe, or malformed values. Bind the normalized manifest into the existing signed scope-check material while preserving current exclusions for reviewer resolutions and open questions.

Verification: focused smoke covers missing readManifest rejection, valid manifest persistence, signature/hash drift when readManifest changes, and no regression to existing scope-check anti-self-absolution semantics.

## CHK-002

Extend review_pass_set with the same readManifest contract. Reuse the shared normalizer so scope and review evidence have the same shape and comparable ledger semantics. Persist readManifest with the review pass evidence and include it in the review pass signature/integrity domain.

Verification: focused smoke covers missing rejection, valid persistence, signature/hash drift on manifest changes, and inspectable stored evidence.

## CHK-003

Update scope-plan and REVIEW-phase reviewer instructions to ask reviewers to submit readManifest. The prompt text should state the exact shape, when to put files in filesReadFully vs filesTriagedByName, and when scanEscalationReason is required.

Verification: prompt/template smoke or grep-based guard confirms the contract is present in the relevant templates, while command smokes prove missing submissions are rejected by the gate.

## CHK-004

Implement the smallest safe mechanical read-log path. Prefer transcript-derived extraction if current dispatch already retains stream-json or can safely retain it; otherwise use the existing PreToolUse hook pattern as the lower-risk capture surface. The stored evidence must include normalized decisions-doc reads and a digest suitable for binding to a reviewer run.

Verification: fixture smoke feeds synthetic read-call events and proves normalized files, digest stability, and no accidental capture of unrelated non-decisions files.

## CHK-005

Flag mismatches between readManifest and the mechanical read log, and flag full-content decisions-doc scans without scanEscalationReason. This is a reporting/finding path, not a change to legitimate escalation behavior.

Verification: smoke covers exact match, triaged-only match, missing self-report entries, extra self-report entries, and full scan without scanEscalationReason.

## CHK-006

Extend reviewer-scan-budget-guard-smoke and any validate wiring needed so regressions are caught by normal validation. The smoke must cover both M1 and M2 surfaces and preserve JSON cleanliness.

Verification: run package build, focused reviewer scan guard smoke, process/runtime fact contract tests if touched, and full lattice validate for B-4a78 before review.
