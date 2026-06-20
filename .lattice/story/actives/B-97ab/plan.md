# Plan — B-97ab: Adversarial-review S1 lens runner (mapping + plan + injected-seam runner)

S1 (PARALLEL, MVP) of the adversarial-review build program (docs/adversarial-review-spec.md §5, §4.2). A pure-data + injected-seam module that drives the S0 canonical lens set as INDEPENDENT reviewers over a change, mapping each lens to one of the six real review_run_start lanes and collecting per-lane raw Finding[]. No verification (S2), no finding_add / ledger mapping (S2), no completeness critic (S3), no escalation (S4). Imports the frozen S0 contract (core/adversarial-review.ts) verbatim and imports core/review-run.ts REVIEW_RUN_LANES read-only.

New files:
- `packages/main/src/core/adversarial-review-lens-runner.ts` (the runner)
- `packages/main/src/tasks/adversarial-review-lens-runner-smoke.ts` (hermetic smoke)
Modified:
- `lattice.config.json` (register the smoke node command)

## CHK-001 — LENS_TO_LANE mapping (§4.2) + the lane type, cross-checked against REVIEW_RUN_LANES
In new `packages/main/src/core/adversarial-review-lens-runner.ts`, importing S0 `LensId`, `CANONICAL_LENS_SET`, `Finding` from `core/adversarial-review.js` and `REVIEW_RUN_LANES`/`ReviewRunLane` from `core/review-run.js` (read-only):
- `export type LensLane = ReviewRunLane;` — the lane type IS the six real review_run_start lanes (single source of truth; no parallel enum).
- `export const LENS_TO_LANE: Record<LensId, LensLane> = { 'concept/scope': 'lattice-review-concept', 'code-quality': 'lattice-review-quality', 'behavior/correctness': 'lattice-review-behavior', 'test-coverage': 'lattice-review-test-coverage', 'crash-safety/edge': 'lattice-review-behavior', 'docs-consistency': 'lattice-review-docs' };` exactly per §4.2.
- Because `LensLane = ReviewRunLane`, the compiler already rejects any non-real lane; the smoke additionally asserts every `LENS_TO_LANE` value ∈ `REVIEW_RUN_LANES` at runtime so drift fails hermetically.
userSees: importing the module exposes `LENS_TO_LANE` whose every value is a real lane; a developer mapping a lens gets a lane that `review_run_start` accepts.

## CHK-002 — buildLensRunPlan(change, lensSet) → one INDEPENDENT request per lens
- `export interface LensRunRequest { lensId: LensId; lane: LensLane; change: string; }` — the ISOLATED input one lens receives. No `findings` field exists on the type (independence is structural).
- `export function buildLensRunPlan(change: string, lensSet: readonly LensDef[] = CANONICAL_LENS_SET): LensRunRequest[]` — returns exactly one request per lens in the (possibly subset) set, each carrying only `{ lensId, lane: LENS_TO_LANE[lens.id], change }`. Never threads any other lens's output. Accepts a subset lens set (task-tunable). No behavior beyond plan construction. Each request gets its own object (no shared mutable reference).
userSees: `buildLensRunPlan(diff)` over the canonical set yields 6 requests, one per lens, each tagged with its mapped lane and the same change; passing a 2-lens subset yields exactly 2 requests.

## CHK-003 — runLenses(change, lensSet, runLens) applies the injected seam + collectRawFindings
- `export interface LensRunResult { lensId: LensId; lane: LensLane; findings: Finding[]; }` (findings=[] means that lens PASSED).
- `export function runLenses(change: string, lensSet: readonly LensDef[], runLens: (req: LensRunRequest) => Finding[]): LensRunResult[]` — builds the plan, applies the injected `runLens` to EACH request independently (runLens is the seam for the real review agent; the main agent/harness supplies it at MVP), and returns one LensRunResult per request preserving `lensId` AND `lane`. `runLens` only ever receives a single lens's request, never another lens's result.
- `export function collectRawFindings(results: LensRunResult[]): Finding[]` — flattens all results' findings into a single Finding[] in order, NO de-dup (a finding from the behavior-mapped `behavior/correctness` lens and one from the behavior-mapped `crash-safety/edge` lens both survive distinctly).
userSees: `const results = runLenses(diff, CANONICAL_LENS_SET, agentFn)` yields 6 results; lenses the agent flagged carry their Finding[], PASS lenses carry []; `collectRawFindings(results)` returns the flat list with both behavior-lane lenses' findings preserved.

## CHK-004 — hermetic smoke (fake runLens) + register in lattice.config.json
`packages/main/src/tasks/adversarial-review-lens-runner-smoke.ts` (check(name,cond)+counter pattern). Asserts:
- every value of `LENS_TO_LANE` is in `REVIEW_RUN_LANES` (import REVIEW_RUN_LANES from `core/review-run.js`; subset check PINS the mapping to reality);
- `buildLensRunPlan(change, CANONICAL_LENS_SET)` yields 6 requests, one per lens, each with the §4.2-correct lane and carrying only `{lensId,lane,change}` (assert no `findings`/extra keys — independence);
- a SUBSET lens set (e.g. `[code-quality, docs-consistency]`) yields exactly those 2 requests with the right lanes;
- `runLenses` with a FAKE runLens that plants one MAJOR Finding on `code-quality` and `[]` for the rest yields 6 LensRunResult with the planted finding on code-quality only and PASS lenses empty;
- the two behavior-mapped lenses (`behavior/correctness` + `crash-safety/edge`) each keep their own finding distinctly (no merge/mis-attribution);
- the fake runLens, when it records its input, only ever sees a single lens's request (no cross-lens data);
- `collectRawFindings` flattens to the expected count.
Print `adversarial-review-lens-runner smoke passed: N assertions`. Register `node packages/main/dist/tasks/adversarial-review-lens-runner-smoke.js` in `lattice.config.json` validate.commands.
userSees: running `node packages/main/dist/tasks/adversarial-review-lens-runner-smoke.js` prints the pass line with the assertion count and exits 0; `lattice validate` is all green.

## Verification
tsc compiles; the hermetic smoke passes (all assertions); `lattice validate` all green. Independence and mapping-correctness are proven by the smoke (subset-of-REVIEW_RUN_LANES check + no-cross-lens-data check + distinct behavior-lane findings). No S2/S3/S4 concerns introduced.
