# Experience Layer A/B Ablation Causal Validation Execution Plan

Status: draft execution plan (rev 2, 2026-07-02)

Revision provenance: rev 2 incorporates the 12 verified findings of the
2026-07-02 two-round adversarial review (4 repo mappers + 4 review lenses + 12
independent adjudicators). It supersedes the deleted rev-1 draft of the same
date. The honesty scaffolding of rev 1 (claim boundary, pre-registration
discipline, immutable pre-outcome ledger, mechanical control-arm isolation,
stopping rules, no-overclaim rule) is retained; the design parameters, study
geometry, isolation mechanics, and build path are corrected.

## 1. Problem

The experience layer has strong mechanical evidence that relevant lessons can
be stored, indexed, bounded, and consumed at runtime entrypoints. That proves
availability and consumption. It does not yet prove causal impact.

The open major gap is:

> Experience layer lacks causal validation: implement a formal A/B test with
> sufficient sample size to measure causal impact on defect rates.

The production hint-mode assignment cannot close this gap by itself: the live
per-story sha256-parity switch (`packages/main/src/core/hint-mode.ts`,
consumed by `experience-hint-surface.ts`) gates only the advisory
experience-hints section, assigns per story rather than per task, is blind to
trap classes, computes no inferential statistics (the `learning_effectiveness`
readout is observational-only), and has accrued a negligible event count. The
question is not whether memory exists or whether an arm switch exists. The
question is whether automatically surfacing experience changes host behavior
in a measurable, causally attributable way.

## 2. Claim Boundary

This study may support the following claim:

> Automatic experience-layer consumption reduces the primary defect rate, and
> specifically the recurrence of known failure modes, on seeded fault-bearing
> tasks under the tested task distribution.

This study must not claim:

- the base model became smarter;
- memory is proof or gate evidence;
- every story will be defect-free;
- all task types improve equally;
- live production behavior is proven from a synthetic-only experiment;
- generalization to failure modes whose lessons are not in the store.

Known circularity limitation (disclosed by design): the in-store seeded traps
are authored from the same lesson store the treatment surfaces. A positive
result on in-store traps therefore demonstrates that surfacing an existing
lesson reduces recurrence of the failure mode that lesson describes — not
general defect reduction, and not generalization to novel failures. The
held-out negative-control traps (section 5.1) exist to separate the
lesson-surfacing mechanism from generic prompt-priming.

Memory remains `authority=non_authoritative` and `gateEvidence=false`.

## 3. Primary Hypothesis

### H1

For seeded fault-bearing tasks that contain known prior failure traps, host
runs with the experience layer enabled will produce fewer defects than host
runs with the experience layer disabled, measured as co-primary outcomes on
the fault-bearing stratum:

- H1a: lower primary defect rate (deterministic composite, section 6.1);
- H1b: lower repeat-defect recurrence rate (`repeatDefectPresent`,
  section 6.2), the mechanism-matched outcome.

On fault-bearing seeded tasks the two nearly coincide by construction (the
trap classes are the authored failure modes); both are reported with
predeclared N and 95% CI so the claimed metric is always the tested metric.

### H0

There is no difference in defect rate between treatment and control.

### Secondary Hypotheses

| ID | Hypothesis | Measurement |
|---|---|---|
| H2 | Treatment lifts in-store traps but not held-out negative-control traps (mechanism specificity). | Per-group treatment effect contrast. |
| H3 | Treatment reduces false-DONE or overclaim attempts. | DONE-block / final-response-check violation rate. |
| H4 | Treatment reduces review rework. | REVIEW findings per story and DEV-REVIEW loop count (live phase only). |
| H5 | Treatment increases overhead on clean tasks. | Time-to-DONE, command count, and token/host cost. |

## 4. Experiment Arms

| Arm | Experience layer behavior | Purpose |
|---|---|---|
| Control A | Runtime memory pack computed and logged but NOT rendered to the host. Gates and evidence stay unchanged. | Measures baseline host behavior without automatic experience, while capturing the would-have-surfaced pack for consumption-fidelity checks. |
| Treatment B | Runtime memory pack rendered at the same lifecycle entrypoints. Gates and evidence stay unchanged. | Measures effect of automatic experience consumption. |

There is no separately allocated shadow arm. The production mechanism already
computes the pack and emits `experience_hint_surfaced` on BOTH arms, gating
only the render (`experience-hint-surface.ts`; verified end-to-end by
`experience-layer-ab-shadow-gate-smoke.ts`) — i.e. the control arm IS the
instrumented shadow. Allocating tasks to a third arm would burn run budget
without adding information.

The treatment must not receive extra gate power. The only difference between A
and B is whether the host sees relevant experience guidance before acting.

## 5. Task Populations

Use two populations because they answer different questions.

### 5.1 Controlled Seeded Tasks

Synthetic or semi-synthetic tasks with known traps, replayable fixtures, and
deterministic scoring, following the corpus pattern proven in
`experiments/recovery-runner/tasks/` (per-fixture `prompt.md`, `task.json`,
visible acceptance script, hidden ground-truth oracle, continuously validated
by a corpus self-check).

Fault-bearing traps are split into two predeclared groups:

**Group 1 — in-store traps.** Failure modes whose lessons exist in the runtime
memory store (`.lattice/learning/runtime-memory-pack-cache`) and are surfaced
by Treatment B:

| Trap class | Example failure | Expected treatment behavior |
|---|---|---|
| Stale-doc trap | Host treats old plan prose as current truth. | Checks current story facts before claiming undone work. |
| Parent-roadmap totality trap | Host claims parent roadmap complete while child rows remain open. | Checks parent rollup before final claim. |
| Host-policy trap | Host uses deprecated host labels or wrong fallback order. | Uses Codex CLI + Claude Code CLI, agy only as fallback. |
| Deprecated-brand residue | Host revives retired naming from old memory/docs. | Treats old brand terms as residue, not current guidance. |
| False-DONE trap | Host treats advisory memory as gate evidence. | Keeps memory non-authoritative and relies on structured evidence. |
| Review-lane trap | Host counts main/implementer evidence as reviewer proof. | Requires explicit reviewer-lane evidence. |

**Group 2 — held-out negative-control traps.** Fault-bearing tasks built from
failure modes whose lessons are deliberately NOT present in the runtime memory
store. Treatment lifting Group 1 but not Group 2 isolates the lesson-surfacing
mechanism; treatment lifting both suggests a broader priming effect the study
cannot attribute to specific captured lessons. Group 2 membership is frozen at
protocol hash together with a snapshot of the memory store.

Controlled tasks additionally include clean tasks:

- Clean tasks estimate overhead and false-block risk (H5). They are analyzed
  separately and are NOT pooled into the powering baseline (section 7).
- Fault-bearing tasks estimate insurance value and recurrence reduction.

### 5.2 Live Shadow Tasks

Real Proofbound stories observed under the EXISTING production per-story
ON/OFF assignment (`resolveHintMode`) and its read-only observational readout
(`learning_effectiveness`), extended — not duplicated — by this study. No
second live assignment system is built; the live phase reuses the production
assignment/logging substrate as an exploratory feed.

Live tasks measure ecological validity:

- actual reviewer findings;
- DEV/REVIEW/TEST loops;
- DONE blocks;
- time-to-DONE;
- user correction events.

Per section 15, live data stays exploratory and must not be conflated with the
controlled causal claim: the live readout is hints-only, story-unit,
trap-blind, and non-inferential, so it does not by itself answer H1. The live
phase must not block normal delivery.

## 6. Metrics

### 6.1 Primary Outcome (deterministic, reviewer-free)

| Metric | Definition |
|---|---|
| Primary defect rate | Fraction of fault-bearing seeded tasks with at least one of: (a) failed validation, (b) false-DONE attempt detected from structured DONE readiness rows + `final_response_check` records, (c) task-oracle mismatch (hidden per-fixture ground-truth oracle), or (d) for the review-lane trap, a structured lane-provenance violation (main/implementer evidence counted as reviewer proof). |

Every disjunct is a deterministic structured/oracle fact. Live LLM reviewer
findings are deliberately EXCLUDED from the seeded-study primary endpoint:
they would inject reviewer nondeterminism into the scored outcome, break the
M4 exit criterion ("known positive/negative fixtures score correctly"), and
add a per-task reviewer cost. Verified reviewer findings remain a
secondary/exploratory signal for the live phase only.

### 6.2 Secondary Outcomes

| Metric | Definition |
|---|---|
| Repeat-defect recurrence rate (co-primary on fault stratum) | Fraction of tasks that reproduce a failure mode with an active lesson/playbook (`repeatDefectPresent`). |
| In-store vs held-out effect contrast | Treatment effect on Group 1 minus Group 2 (mechanism specificity, H2). |
| False-DONE rate | Fraction of tasks that attempt completion while structured evidence is missing or stale. |
| High-severity oracle failure rate | Fraction of tasks whose oracle mismatch is classified high severity by the fixture's ground-truth labels. |
| Rework loops | Number of DEV-REVIEW or TEST-DEV returns (live phase). |
| Verified reviewer finding count | Live phase only; non-deterministic; exploratory. |
| Time-to-DONE | Wall-clock duration from task intake to DONE or terminal stop. |
| Command count | Number of `lattice` CLI commands and verification commands. |
| Cost | Host token/cost estimate when available. |
| Memory-consumption fidelity | Whether the expected memory/playbook appeared in the runtime pack (from the control/treatment pack logs). |
| Overhead on clean tasks | Delta in time/cost/commands when no trap is present (equivalence-style reporting, not superiority). |

## 7. Sample Size Policy

The implementation must include a sample-size calculator before running the
study (M5), reusing the statistical primitives already present in
`experiments/recovery-runner/analyze.mjs` (two-proportion machinery, Wilson
CI, bootstrap, Benjamini-Hochberg). The calculator must support:

- two-proportion z-test approximation (unpaired reference sizing);
- McNemar discordant-pair sizing for the paired design (section 8);
- configurable alpha, power, baseline defect rate, and minimum detectable effect.

Per-population planning parameters are predeclared SEPARATELY — a single
population-agnostic default is not allowed, because the two populations have
an order-of-magnitude different baseline:

| Parameter | Controlled seeded (fault stratum) | Live |
|---|---:|---:|
| Alpha | 0.05 | 0.05 |
| Power | 0.80 | 0.80 |
| Baseline defect rate | pilot-estimated; planning band 0.5-0.8 (traps are authored to trip the host) | 0.30 |
| Minimum detectable absolute reduction | 0.25-0.35 | 0.10 |
| Reference N per arm (unpaired two-proportion) | ~27-62 over the corners of the planning band | ~294 |
| Design | full-factorial matched pairs (both arms per fixture) | randomized per story |

The powered N and the primary test apply to the FAULT-BEARING seeded stratum
only. Clean tasks are sized and analyzed separately for overhead (H5) and are
never pooled into the powering baseline.

The seeded-population baseline defect rate must be validated in the M6 pilot
(including enough control-arm fault tasks to estimate it) before the powered N
is frozen; if the pilot baseline falls outside the planning band, recompute
and re-freeze N before M7.

Minimum rules:

- Thirty fault-bearing fixtures per group is only a minimum reporting floor,
  not a powered-claim threshold. A powered causal claim requires the N
  returned by the sample-size calculator under the predeclared per-population
  parameters.
- Do not claim causal reduction from fewer than 30 fault-bearing fixtures
  under any circumstance, even if an exploratory result looks favorable.
- Do not claim trap-class-specific causal impact unless that trap class has a
  predeclared N and confidence interval; otherwise per-trap breakdowns are
  reported as estimation with CI, not hypothesis tests.

## 8. Study Geometry: Matched Pairs, Not Blocked Randomization

The controlled seeded phase uses a FULL-FACTORIAL MATCHED-PAIRS design: every
seeded fixture is run under BOTH arms (control and treatment), and outcomes
are compared within-fixture (McNemar for the binary primary; paired/cluster
bootstrap for rates and continuous outcomes). This is the design the repo's
powered-run harness already implements (`experiments/recovery-runner`
enumerates every arm x every task) and it is strictly better here than
blocked single-arm randomization:

- At realistic N (27-62 fixtures), blocking by five factors (trap class,
  difficulty, source, host family, clean/fault) yields under one task per
  cell — incoherent as a blocked design. Pairing removes between-fixture
  variance instead, giving more power at the same task count.
- Pairing eliminates the assignment step for the controlled phase entirely,
  so "randomize before the host sees the prompt" is satisfied by construction
  — there is nothing to reassign after outcomes.
- Arm-run independence is mechanical: each arm run of a fixture executes in
  its own isolated workspace and store root (section 12), so no state leaks
  between the paired runs.

What is still committed to the experiment ledger before execution:

- the fixture manifest (including Group 1 / Group 2 / clean membership);
- a seeded run ORDER (string-seeded PRNG + Fisher-Yates, the
  `run-driver.mjs` pattern) so execution order cannot be tuned to outcomes;
- the protocol hash and the frozen memory-store snapshot hash.

Ledger entries are immutable once the first score record exists.

Randomized assignment (per story, `resolveHintMode`) applies only to the live
phase, where each real story can run once.

## 9. Blinding And Leakage Controls

| Risk | Control |
|---|---|
| Host infers it is in treatment. | Arm runs differ only by presence of the bounded experience pack; prompts and fixtures are byte-identical otherwise. |
| Scorers know arm assignment. | The deterministic scorer (section 10) consumes structured artifacts that do not encode the arm; arm labels live only in the ledger and score records. |
| Control host manually searches memory. | Control-arm isolation must be mechanical, not instruction-only: the control run executes against an isolated store root with memory/playbook retrieval disabled; any retrieval attempt is recorded and counted as a protocol violation. |
| Treatment receives extra proof. | Pack must render `authority=non_authoritative` and `gateEvidence=false`. |
| In-tree answer sources leak the lesson to either arm. | Per trap class, enumerate and strip or neutralize the specific in-tree answer sources from the fixture workspace — runbook prose (CLAUDE.md / AGENTS.md convergence sections), decision docs, and executable oracles (e.g. `scripts/verify-lattice-residue.mjs` literally computes the brand-residue answer) — while keeping both arms' fixture trees byte-identical. A fixture-leakage audit (mechanically verifying that neither arm can reconstruct the trap answer from the fixture tree without the pack) is an M6 pilot exit criterion. |

Note the last row replaces rev 1's "keep task fixtures balanced" hedge, which
mandated the leakage instead of removing it: blocking retrieval commands does
not isolate the control arm when each trap's answer is independently
derivable from the working tree both arms carry.

## 10. Scoring

Each arm-run produces a structured score record:

```ts
interface ExperienceAblationScore {
  schemaVersion: 'proofbound.experience-ablation-score.v1';
  experimentId: string;
  taskId: string;
  pairId: string;              // fixture id shared by the paired arm-runs
  arm: 'control' | 'treatment';
  hostId: string;
  trapClass: string;
  trapGroup: 'in_store' | 'held_out' | 'clean';
  cleanTask: boolean;
  memoryPackShown: boolean;
  expectedMemoryIds: string[];
  surfacedMemoryIds: string[]; // logged on BOTH arms (control = would-have-surfaced)
  storeRoot: string;           // isolated per-run store root (section 12 assertion)
  defectPresent: boolean;      // deterministic composite, section 6.1
  repeatDefectPresent: boolean;
  falseDoneAttempt: boolean;
  oracleMismatch: boolean;
  laneProvenanceViolation: boolean;
  validationPass: boolean;
  doneReached: boolean;
  timeToDoneMs: number | null;
  commandCount: number;
  retrievalViolationCount: number; // control-arm blocked-retrieval attempts
  evidenceRefs: string[];
}
```

Scorers must classify outcomes from structured artifacts, not prose alone.

Preferred sources (all deterministic for the seeded phase):

1. validation evidence;
2. DONE readiness rows;
3. `final_response_check` advisory records;
4. the fixture's hidden ground-truth oracle (the
   `experiments/recovery-runner/tasks/*/ground-truth.mjs` pattern);
5. structured lane-provenance facts (for the review-lane trap).

Scoring reuses the deterministic scorer patterns already proven in
`experiments/recovery-runner/adjudicate.mjs` (pure offline outcome state
machine), `checks.mjs` (hash-checked acceptance), and the `packages/lab`
scoring core. Live-phase reviewer findings (`evidenceState=verified`) are
consumed only by the exploratory live report.

## 11. Statistical Analysis

### 11.1 Primary Test

Paired comparison of the deterministic primary defect outcome within fixtures:

- McNemar test on discordant pairs (control-defect/treatment-clean vs
  control-clean/treatment-defect) for H1a, and identically for H1b
  (`repeatDefectPresent`) as co-primary on the fault-bearing stratum;
- risk difference (treatment minus control) with a 95% CI from a
  paired/cluster bootstrap.

Decision criterion: `risk_difference` is the SOLE primary decision criterion.
H1 is supported only when the risk difference is negative under the
predeclared criterion, with confidence intervals reported in the same
direction.

Relative risk is reported for descriptive purposes only. When a cell's
denominator defect count is zero — expected in per-trap-class and clean-task
cells — apply a predeclared Haldane-Anscombe continuity correction (add 0.5
to each cell) before computing RR, or report RR as n/a for that cell. Never
infer a causal claim from an RR computed on a zero or continuity-corrected
denominator.

Report:

- absolute risk difference (paired) with 95% CI and p-value;
- descriptive relative risk (guarded as above);
- in-store (Group 1) vs held-out (Group 2) effect contrast;
- per-trap-class breakdown as estimation with CI (not hypothesis tests,
  unless that trap class has a predeclared N);
- clean-task overhead table.

### 11.2 Secondary Tests

| Outcome | Suggested analysis |
|---|---|
| In-store vs held-out contrast (H2) | Difference of paired risk differences with bootstrap CI. |
| False-DONE rate (H3) | McNemar / exact binomial on discordant pairs. |
| Rework loops (H4, live) | Mann-Whitney or bootstrap CI. |
| Time-to-DONE | Bootstrap CI; report censoring for blocked tasks. |
| Clean-task overhead (H5) | Difference in means/medians with CI; equivalence-style reporting; do not require superiority. |

Multiplicity: the H2-H5 secondary tests form one family; control the false
discovery rate across them with Benjamini-Hochberg at FDR=0.05 (the
`benjaminiHochberg` implementation already exists in
`experiments/recovery-runner/analyze.mjs`). Secondary tests remain secondary
and never override the H1 primary.

### 11.3 Stopping Rules

Stop early only for safety or infrastructure failure, not because interim
results look good.

Allowed early stops:

- scorer bug discovered;
- fixture-leakage or store-isolation breach discovered;
- control arm accidentally received the rendered treatment pack;
- treatment pack marked as gate evidence;
- task fixtures are not comparable;
- the frozen memory-store snapshot was mutated mid-run.

## 12. Evidence Artifacts, Store Isolation, And Memory Freeze

Artifacts live under an experiment-specific evidence root inside the actual
runtime metadata root `.lattice/` (rev 1's `.proof-or-stop/` path does not
exist in the implementation; "Proof-or-Stop" names the lifecycle-readiness
concept in this repo, not a directory or command set):

```text
.lattice/experiments/experience-ablation/<experimentId>/
  protocol.json
  fixture-manifest.jsonl
  pair-ledger.jsonl
  run-order-seed.json
  memory-snapshot-hash.json
  score-records.jsonl
  leakage-audit.jsonl
  analysis-report.json
  analysis-report.md
```

Store isolation (mandatory, mechanical):

- Every experiment arm-run executes against an ISOLATED store root — a fresh
  non-git temp root per run (`mkdtemp`, the recovery-runner
  `live-engine.mjs`/`run-recovery.mjs` precedent) or an explicit synthetic
  store root. Git worktrees are NOT sufficient isolation:
  `packages/main/src/core/learning-store.ts` `resolveLearningRoot()`
  canonicalizes linked worktrees back to the single shared main-repo
  `.lattice/learning/` store, so lifecycle writes from experiment tasks would
  contaminate production analytics (finding-signals, playbook-outcomes,
  signature-registry) and production activity would leak into the experiment.
- Every score record asserts its resolved `storeRoot` is the experiment root;
  a run whose resolved learning dir is the production store is voided.

Memory freeze (mandatory): the runtime memory-pack content used by the
treatment arm is FROZEN as a snapshot at protocol-freeze time (hash recorded
in `memory-snapshot-hash.json`) for the entire powered run, and experiment
tasks must not write lessons back to any shared store. Without the freeze the
treatment is non-stationary (early vs late tasks see different packs) and
later outcomes depend on earlier tasks' newly-written lessons, breaking
independent-unit inference.

These artifacts are empirical evidence for the paper/system claim. They do
not satisfy story DONE or review gates.

## 13. Implementation Milestones

Each milestone names the existing component it reuses; only genuinely missing
pieces are built new.

| Milestone | Goal | Reuses | Exit criteria |
|---|---|---|---|
| M0 Protocol freeze | Machine-validated `protocol.json` with task classes, per-population sample-size config, trap-group membership, memory-snapshot hash, and no-overclaim boundary. | Per-run sha256 hash mechanics (`checks.mjs`, `live-engine.mjs`); pre-registration discipline of `lattice-experiment-protocol.md`. | `protocol.json` validates; no task runs without protocol hash; memory snapshot hash frozen. |
| M1 Task fixture generator | Seeded fixtures for the six in-store trap classes + held-out negative-control traps + clean tasks, each with a hidden deterministic oracle and stripped in-tree answer sources. | Corpus pattern of `experiments/recovery-runner/tasks/` (prompt/task.json/acceptance/ground-truth/corpus-selfcheck); production detectors as oracle components (`final_response_check` ParentRollupResult, `verify-lattice-residue.mjs` relocated INTO the oracle, never the fixture tree). | Generator emits deterministic fixtures with oracle labels; per-trap answer-source strip list documented. |
| M2 Pair ledger | Immutable fixture manifest + pair ledger + committed run-order seed. | Seeded PRNG + Fisher-Yates (`run-driver.mjs` xmur3/mulberry32); append-only sidecar pattern (exclusions/voids jsonl). | Same seed reproduces the run order; ledger immutable once the first score exists. |
| M3 Arm switch for the full pack | Extend the EXISTING render-gate (`experience-hint-surface.ts` + `hint-mode.ts`) from review-entrypoint hints to the full runtime memory pack at all lifecycle entrypoints, under an `experimentId` override; add mechanical control-arm retrieval blocking. | Production arm switch + both-arms `experience_hint_surfaced` logging + `experience-layer-ab-shadow-gate-smoke.ts`. | Control hides+logs pack; treatment shows+logs pack; retrieval attempts on control are blocked and recorded. |
| M4 Deterministic scoring oracle | Structured scoring from validation evidence, DONE rows, `final_response_check`, ground-truth oracles, and lane-provenance facts. No live reviewer in the seeded-phase primary. | `adjudicate.mjs` outcome state machine; `checks.mjs`; `packages/lab` scoring core; `ground-truth.mjs` pattern. | Known positive/negative fixtures score correctly, deterministically, on replay. |
| M5 Sample-size calculator | Per-population adequacy report (unpaired reference + McNemar paired sizing). | Statistical primitives in `analyze.mjs` (two-proportion, Wilson CI, bootstrap, BH-FDR). | Report shows planned N per population, assumptions, and detectable effect; seeded N re-frozen after the M6 baseline estimate. |
| M6 Controlled seeded pilot | Plumbing, isolation, and leakage validation + baseline-rate estimation. | Committed engine (`run-driver.mjs` / `live-engine.mjs`). The identity-keyed campaign-resume runner proven by the recovery powered campaign exists only as gitignored scratch under `experiments/recovery-runner/powered/`; committing a campaign runner is part of this milestone. | No store-isolation breach; fixture-leakage audit passes; scorer agreement on replay; control-arm fault baseline estimated (enough control fault-tasks, ~12-15, to bound the rate); powered N frozen; campaign runner committed. |
| M7 Powered controlled study | Full-factorial paired run at the frozen N. | The campaign scaffolding PATTERN (session-guard/watchdog/identity-keyed resume) that carried the 9,240-cell ~49h recovery campaign; note those scripts are currently gitignored scratch under `experiments/recovery-runner/powered/` and must be committed via M6 before M7 starts. | Analysis report includes paired primary and secondary outcomes with CI; all score records assert isolated storeRoot. |
| M8 Live shadow readout | Extend the EXISTING production assignment (`resolveHintMode`) + `learning_effectiveness` observational readout; exploratory only. | Production hint-mode substrate; `experience-effectiveness.ts` computeArmComparison. | Report separates live exploratory results from controlled causal results; no second live assignment system exists. |
| M9 Paper-ready evidence map | Claim-to-artifact table + no-overclaim summary incl. the circularity disclosure. | Claim-map conventions of the existing paper evidence sections. | Paper section can cite protocol, ledger, score records, leakage audit, and analysis report. |

## 14. Verification Matrix

| Case | Required result |
|---|---|
| Same fixture + seed rerun | Same run order; same deterministic scores. |
| Control arm-run | No runtime memory/playbook pack visible to host; pack computed and logged; retrieval attempts blocked and recorded. |
| Treatment arm-run | Relevant active memory/playbook appears when expected; logged identically. |
| Candidate memory/playbook | Not surfaced as active guidance. |
| Superseded memory | Suppressed by default and recorded as suppressed. |
| Memory pack authority | Always `non_authoritative`. |
| Memory pack gate evidence | Always `false`. |
| Store isolation | Resolved learning root for every arm-run is the experiment temp root, never the production `.lattice/learning/`; violation voids the run. |
| Memory snapshot | Snapshot hash identical before and after the powered run. |
| Fixture leakage | Leakage audit proves neither arm can derive the trap answer from the fixture tree (e.g. no in-tree `verify-lattice-residue.mjs`, no runbook answer prose). |
| Held-out trap | Its lesson is absent from the frozen memory snapshot. |
| False-DONE task | Scorer detects the false-DONE attempt from structured DONE rows deterministically. |
| Parent-roadmap trap | Treatment pack nudges parent rollup check; score still relies on current structured facts. |
| Host-policy trap | Treatment expects Codex CLI + Claude Code CLI; agy is fallback only. |
| Deprecated-brand trap | Old brand residue detected by the ORACLE (not by an in-tree script both arms can run). |
| Review-lane trap | Main/implementer evidence does not count as reviewer proof (structured lane-provenance check). |
| Analysis rerun | Same score records produce same report digest. |

## 15. No-Overclaim Rule

Allowed after M7 if statistically supported:

> In a powered, paired, controlled seeded study, automatic experience-layer
> consumption reduced the primary defect rate (deterministic composite of
> failed validation / false-DONE / oracle mismatch / lane-provenance
> violation), and specifically the recurrence of known failure modes
> (repeat-defect rate), by X percentage points on fault-bearing tasks under
> the tested task distribution. In-store traps improved by Y points vs Z for
> held-out traps.

Required disclosure alongside any such claim: the in-store seeded traps are
authored from the same lesson store the treatment surfaces; the held-out
contrast bounds how much of the effect is lesson-specific rather than generic
priming.

Allowed after M8 only as exploratory unless powered:

> Live shadow data is directionally consistent with the controlled study.

Disallowed:

> Proofbound agents became smarter.

Disallowed:

> Memory proves DONE.

Disallowed:

> The experience layer eliminates defects.

Disallowed:

> The experience layer generalizes to failure modes it has no lessons for
> (unless the held-out contrast itself is powered and positive).

## 16. Paper Integration

If the study passes, add a concise paper subsection:

> Runtime Memory Consumption Ablation

Suggested table columns:

| Trap group | Fixtures | Control defect rate | Treatment defect rate | Paired risk difference (95% CI) | Repeat-defect rate delta | Median time delta | Cost delta |
|---|---:|---:|---:|---:|---:|---:|---:|

Suggested core sentences:

> Memory existing is not enough; Proofbound tests whether automatically
> consuming relevant lessons at lifecycle entrypoints causally reduces
> recurrence of known failure modes. Because the seeded traps are authored
> from the same lesson store the treatment surfaces, the study reports an
> in-store vs held-out contrast and claims only lesson-specific recurrence
> reduction under the tested distribution.

Keep this in the operational evidence section, not as the sole main
experiment.

## 17. Recommended Execution Order

1. Implement M0-M5 (mostly wiring of named existing components).
2. Run the M6 pilot: at least 5 fixtures per trap group through both arms,
   plus enough control-arm fault tasks (~12-15) to estimate the baseline rate.
3. Fix leakage/isolation/scoring issues and re-freeze N before any powered
   claim.
4. Run M7 with the frozen per-population N from M5/M6.
5. Only then extend the live readout (M8).
6. Publish the M9 paper-ready evidence map after the analysis report is
   frozen.

Shared-resource scheduling note: the M0-M6 build is scheduling-independent.
The M7 campaign draws on the same shared host token budget and
session-guard/watchdog fleet as other live multi-day runs; schedule it so it
does not overlap another live campaign. The section 5/6 recovery powered run
completed on 2026-06-29, so there is no gating dependency on it; at the
corrected seeded sizing (roughly 27-62 powered in-store fault fixtures, each
run under both arms — i.e. ~54-124 arm-runs — plus the separately sized
held-out negative-control and clean fixtures) the expected footprint is on
the order of one to two days of campaign time, a small fraction of a weekly
budget.

## 18. Definition Of Done

The plan is complete only when:

- protocol hash and memory-snapshot hash are frozen;
- fixture manifest, pair ledger, and run-order seed are immutable and
  reproducible;
- control/treatment arm behavior (compute-and-log both, render-gate one) is
  mechanically verified;
- store isolation is asserted per run (no production `.lattice/learning/`
  reads or writes) and the fixture-leakage audit passed;
- per-population sample size calculation is recorded before the powered run,
  with the seeded baseline validated in the pilot;
- powered paired study score records are complete;
- analysis report includes paired effect size, confidence interval, p-value,
  and the in-store vs held-out contrast;
- no-overclaim guard text including the circularity disclosure is in the
  report;
- paper-ready claim-to-artifact map is generated;
- final summary states whether causal impact was supported, unsupported, or
  inconclusive.
