# Plan — Auto-refresh the Experience Layer cache on DONE + coverage watermark/gap detection

Make the finding-signals cache self-accumulating AND trustworthy: it auto-refreshes
on every DONE merge, carries a coverage watermark, and learning_validate reports the
gap so a silently-missed refresh is detectable + recoverable. All advisory-only; no
gate reads the cache; the DONE merge is NEVER blocked.

## CHK-001

In `packages/main/src/handlers/done-effects.ts` `applyDoneMergeEffects` (after the
`bumpVersionOnDoneMerge` / `runDoneMainPackageBuildAfterMerge` calls ~890-896,
post-merge, in the main write-lock), add a never-throw advisory finding-signals
re-derive: call `deriveFindingSignalsFromStore(store, { projectRoot: <root> })`
(persists to the canonical MAIN cache via B-37b3 resolveLearningRoot). Run on EVERY
DONE merge (do NOT gate on shouldBuildDoneMainPackageForChangedPaths). Wrap in
try/catch — never throw/block; append an advisory mergeLines line
("experience cache refreshed (N signals)" or "...skipped: <reason>"). Do NOT change
learning-store.ts or version-bump.ts.

User sees: a DONE merge report line "experience cache refreshed (N signals)"; the
cache updatedAt + watermark advance to include the just-completed story — no manual
learning_scan.

## CHK-002

Smoke (`packages/main/src/tasks/*-smoke.ts` + npm wiring) driving a real DONE merge
for a story carrying a resolved finding → assert the cache is (re)written by
applyDoneMergeEffects (updatedAt advances / the new story's signal appears) without a
separate learning_scan; + a control proving a forced derive failure is swallowed
(advisory line, merge still succeeds). Prefer the real applyDoneMergeEffects path.

User sees: `node packages/main/dist/tasks/<smoke>.js` exits 0; full npm test green.

## CHK-003

Coverage watermark + gap detection (detect + recover silently-missed experience):
- In `core/experience-layer-types.ts`, extend the `FindingSignalsCache` type with
  ADDITIVE optional watermark fields: `coveredStoryCount`, `coveredFindingCount`,
  `coveredThrough` (max finding createdAt/resolvedAt folded in).
- In `core/finding-signals.ts` `deriveFindingSignals(FromStore)`, populate the
  watermark from the same sources/counting used to build the signals.
- In `core/experience-revalidation.ts` (pure leaf) add a `computeCoverageGap(cache,
  currentCounts)` and surface it in `handlers/learning-validate.ts`: compare the
  PERSISTED cache watermark (readFindingSignals) vs the current store
  (deriveFindingSignalsFromStore current) and print a coverage line. A cache WITHOUT
  watermark fields → "coverage: unknown — run learning_scan" (back-compat; never
  crash). Recovery = the existing learning_scan re-derive (closes the gap).
- Smoke: gap=0 right after learning_scan; gap=delta after adding a finding without a
  scan; a watermark-less cache → "unknown", no crash.

User sees: `lattice learning_validate` prints "coverage: N/N findings, 0 gap"
normally, or "coverage: 438/470 findings, 32 not yet summarized (cache behind; run
learning_scan)" when a refresh was missed; after learning_scan it returns to 0 gap.

## Verification approach

One DEV commit (done-effects + finding-signals + types + experience-revalidation +
learning-validate + smokes); build tsc-clean; run the new smokes + existing
experience-layer smokes; full npm test green; ONE review round (claude 3 lanes +
codex host-2); recover_evidence; TEST → DONE (auto-bump + auto-rebuild + now
auto-refresh all run on the merge — do NOT bump/rebuild manually).
