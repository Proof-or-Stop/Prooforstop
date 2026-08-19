# Plan — B-8128 Product Capability Release + Playbook Lineage Binding V1

Spec: docs/requirements/decisions/product-capability-release-playbook-lineage-execution-plan.md (revision 2, audited).
Architecture: mirror the proven core/artifact-release.ts + handlers/artifact-release.ts pattern (ledger, schemaVersion, sha256 idempotency, read-only handlers). Every persisted identity is deterministic and merge-stable (Design Principle 8).

## CHK-001 — M0 hermetic red evidence
Approach: a mkdtemp `.lattice` fixture (B-785e-shaped artifact release + PCR built by M1 + a 3-field-lineage candidate) asserts the candidate should reference the capability release and fails RED. Reads no live repo-root state. Flips green at M4 when the fixture candidate is produced by the real enrichment.
Rollback: if red for the wrong reason, correct the fixture, not the assertion.

## CHK-002 — M1 schema / ledger / fail-closed reader
Approach: core/capability-release.ts — ProductCapabilityReleaseRecord; capabilityDigest = sha256 over {capabilityId, capabilityKind, sorted capabilityPaths, artifactSetDigest??null} (merge-stable, no mainCommit/timestamp); idempotencyKey = storyId:capabilityId:capabilityDigest (mainCommit excluded); id = PCR-<24hex>; capabilityVersion = 12 hex after sha256: prefix; capabilityId slug fallback. readCapabilityReleaseLedger throws on parse error and on authority!==non_authoritative / gateEvidence!==false. Guard: no gate/DONE/validate/delivery module imports the reader. .gitignore un-ignores the ledger.
Pre-mortem: a tampered ledger row could be silently trusted → mitigated by fail-closed throw + guard test.

## CHK-003 — M2 DONE capability classifier (both sites)
Approach: a pure classifier fn in core/ (mirror selectArtifactReleasePathsV1) deciding capabilityKind + capability-declaring path subset; conservative (uncertain → no record + advisory). Invoked from BOTH runArtifactReleaseLedgerAfterDoneMerge callers: handlers/done-effects.ts:1167 and handlers/done-recover.ts:116, importing one source.
Pre-mortem: recover-path divergence → mitigated by single shared core fn + recover-path fixture.

## CHK-004 — M3 merge-stable release binding
Approach: recordCapabilityReleaseForDoneMerge appends via appendCapabilityReleaseRecord (dedup on idempotencyKey); bind storyId/mainCommit/artifact ids/changedPaths; commit ledger with git add -f (mirror commitArtifactReleaseLedgerIfNeeded). Recover-completed stories get provenance but no candidate.
Pre-mortem: duplicate on recovery re-merge → mitigated by mainCommit-free key + already_recorded test.

## CHK-005 — M4 lineage widening + candidate enrichment
Approach: add optional capabilityReleaseId/capabilityId/capabilityVersion/artifactReleaseId/artifactSetDigest to PlaybookLineage (experience-layer-types.ts:130); thread through PlaybookSeedCandidate → proposalFromSeed → lineageFromSeed; candidate ingest attaches them when a capability release exists. Idempotency on the stable source key (PBSRC-…), not digest equality; enrichment recomputes proposal/playbook digests. Update the M0 fixture to run the real enrichment → green.
Pre-mortem: widening breaks digest-based idempotency / stale-proposal rejection → mitigated by source-key idempotency + re-apply-no-op + 3-field-parse fixtures.

## CHK-006 — M5 read-only inspection CLI (5-site registration)
Approach: handlers/capability-release.ts (clone handlers/artifact-release.ts json/text + read-only asserts) exposing capability_release_list / capability_release_status; register in command-catalog, command-registry registerBatch, handler map, command-policy (readOnly/none/all mirroring :180-181), and config.ts DEFAULT_PHASE_TOOLS['*'] ('capability_release_*' wildcard), plus process-fact-levels L0. playbook_promotion_status gains a candidate-lineage column. docs/CLI.md documents the commands.
Pre-mortem: undefined command policy / phase-tool gating → mitigated by all five registration sites.

## CHK-010 — Validation
Approach: build (tsc) + run all four new smokes green + lattice validate PASS. M0 green after M4.

## CHK-011 — M6 assert (candidate inert)
Approach: capability-release-invariants-smoke asserts matchActivePlaybook excludes a status=candidate capability playbook (already-enforced invariant; no new mechanism).

## CHK-012 — M7 assert (DONE ≠ helped)
Approach: same smoke asserts a done-settlement outcome does not increment helped/decisiveSamples, while a structured non-done-settlement outcome does.

## CHK-013 — Hermetic backfill proof
Approach: same smoke runs a fixture B-785e-shaped dry-run/apply/idempotency proof (never the live PBP-882): dry-run detects one, apply enriches one, repeat idempotent, candidate stays candidate, surfacedCount unchanged, no helped inferred. The standalone capability_release_backfill CLI command is deferred to a follow-up story.
