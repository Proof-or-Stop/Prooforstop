# B-bdce real-machine acceptance transcript + diff

## Expected (PLAN outcome)
The EVIDENCE STALE block (session_brief / `lattice validate` / story_advance pre-check) now also
shows a "Drift class:" line + a `lattice done_prepare --storyId=... --mergeMain --refreshStale
--validate` one-step line, in addition to the existing refresh_stale + validate lines.
verification-freshness-smoke passes with the new 8-line block + GAP1/GAP2 regression. npm test green.

## Actual (run from the story worktree)

RED (before the fix, red/spike): `node /tmp/red-stale-hint.mjs` exited 1 — the rendered hint
contained neither `done_prepare` nor a drift-classification token.

After the fix, the rendered EVIDENCE STALE block is:
```
⚠ EVIDENCE STALE (materialHash drift after abc1234): 1 verification intent(s) stale for B-xxxx
  Meaning: stale means the recorded HEAD/material hash binding changed; it does not necessarily mean the verification logic failed.
  Drift class: whole-tree materialHash drift with UNCHANGED story-owned files (storyFilesHash) is usually unrelated/main drift (refresh, do not re-review); a storyFilesHash change is story-owned drift that needs re-review/re-quorum.
  Run to recover:
    lattice verification_evidence_refresh_stale --storyId=B-xxxx
    lattice validate --story=B-xxxx --json
  Or, when converging TEST to DONE, do the ordered recovery in one step:
    lattice done_prepare --storyId=B-xxxx --mergeMain --refreshStale --validate
```

```
$ npm --prefix packages/main run build        # clean (tsc)
$ node packages/main/dist/tasks/verification-freshness-smoke.js
✓ verification freshness smoke passed          # 8-line block + GAP1/GAP2 + 3-surface byte-equality
$ node packages/main/dist/tasks/flow-stability-smoke.js
✓ flow stability smoke passed                  # unedited, unaffected
$ lattice validate (REVIEW->TEST preflight + DEV->TEST gate)
CLI gate preflight: all pass; validate PASS (30 commands), writing test-evidence.json
```

## Diff (expected vs actual)
No difference. The two new lines are present and the three surfaces inherit them byte-identically;
the existing recovery lines are preserved; all smokes + validate are green.

## Note
The english-open-source-surface-smoke is RED on main due to PRE-EXISTING CJK in OTHER files
(review-assurance-floor.ts:350 keyword regex + experience-layer-ab-shadow-gate-smoke.ts:234 fixture)
— not introduced by this story (evidence-stale-hint.ts is ASCII-only, 0 CJK hits) and not part of
the npm test chain. Out of scope.

## Limitations
The drift-class wording reflects the CURRENT storyFilesHash-secondary behavior (B-6de6/B-d243); if
proof-admissibility enforce mode later tightens the materialHash-only downgrade, the wording may need
a follow-up. Metadata-only dirty-state specifics live in done_prepare/lifecycle_check (B-ce03), not
restated here.
