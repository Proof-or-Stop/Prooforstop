# Plan: B-56d3 Extract phase gates and non-DONE transition effects

## story_advance.ts responsibility map (PLAN understanding)

Survey of story-advance.ts (944 lines) concern boundaries — read-only, drives the extraction:

- **transition lookup / event resolution** — stays in story_advance for now (Story 3c orchestrator territory)
- **REVIEW→TEST CLI preflight** (~305-340) — already partly delegates to `review-preflight.ts` `runReviewCliGates`; the orchestration around it (logging, fail-closed catch, error shaping) is inline → **phase-gates.ts**
- **koala validate --json gate** + gate hint rendering (~437) — inline → **phase-gates.ts**
- **TEST→DONE done-oracle gate adapter** — inline (consumes done-oracle.ts from Phase 1) → **phase-gates.ts**
- **cwd / guard-failure adapter** — inline → **phase-gates.ts**
- **process metrics** `writeProcessMetrics` (~550) → **transition-effects.ts**
- **onPhaseChange hooks** `runHooks` (~556-577) → **transition-effects.ts**
- **REVIEW metadata auto-commit** `autoCommitStoryMetadata` (~580-582) → **transition-effects.ts**
- **relatedDocs reminder** (~585-593) → **transition-effects.ts**
- **next-step rendering** `nextSteps` map (~620) → **transition-effects.ts**
- **DONE merge / worktree cleanup** (~886-936) — **NOT this story** (Story 3b)

## CHK-001: Extract phase-gates.ts gate runner

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/phase-gates.ts
- Modify: packages/main/src/handlers/story-advance.ts (delegate to phase-gates.ts)

**Verify**:
- `npm --prefix packages/main run build` clean, no circular import
- `core/phase-gates.ts` exposes the gate runner (REVIEW→TEST preflight, validate gate, done-oracle gate adapter, cwd/guard adapter)
- REVIEW→TEST preflight import failure / validate throw / validate JSON-parse failure each still block TEST

**DoneWhen**:
- Gate runner moved verbatim — same try/catch structure, same fail-closed default, same error wording
- The koala validate gate may still write test-evidence.json — annotated explicitly as a behavior-preserving side effect (not forced pure here)
- story-advance.ts calls phase-gates.ts at the same call site; no inline gate body remains
- phase-gates.ts does not import handlers/story-advance.js; layering correct (handler-only deps stay behind a thin adapter)

## CHK-002: Extract transition-effects.ts non-DONE side effects

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/src/core/transition-effects.ts
- Modify: packages/main/src/handlers/story-advance.ts (delegate to transition-effects.ts)

**Verify**:
- `core/transition-effects.ts` holds process metrics / onPhaseChange hooks / REVIEW metadata auto-commit / relatedDocs reminder / next-step rendering
- DONE merge/cleanup is NOT in transition-effects.ts — it stays in story-advance.ts for Story 3b
- Effect order + output text byte-identical before vs after

**DoneWhen**:
- Non-DONE effects moved into transition-effects.ts; story-advance.ts delegates in the same order
- A regression snapshot of metrics / hook-stage-sequence / auto-commit report / hint text / next-step text for representative transitions asserts byte-identical
- transition-effects.ts does not import handlers/story-advance.js (no circular import)

## CHK-003: Regression-prove fail-closed gates + zero transition behavior change

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/tasks/flow-stability-smoke.ts (add `assertPhaseGatesAndEffectsExtraction` block)
- Modify: packages/main/src/tasks/validation-protocol-smoke.ts (validate-gate fail-closed regression)

**Verify**:
- `npm --prefix packages/main run build` + `test:flow-stability-smoke` + `test:validation-protocol` green
- Regression proves: preflight abnormal → fail-closed; validate throw / JSON-parse fail → blocks TEST; effect snapshot byte-identical
- Static import-check: phase-gates.ts / transition-effects.ts do not import handlers/story-advance.js

**DoneWhen**:
- story-advance.ts no longer contains the inline gate-runner or effect bodies — it delegates
- No TEST semantics change, no legacy phase change, no workflow profile change, no DONE merge extraction
- git diff scope limited to phase-gates.ts + transition-effects.ts + story-advance.ts delegation + tests

## Validation

- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:flow-stability-smoke`
- `npm --prefix packages/main run test:validation-protocol`
- `npm --prefix packages/main run test:lifecycle-registry-contract`
- `koala validate --story=B-56d3 --json`

## Rollback

All changes are extraction + delegation. Reverting moves the gate runner / effects back inline into story-advance.ts and restores import paths. Function bodies are byte-identical so rollback is zero-behavior-risk. DONE merge/cleanup is untouched.
