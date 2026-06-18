# Plan — B-a2e3: Experience Layer referential re-validation + valid-rate

Conservative step ① after Baseline A (8% referential drift). All work is advisory and read-only: no gate, no finding-lifecycle write, no scoring/promptHash change, nothing persisted.

## CHK-001 — Record anchor files on derived finding-signals

- In `core/experience-layer-types.ts`, add an optional `anchorFiles?: string[]` to `FindingSignal` (forward-compatible; placed next to `exampleFindingIds`), documented as the bounded union of the concrete file paths the composing findings referenced.
- In `core/finding-signals.ts`:
  - Add a `MAX_ANCHOR_FILES` constant mirroring `MAX_EXAMPLES`.
  - In `SignalAccumulator`, add `anchorFiles: Set<string>`; while iterating each finding, add every entry of `finding.files` (already string-filtered by `toSourceFinding`) until the cap is reached.
  - On finalize, emit `anchorFiles: [...entry.anchorFiles].sort()` only when non-empty (keeps signals without files clean).
- Do NOT change the `localSignature` key or the `signalScore`/`support` math.

## CHK-002 — Pure re-validation leaf (`core/experience-revalidation.ts`)

- New leaf importing ONLY `./experience-layer-types.js` (no `node:fs`, no `child_process`).
- `export interface SignalValidity { localSignature; category; anchorFiles: string[]; present: string[]; missing: string[]; state: 'valid' | 'stale' | 'unanchored'; }`
- `export function revalidateSignals(cache: FindingSignalsCache, fileExists: (p: string) => boolean): SignalValidity[]`
  - For each signal: partition `anchorFiles` into `present`/`missing` via `fileExists`. `unanchored` if `anchorFiles` is empty/absent; `valid` if `present.length >= 1`; else `stale`.
- `export interface ValidRateReport { total; anchored; valid; stale; unanchored; validRate; driftRate; staleSignals: SignalValidity[]; }`
- `export function computeValidRate(validity: SignalValidity[]): ValidRateReport`
  - `anchored = valid + stale`; `validRate = anchored ? valid / anchored : 0`; `driftRate = anchored ? stale / anchored : 0` (anchored-only denominator; never NaN).
- Deterministic, fs-free, no persisted output.

## CHK-003 — Read-only `learning_validate` handler + CLI command

- New `handlers/learning-validate.ts` (mirror `handlers/recall.ts` read-only shape):
  - `createLearningValidateHandlers(ctx)` returning `{ learning_validate(args) }`.
  - Build `fileExists` from the HEAD file set: own `execFileSync('git', ['ls-tree','-r','--name-only','-z','HEAD'])` wrapped in try/catch (empty set on failure, mirroring `currentMaterialHash`); membership via a `Set<string>`.
  - Derive signals via `deriveFindingSignalsFromStore(ctx.store, { now })` WITHOUT `projectRoot` (no persist). Optional `--story <id>` restricts `storyIds`.
  - Run `revalidateSignals` + `computeValidRate`; render the human report (counts, valid-rate, drift-rate, stale list) and, when `--json`, the `ValidRateReport` as JSON.
  - Files no findings, touches no gate, writes nothing.
- Register: `registry.ts` → `registry.registerBatch(createLearningValidateHandlers(ctx))`; `cli-engine.ts` → command entry `learning_validate` with schema `{ json?: boolean, story?: string }`.
- Phase/policy: add `learning_validate` to the `'*'` list in `core/config.ts` `DEFAULT_PHASE_TOOLS`, and a `core/command-policy.ts` entry `{ status:'supported', ownershipClass:'readOnly', allowedPhases:'all', destructiveRisk:'none', reason: '...read-only, writes nothing, no gate...' }`.

## CHK-004 — Smoke + npm script + verifier

- New `packages/main/src/tasks/experience-layer-revalidation-smoke.ts`:
  - Hermetic leaf test: synthetic `FindingSignalsCache` with known `anchorFiles`, an injected `fileExists` stub → assert exact `validRate`/`driftRate`, and that unanchored signals are excluded from the denominator, all-gone → stale, any-present → valid.
  - CLI test: derive over a small temp store / real store and assert a valid-rate line is printed and nothing is written.
  - Print `... smoke passed` on success.
- `packages/main/package.json`: add `"test:experience-layer-revalidation": "node dist/tasks/experience-layer-revalidation-smoke.js"`.
- Committed verifier `.lattice/story/actives/B-a2e3/evidence/verify-b-a2e3.mjs` (model on B-7561): build clean + this smoke passes + no-regression smokes (finding-signals/playbook/recall) + static checks (leaf imports only experience-layer-types.js; handler has no write/finding/gate refs; command + npm script + config/policy registered). Maps every verificationIntent ref; prints `TOTAL N | PASS N | FAIL 0`.
