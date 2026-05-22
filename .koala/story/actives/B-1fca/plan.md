# B-1fca plan: harden evidence quality and fact-forgery defenses

This story implements the remaining anti-fact-forgery milestones as one serial, single-story integration pass. The shared rule is: structured evidence quality, identity, provenance, freshness, and quorum checks must be mechanically evaluated by Koala gates, not accepted from natural-language reviewer claims.

Execution model:
- Claude Code CLI implements each checklist item in sequence.
- Codex supervises diffs, runs tests, records/validates evidence, and does not mark an item done until code and tests are committed.
- New logic must be profile-aware: strict blocks, balanced warns, light preserves compatibility unless an existing hard gate already blocks.
- All gate-consumed facts must be reflected in tests and, where relevant, process-fact/runtime contract checks.

## CHK-001 Add evidence quality scoring and weak-test gate

Implementation:
- Add a focused evidence-quality module that classifies verificationEvidence by signal strength and weak patterns such as echo/pass-only, version/help-only, commandless evidence, artifactless manual claims, or compile-only evidence without assertion coverage.
- Integrate the classifier into verification coverage and validate rendering so strict stories reject weak required evidence, balanced stories surface warnings, and light mode remains non-disruptive.
- Keep backward compatibility: legacy evidence with insufficient new fields should produce explicit unknown/weak diagnostics rather than silently becoming strong.

Verification:
- Unit/smoke tests must prove echo-only evidence is rejected in strict and warned in balanced.
- Tests must prove meaningful test command plus file/artifact/note remains accepted.
- Validate output must include actionable diagnostics naming the checklist item and weakness reason.

## CHK-002 Add reviewer quorum and differentiated verifier policy

Implementation:
- Add a reviewer-quorum module that evaluates high-risk story review evidence across required reviewer lanes and independent verifier metadata.
- Reuse existing reviewer lane/source-of-truth where possible instead of inventing a second reviewer list.
- Report missing lanes, unresolved disputes, same producer/verifier actor, and insufficient heterogeneous verifier metadata according to profile.

Verification:
- Tests must show strict blocks when high-risk quorum is missing or a verifier is not independent enough.
- Tests must show balanced warnings with the same data.
- Tests must show existing normal REVIEW lane behavior still passes when required lanes/pass evidence are present.

## CHK-003 Add structured CI and human attestation checks

Implementation:
- Extend evidence metadata types to support structured CI/human attestations: head/material binding, checked claims, command or artifact references, result, actor/source, and timestamp.
- Add an attestation evaluator that rejects empty human looks-good evidence and stale/claimless CI evidence in strict mode.
- Reuse material freshness rules so story metadata changes alone do not stale legitimate CI/human attestations.

Verification:
- Tests must prove empty human attestation cannot satisfy strict gates.
- Tests must prove stale CI attestation is diagnosed.
- Tests must prove claim-bound current-head attestation is accepted and metadata-only changes are not treated as material staleness.

## CHK-004 Add actor trust registry, revocation, and suspicious evidence signals

Implementation:
- Add actor-trust evaluation for evidence actor metadata without making the registry a new freely-editable truth source for pass/fail claims.
- Detect revoked actors, same-actor producer/verifier self-verification, missing actor identity on high-risk evidence, and suspicious always-pass patterns where available.
- Keep trust decisions auditable and profile-aware; strict blocks revoked/same-actor evidence, balanced warns, light stays compatible.

Verification:
- Tests must prove revoked actor evidence is blocked in strict.
- Tests must prove producerRunId/verifierRunId or actor identity equality is detected.
- Tests must prove trusted independent actors are accepted.

## CHK-005 Add external fact provenance and freshness policy

Implementation:
- Add fact-provenance metadata for explicit external_fact evidence: source URL/name, source class, fetchedAt, source hash or digest, freshness window, and conflict markers.
- Add evaluator that blocks missing/stale/secondary-only/conflicting external facts in strict and warns in balanced.
- Do not require provenance for ordinary non-external verification evidence or legacy story evidence.

Verification:
- Tests must prove explicit external_fact evidence without provenance fails strict validation.
- Tests must prove stale provenance and conflicting sources are diagnosed.
- Tests must prove current primary-source provenance with digest passes.

Cross-milestone validation:
- Run focused tests for all five new modules.
- Run npm/package tests relevant to Koala core gates.
- Run koala validate for B-1fca and record verificationEvidence for every checklist item.
- Before REVIEW, produce a concise diff review that confirms the five layers compose without duplicate diagnostics or bypasses.
