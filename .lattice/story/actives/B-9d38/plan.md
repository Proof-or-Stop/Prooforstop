# Plan — B-9d38: Adversarial-review S3 completeness-critic role + MVP provenance

S3 (MVP) of the adversarial-review build program (docs/adversarial-review-spec.md §2.4 + §4.3). A pure-data + injected-seam module: the completeness-critic role (an injected runCritic seam over {change, confirmedFindings} returning raw, unprivileged Finding[]) + the §4.3 MVP provenance ([completeness-critic] desc tag + a REAL review-lane agent). Composes S0 + S2; NO lens runner (S1), NO verifier/threshold (S2), NO reopen/escalation/finding_add I/O (S4).

New files:
- `packages/main/src/core/adversarial-review-critic.ts` (the critic role + provenance)
- `packages/main/src/tasks/adversarial-review-critic-smoke.ts` (hermetic smoke)
Modified:
- `lattice.config.json` (register the smoke)

## CHK-001 — runCompletenessCritic(input, runCritic) injected-seam, raw unprivileged output
In new `packages/main/src/core/adversarial-review-critic.ts`, importing S0 `CompletenessCriticInput`, `Finding` from `core/adversarial-review.js`:
- `export function runCompletenessCritic(input: CompletenessCriticInput, runCritic: (input: CompletenessCriticInput) => Finding[]): Finding[]` returns `runCritic(input)` — the critic sees ONLY {change, confirmedFindings} (the VERIFIED set per §2.4) and its output is returned UNCHANGED (raw + unprivileged; it re-enters S2 verification, which is S4). Pure pass-through, no I/O.
- Optional convenience `runCompletenessCriticOn(change: string, confirmedFindings: Finding[], runCritic): Finding[]` = `runCompletenessCritic({change, confirmedFindings}, runCritic)`.
userSees: runCompletenessCritic({change, confirmedFindings}, agentFn) returns exactly the agent's Finding[]; the agent received exactly {change, confirmedFindings}.

## CHK-002 — provenance constants (§4.3)
- `export const COMPLETENESS_CRITIC_DESC_TAG = '[completeness-critic]';` — the provenance prefix carried in --desc (NOT --agent).
- `export const CRITIC_PROVENANCE_RECOMMENDED_LANES = ['lattice-review-quality', 'lattice-review-behavior'] as const;` — the §4.3 recommended REAL lanes for critic findings (reviewer-evidence only counts when agent.startsWith('lattice-review-'); no lattice-review-completeness lane exists, so a confirmed critic finding must use a real lane in --agent).
- Doc comment: WHY the tag goes in --desc not --agent (putting completeness-critic in --agent stores the finding as non-reviewer provenance — it would not count as lane evidence and the reviewRunId<->lane binding would not validate).
userSees: COMPLETENESS_CRITIC_DESC_TAG === '[completeness-critic]'; CRITIC_PROVENANCE_RECOMMENDED_LANES are real lattice-review-* lanes.

## CHK-003 — toCriticFindingAddArgs wraps S2 toFindingAddArgs + tags the desc; agent typed as a real ReviewRunLane
Imports S2 `toFindingAddArgs`, `FindingAddArgs` from `core/adversarial-review-verifier.js` and `ReviewRunLane` from `core/review-run.js` (read-only).
- `export function toCriticFindingAddArgs(finding: Finding, opts: { reviewRunId: string; agent: ReviewRunLane; category: FindingAddArgs['category'] }): FindingAddArgs` computes `const base = toFindingAddArgs(finding, opts);` then returns `{ ...base, desc: COMPLETENESS_CRITIC_DESC_TAG + ' ' + base.desc }`.
- `agent` is typed `ReviewRunLane` so the compiler STRUCTURALLY rejects `'completeness-critic'` (a real lane only — §4.3). The severity remains the S2-mapped critical|high|medium|low (no abstract leak — S2 owns the mapping). Pure — no finding_add call (S4).
userSees: toCriticFindingAddArgs(majorFinding, {reviewRunId, agent:'lattice-review-quality', category}) yields {severity:'high', desc:'[completeness-critic] <title> — <issue> Fix: <fix> (line n)', files:[...], category, reviewRunId, agent:'lattice-review-quality'} — desc tagged, agent a real lane, severity mapped.

## CHK-004 — hermetic smoke (fake runCritic) + register in lattice.config.json
`packages/main/src/tasks/adversarial-review-critic-smoke.ts` (check(name,cond)+counter, explicit literals). Asserts:
- COMPLETENESS_CRITIC_DESC_TAG === '[completeness-critic]'; CRITIC_PROVENANCE_RECOMMENDED_LANES === ['lattice-review-quality','lattice-review-behavior'] and each ∈ REVIEW_RUN_LANES (real lanes).
- runCompletenessCritic with a fake runCritic that records its input and returns a planted Finding[] -> returns exactly those findings unchanged; the fake received exactly {change, confirmedFindings} (Object.keys === ['change','confirmedFindings'] — the confirmed set, not raw); an empty confirmedFindings still calls the critic.
- toCriticFindingAddArgs(finding, {reviewRunId:'RR-1', agent:'lattice-review-quality', category:'missing'}) -> desc STARTS WITH '[completeness-critic] ' followed by exactly the S2 composeDesc/toFindingAddArgs desc; severity is the mapped critical|high|medium|low (assert NOT an abstract BLOCKER/MAJOR/MINOR) for BLOCKER/MAJOR/MINOR inputs; agent === 'lattice-review-quality' (a real lane, NEVER 'completeness-critic'); files/category/reviewRunId pass through; also works for 'lattice-review-behavior'. Assert the result minus the desc-prefix equals toFindingAddArgs (same mapping).
Print `adversarial-review-critic smoke passed: N assertions`. Register `node packages/main/dist/tasks/adversarial-review-critic-smoke.js` in lattice.config.json validate.commands.
userSees: running the smoke prints the pass line + assertion count, exit 0; lattice validate green.

## Verification
tsc compiles; the smoke passes; `lattice validate` all green. The provenance-in-desc-not-agent property (real-lane agent + tagged desc), the unchanged-unprivileged seam pass-through ({change,confirmedFindings} only), and the S2-mapped-severity no-abstract-leak are all proven by the smoke. No S1/S2/S4 concerns introduced; no finding_add call.
