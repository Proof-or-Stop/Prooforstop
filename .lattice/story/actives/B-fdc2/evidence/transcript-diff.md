# B-fdc2 real-machine verification — transcript & diff

Real-machine test of F-007 (flow-stability test #7 import-isolation scan retarget),
run 2026-05-19 in the B-fdc2 worktree.

## Expected (CHK-001 userSees)

koala validate green; flow-stability-smoke.ts section (7) import-isolation guard
now scans core/done-oracle.ts and core/validation-executor.ts (story-advance.ts no
longer in the list) and reports PASS — done-oracle.ts has no inline
DIRTY_WORKTREE_CATEGORIES literal.

## Actual transcript

1. Retargeted scan list — `flow-stability-smoke.ts:452`:

   ```
   for (const rel of ['core/done-oracle.ts', 'core/validation-executor.ts']) {
   ```

   `handlers/story-advance.ts` is gone; `core/done-oracle.ts` is in.

2. The guard now genuinely scans `core/done-oracle.ts` — not an empty scan.
   `done-oracle.ts` actually contains DIRTY_WORKTREE_CATEGORIES category words:

   ```
   535:  // 6c. declared-artifacts committed (B-8db9 CHK-003): declared_artifact_changes
   541:  //     REVIEW/TEST keep treating declared_artifact_changes as non-blocking.
   ```

   Both are `//` comment lines, which the guard's `trimmed.startsWith('//')`
   filter correctly skips → 0 offending → PASS. The guard processes real content
   here, unlike the old target `handlers/story-advance.ts` (a thin handler with
   zero category-literal occurrences — a genuine empty scan).

3. `npm --prefix packages/main run test:flow-stability-smoke` → `✓ flow stability smoke passed`.

4. `koala validate --story=B-fdc2` → `✓ ALL PASS`; verification policy
   express-exempt (express channel, 1 checklist item, no riskSignals).

## Diff (expected vs actual)

No differences. The import-isolation guard (B-4b22 preMortem #3 anchor) now
covers the real `evaluateDirtyGate` consumer `core/done-oracle.ts` and still
passes (done-oracle.ts imports the categories from dirty-gate-policy.js with no
inline literal). The verified-low coverage gap from B-META-framework-audit:F-007
is closed. No runtime behavior, dirty-gate policy, or lifecycle semantics
changed — this was a test-target retarget only.
