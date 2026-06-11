# Plan: B-37e9 DONE Oracle Extraction — move buildDoneChecklist into core/done-oracle.ts

## CHK-001: Extract buildDoneChecklist into core/done-oracle.ts

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/done-oracle.ts
- Modify: packages/main/src/handlers/story-advance.ts (remove the moved function body + helpers)

**Verify**:
- `npm --prefix packages/main run build` clean, no circular-import error
- `core/done-oracle.ts` exports `buildDoneChecklist`, `DoneCheckRow`, `doneCheckRow`
- `done-oracle.ts` does NOT import from `handlers/story-advance.js`

**DoneWhen**:
- `buildDoneChecklist` (story-advance.ts:306-874), `DoneCheckRow` alias, `doneCheckRow` factory, and every private DONE row-builder helper they depend on are moved into `done-oracle.ts`
- Function body is byte-identical — row order / status / blocking / label logic unchanged (mechanical move)
- story-advance.ts line count drops ~569 lines
- Dependency imports (loadConfig / resolveWorkflowPolicy / declared-artifact-gate / evidence-freshness / dirty-gate-policy / store reads) follow the function cleanly; no circular import

## CHK-002: Rewire story-advance.ts and session.ts to consume from done-oracle.ts

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/story-advance.ts (DONE gate at :1127 imports from core/done-oracle.js)
- Modify: packages/main/src/handlers/session.ts (session_brief DONE pre-check at :789 imports from core/done-oracle.js)
- Modify: packages/main/src/tasks/flow-stability-smoke.ts (update the buildDoneChecklist import path)

**Verify**:
- Both consumers import `buildDoneChecklist` from `core/done-oracle.js`
- A regression snapshot of buildDoneChecklist rows (id/status/blocking/label) for representative story states is byte-identical before vs after
- `koala validate` / `story_advance --phase=DONE` / `koala session_brief` produce the same DONE rows as before

**DoneWhen**:
- story-advance.ts:1127 and session.ts:789 both import from `core/done-oracle.js`
- If a thin re-export is kept in story-advance.ts for legacy test imports, it forwards to done-oracle.ts — exactly one implementation, no copy
- Regression snapshot test proves byte-identical rows

## CHK-003: Same-source contract test

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/tasks/flow-stability-smoke.ts (add `assertDoneOracleSameSource` block) or create a dedicated contract task

**Verify**:
- Contract test drives both the DONE gate path and the session_brief path against one story fixture and asserts identical rendered DONE rows
- Contract includes a static check that story-advance.ts and session.ts both import from `core/done-oracle.js`
- Existing DONE checklist smoke (flow-stability declared-artifacts-committed coverage) passes unchanged

**DoneWhen**:
- The contract proves same-source both behaviorally (identical rows from both paths) and structurally (both files import core/done-oracle.js)
- No existing test was weakened to accommodate the move
- `npm --prefix packages/main run test:flow-stability-smoke` green

## Validation

- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:flow-stability-smoke`
- `npm --prefix packages/main run test:validation-protocol`
- `npm --prefix packages/main run test:lifecycle-registry-contract` (Story 1 regression)
- `koala validate --story=B-37e9 --json`

## Rollback

The change is a relocation: reverting moves buildDoneChecklist back into story-advance.ts and restores the import paths. Because the function body is byte-identical, rollback is zero-behavior-risk. The new contract test can be kept or dropped independently.
