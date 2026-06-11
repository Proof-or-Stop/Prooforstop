# Plan: B-a2f1 Make stale verificationEvidence recovery a one-step visible flow

## CHK-001: Detect stale verificationEvidence at user-visible entry points

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/evidence-stale-hint.ts (shared EVIDENCE_STALE_MARKER + renderEvidenceStaleHint(storyId) + computeStaleEntries reusing checkEvidenceFreshnessForGit)
- Modify: packages/main/src/handlers/session.ts (call renderEvidenceStaleHint when active story has stale evidence)
- Modify: packages/main/src/handlers/story-advance.ts (call renderEvidenceStaleHint in REVIEW/TEST/DONE pre-check surfaces)
- Modify: packages/main/src/handlers/hints.ts (replace ad-hoc stale hint at line 203 with renderEvidenceStaleHint)
- Test: packages/main/src/tasks/verification-freshness-smoke.ts (extend, do not create new file)

**Verify**:
- `koala session_brief` against a worktree with stale evidence prints EVIDENCE STALE marker
- `koala story_advance --phase=TEST --storyId=B-a2f1` against stale worktree prints same marker
- `koala validate --story=B-a2f1 --json` text output contains same marker

**DoneWhen**:
- evidence-stale-hint.ts exports EVIDENCE_STALE_MARKER constant + renderEvidenceStaleHint(storyId) function
- All three surfaces import and call the renderer; no duplicated marker strings
- Fresh evidence path does NOT print the marker (no false positives)

## CHK-002: Print copy-paste recovery commands in stale-evidence output

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/evidence-stale-hint.ts (renderEvidenceStaleHint emits the literal recovery block with actual storyId)
- Test: packages/main/src/tasks/verification-freshness-smoke.ts (assert byte-identical block across surfaces)

**Verify**:
- Output contains `koala verification_evidence_refresh_stale --storyId=<actual-id>` line
- Output contains `koala validate --story=<actual-id> --json` line
- Output does NOT contain placeholder strings `<storyId>` or `<B-xxx>`

**DoneWhen**:
- renderEvidenceStaleHint(storyId) emits the recovery block when storyId is provided
- Without storyId arg, the renderer omits the block (no placeholder leakage)
- Smoke test asserts byte-identical output from session_brief / story_advance / validate paths

## CHK-003: Add a single-shot recover_evidence command

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002 (depends on shared hint infrastructure)
**Files**:
- Create: packages/main/src/handlers/recover-evidence.ts (new handler: refuse-on-non-metadata-dirt → verification_evidence_refresh_stale → koala validate)
- Modify: packages/main/src/cli-engine.ts (register recover_evidence command with --storyId schema)
- Test: packages/main/src/tasks/verification-freshness-smoke.ts (covers happy path + refuse path)

**Verify**:
- `koala recover_evidence --storyId=B-a2f1` against stale worktree runs refresh + validate, exits 0
- Same command with unexpected_dirty_files present in worktree exits non-zero with `recover_evidence refused:` message
- Refuse-list uses an allowlist of DIRTY_WORKTREE_CATEGORIES (koala_metadata_changes + runtime_artifact_changes + declared_artifact_changes pass; everything else refuses)

**DoneWhen**:
- recover_evidence registered in cli-engine.ts with required --storyId
- Handler uses dirty-worktree classifier from B-6326 to classify worktree before refresh
- Allowlist (not blocklist) prevents future categories from silently passing
- Both transcripts (refresh + validate) printed to user; refresh transcript first

## CHK-004: Regression-prove the stale UX with simulated main-merge scenario

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: packages/main/src/tasks/verification-freshness-smoke.ts (add new assertion block: simulated main-merge case)

**Verify**:
- `npm --prefix packages/main run test:verification-freshness-smoke` prints `✓ verification freshness smoke passed` including the new stale-UX assertions
- Smoke covers: (1) stale state surfaces produce EVIDENCE STALE marker, (2) recover_evidence happy path, (3) recover_evidence refuse path

**DoneWhen**:
- Smoke fixture writes evidence with stale materialHash, calls session_brief / story_advance / validate, asserts each output contains EVIDENCE STALE
- Smoke calls recover_evidence on the stale fixture, asserts revalidate passes
- Smoke adds unexpected_dirty_files path, calls recover_evidence again, asserts non-zero exit + refused message
- All three surfaces produce byte-identical recovery block (regression anchor)

## Validation

Run after evidence is recorded:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:verification-freshness-smoke`
- `koala validate --story=B-a2f1 --json`

## Rollback

If recover_evidence reveals safety issues during REVIEW, the command can be removed without affecting other story work; the shared evidence-stale-hint.ts surfaces remain useful on their own. Reverting only requires removing the cli-engine.ts registration entry and deleting handlers/recover-evidence.ts.
