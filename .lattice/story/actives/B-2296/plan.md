# Plan: B-2296 Detect frozen-claim drift (evidence-integrity §5 follow-on, Phase 1 of 2)

Decision (recorded in decision_set): bidirectional binding — the material signal is bound to
**storyFilesHash** (option B: story-diff-scoped), and the normalized claim-digest is a co-equal
secondary trigger. Phase 1 is **detect + report only, NON-blocking**. Serial chain: 001 → 002 → 003 → 004.

## CHK-001: Define the frozen-claim snapshot record and a deterministic claim-normalization Fn

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/frozen-claim-drift.ts (pure Fn: normalizeClaim, claimDigest — no I/O)
- Modify: packages/main/src/core/types.ts (FrozenClaimSnapshot, FrozenClaimDriftAdvisory)
- Test: packages/main/src/tasks/frozen-claim-drift-smoke.ts (fn-level cases, RED-first)

**Verify**:
- `npm --prefix packages/main run build` compiles clean
- The smoke's normalization cases print green (whitespace collapse; identical/different digests)

**DoneWhen**:
- normalizeClaim(s) = trim + collapse internal whitespace runs to one space + strip trailing; deterministic, no semantic interpretation
- claimDigest = sha256 over the normalized string
- FrozenClaimSnapshot = { normalizedClaimDigest, storyFilesHash, headHash, attestedAt } (materialHash retained as informational; storyFilesHash is the drift-authoritative field per the decision)
- Whitespace-only differences yield an identical digest; a one-char non-whitespace difference yields a different digest

## CHK-002: Snapshot userSees at attestation time and detect bidirectional drift; classify legacy-unbound

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/checklist.ts (capture the snapshot once at status=done; reuse currentStoryFilesHash / checkEvidenceFreshnessForGit)
- Modify: packages/main/src/core/frozen-claim-drift.ts (detectDrift Fn)
- Test: packages/main/src/tasks/frozen-claim-drift-smoke.ts (integration cases)

**Verify**:
- `npm --prefix packages/main run build` compiles clean
- Smoke: material-drift, claim-edit, legacy-unbound, and unrelated-no-drift cases all green

**DoneWhen**:
- The snapshot is written exactly once, at the checklist_update status→done transition, and is immutable thereafter (never re-taken on a read)
- detectDrift(snapshot, current) returns driftKind ∈ {claim, material, both, none} plus classification ∈ {bound, legacy-unbound}: material drift when the story-owned storyFilesHash moved (rename-aware); claim drift when the normalized digest changed
- A userSees with no snapshot → classification=legacy-unbound (never an error)
- An unrelated (non-story-owned) file change → driftKind=none

## CHK-003: Surface drift as a structured, non-blocking FROZEN_CLAIM_DRIFT advisory at a read point

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**:
- Create: packages/main/src/handlers/frozen-claim-drift-check.ts (read-only handler)
- Modify: packages/main/src/cli/command-catalog.ts (register frozen_claim_drift_check)
- Test: packages/main/src/tasks/frozen-claim-drift-smoke.ts (CLI-level case)

**Verify**:
- `node bin/lattice.js frozen_claim_drift_check --storyId=<fixture>` prints the structured advisory for a drifted story and a clean report for a clean story
- The command writes no files/evidence and exits 0 in both cases

**DoneWhen**:
- Advisory schema: { code:'FROZEN_CLAIM_DRIFT', itemId, claimRef, previousDigest, currentDigest, previousStoryFilesHash, currentStoryFilesHash, driftKind, classification, actionRequired:'re_attestation' }
- Every schema constraint re-validated at runtime in the handler (CLAUDE.md handler runtime-revalidation convention), not only in Zod
- The command is strictly read-only and NON-blocking: it never changes any gate verdict (no edits to canPassReview / delivery / DONE gate logic)

## CHK-004: RED-first smoke covering both false-positive guards; register in validate + package.json

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: packages/main/src/tasks/frozen-claim-drift-smoke.ts (complete all five cases)
- Modify: lattice.config.json (validate.commands), package.json (test script)

**Verify**:
- `node bin/lattice.js validate` runs the frozen-claim-drift smoke and reports it green among the validate commands

**DoneWhen**:
- Deterministic, offline (no live network, no live claude -p)
- Five cases assert: (1) material drift under a frozen userSees → detected; (2) userSees text edited → detected; (3) unrelated file change → NO drift (false-positive guard); (4) whitespace-only userSees edit → NO drift (false-positive guard); (5) userSees with no snapshot → legacy-unbound
- An explicit assertion that the advisory is NON-blocking (does not fail any gate)
- Registered in lattice.config.json validate.commands and package.json scripts
