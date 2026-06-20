# Plan — B-1127: Adversarial-review S4 escalation-flow integration (capstone)

S4 (SERIAL, last) of the adversarial-review build program (docs/adversarial-review-spec.md §3 + §4.1 + §5 S4). A pure-data + injected-seam orchestration module composing the three DONE modules (S1 lens runner, S2 verifier+ledger, S3 critic) into the frozen 5-phase canonical round, the loop-until-dry reopen loop, the ledger-op derivation, and the 3x2 host-verdict payload shaper. The actual CLI calls (review_run_start/finding_add/review_pass_set/autopilot_review_submit) + Authority receipt are OUT of scope (local-only §4.5; the harness/main-agent does them). Imports S0/S1/S2/S3/review-run read-only; modifies none.

New files:
- `packages/main/src/core/adversarial-review-round.ts`
- `packages/main/src/tasks/adversarial-review-round-smoke.ts`
Modified:
- `lattice.config.json`

## CHK-001 — runAdversarialRound: the frozen 5-phase canonical round + AdversarialRoundResult
In new `packages/main/src/core/adversarial-review-round.ts`:
- `export interface RoundSeams { runLens: (req: LensRunRequest) => Finding[]; runSkeptic: (finding: Finding, change: string) => Verdict; runCritic: (input: CompletenessCriticInput) => Finding[]; }`
- `export interface RoundConfig { lensSet?: readonly LensDef[]; skeptics?: number; threshold?: number; }`
- `export interface ConfirmedLaneGroup { lane: LensLane; lensId: LensId; findings: Finding[]; }`
- `export interface AdversarialRoundResult extends RoundResult { confirmedByLane: ConfirmedLaneGroup[]; }`
- `export function runAdversarialRound(change, seams, config?): AdversarialRoundResult` runs the §3.2 FROZEN order: (1) lenses: `runLenses(change, lensSet, seams.runLens)` [S1]; (2) verify-lens-findings: for EACH LensRunResult verify its findings (`verifyFindings(lr.findings, change, seams.runSkeptic, {skeptics,threshold})` + `confirmedFindings`) keeping lane -> confirmedByLane; flatten -> confirmedLens; (3) critic: `runCompletenessCritic({change, confirmedFindings: confirmedLens}, seams.runCritic)` [S3] -> criticRaw; (4) verify-critic-findings: `confirmedFindings(verifyFindings(criticRaw, change, seams.runSkeptic, ...))` -> confirmedCritic; (5) converge-or-reopen: `converged = confirmedLens.length===0 && confirmedCritic.length===0`, `reopen = !converged`. Returns `{lensFindings: collectRawFindings(lensResults), confirmedFindings: confirmedLens, criticFindings: confirmedCritic, reopen, converged, confirmedByLane}`. The critic receives the VERIFIED lens set, never raw.
userSees: runAdversarialRound on a change where lenses+critic find nothing -> converged=true; where the critic confirms a finding -> reopen=true, criticFindings non-empty; the critic's input.confirmedFindings is the verified set.

## CHK-002 — deriveRoundLedgerOps: finding_add + review_pass_set op derivation
- `export type LedgerOp = { kind: 'finding_add'; lane: ReviewRunLane; source: 'lens' | 'critic'; args: FindingAddArgs } | { kind: 'review_pass_set'; lane: ReviewRunLane; reviewRunId: string };`
- `export function deriveRoundLedgerOps(round: AdversarialRoundResult, opts: { reviewRunIdByLane: Partial<Record<ReviewRunLane, string>>; criticLane: ReviewRunLane; criticReviewRunId: string; category?: FindingAddArgs['category'] }): LedgerOp[]`:
  - for each `round.confirmedByLane` group, for each finding -> `{kind:'finding_add', lane, source:'lens', args: toFindingAddArgs(f, {reviewRunId: reviewRunIdByLane[lane] ?? '', agent: lane, category: category ?? 'adversarial'})}` (agent = the real lane, S2 mapping);
  - for each `round.criticFindings` -> `{kind:'finding_add', lane: criticLane, source:'critic', args: toCriticFindingAddArgs(f, {reviewRunId: criticReviewRunId, agent: criticLane, category: category ?? 'missing'})}` (tagged desc + real lane, S3);
  - if `round.converged`, for each lane in confirmedByLane -> `{kind:'review_pass_set', lane, reviewRunId: reviewRunIdByLane[lane] ?? ''}`.
  PURE — derives op descriptors, performs NO finding_add call. No abstract severity in any op (S2/S3 own the mapping).
userSees: deriveRoundLedgerOps yields one finding_add per confirmed finding with a critical|high|medium|low severity (never abstract), critic ops desc-tagged under a real lane, and review_pass_set ops only when the round converged.

## CHK-003 — runReopenLoop (loop-until-dry) + buildHostVerdictPayloads (3x2 shaper)
- `export interface ReopenLoopResult { rounds: AdversarialRoundResult[]; converged: boolean; finalChange: string; }`
- `export function runReopenLoop(initialChange, seams, applyFix: (change: string, confirmed: Finding[], roundIndex: number) => string, config?: RoundConfig & { maxRounds?: number }): ReopenLoopResult` — `maxRounds = config?.maxRounds ?? 10`; loop: run `runAdversarialRound`, push to rounds; if `converged` return `{rounds, converged:true, finalChange:change}`; else `change = applyFix(change, [...confirmedFindings, ...criticFindings], i)` and continue; after maxRounds return `{rounds, converged:false, finalChange:change}`. Models reopen -> new reviewRunId + re-bind to fresh materialHash (new change = new material).
- `export interface HostVerdictPayload { storyId: string; runId: string; hostId: string; provider: string; sessionId: string; keyId: string; decision: 'pass'|'fail'|'blocked'; materialDigest: string; validationDigest: string; promptDigest: string; }`
- `export function buildHostVerdictPayloads(opts: { storyId: string; runId: string; materialDigest: string; validationDigest: string; hosts: Array<{ hostId: string; provider: string; sessionId: string; keyId: string; promptDigest: string; decision?: 'pass'|'fail'|'blocked' }> }): HostVerdictPayload[]` — one payload per host, each bound to the SAME materialDigest+validationDigest, decision default 'pass' (§4.1 full-3x2; two INDEPENDENT hosts). Pure — no CLI call, no Authority receipt.
userSees: runReopenLoop on a B-086b trace returns rounds.length===2 converged===true; a never-fixed change returns converged===false at the maxRounds bound; buildHostVerdictPayloads returns one payload per host with distinct hostId/keyId/sessionId, shared digests.

## CHK-004 — hermetic smoke (fake seams) + register in lattice.config.json
`packages/main/src/tasks/adversarial-review-round-smoke.ts` (check+counter, explicit literals). Asserts: REVIEW_MODE_PHASES === ['lenses','verify-lens-findings','critic','verify-critic-findings','converge-or-reopen']; a fake runCritic captures its input and the smoke asserts it received the CONFIRMED (verified) lens set, not raw; a CLEAN round (skeptics refute all) -> converged===true, reopen===false, criticFindings===[]; a round where the critic confirms -> reopen===true, converged===false; runReopenLoop (critic confirms on round 1, applyFix makes round 2 clean) -> rounds.length===2, rounds[0].converged===false, rounds[1].converged===true, result.converged===true; maxRounds bound (never clean) -> converged===false; deriveRoundLedgerOps -> finding_add ops (lens agent===real lane, severity a ledger kind not abstract; critic desc starts '[completeness-critic] ', agent a real lane) + review_pass_set ops ONLY on converge; buildHostVerdictPayloads -> 2 payloads, distinct hostId/keyId/sessionId, same materialDigest+validationDigest, decision 'pass'. Print `adversarial-review-round smoke passed: N assertions`. Register `node packages/main/dist/tasks/adversarial-review-round-smoke.js` in lattice.config.json validate.commands.
userSees: running the smoke prints the pass line + count, exit 0; lattice validate green.

## Verification
tsc compiles; the smoke passes; `lattice validate` all green. The frozen 5-phase order (critic on verified set), the converged/reopen + loop-until-dry + maxRounds bound, the no-abstract-leak ledger derivation (lens under real lane, critic tagged), and the 3x2 payload shape are all proven by the smoke with fake seams. No re-implementation of S1/S2/S3; no CLI/Authority I/O.
