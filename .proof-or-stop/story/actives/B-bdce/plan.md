# Plan: B-bdce Enrich stale-evidence hint (done_prepare + drift classification)

## CHK-001: Enrich renderEvidenceStaleHint with done_prepare + drift-classification lines

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/evidence-stale-hint.ts

**Verify**:
- `npm --prefix packages/main run build` compiles.
- `renderEvidenceStaleHint(...)` output contains `done_prepare` AND a drift-class token (storyFilesHash/story-owned/whole-tree/unrelated).

**DoneWhen**:
- The renderer keeps the existing EVIDENCE_STALE_MARKER + Meaning + refresh_stale + validate lines, and ADDS (a) a drift-classification line and (b) a `lattice done_prepare --storyId=... --mergeMain --refreshStale --validate` one-step line. storyId-substituted (no literal placeholder). The 3 surfaces auto-inherit (not edited).

## CHK-002: Update the byte-equality smoke + add GAP1/GAP2 regression

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/tasks/verification-freshness-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/verification-freshness-smoke.js` prints its pass line.
- `npm test` green.

**DoneWhen**:
- The rendered-hint byte-equality asserts + the extractStaleBlock line-count slice (~593) are updated to the new output; GAP1 (contains done_prepare) + GAP2 (contains a drift-class token) regression asserts added. flow-stability-smoke.ts untouched (out of scope).
