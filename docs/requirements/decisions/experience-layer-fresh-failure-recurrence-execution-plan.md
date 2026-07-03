# Experience Layer Fresh-Failure Recurrence Execution Plan

Status: pre-registration (rev 3, 2026-07-03)

## 1. Status And Provenance

Revision provenance: rev 3 is the successor design triggered by the measured
outcome of the rev 2 M6 pilot. It supersedes ONLY the M7 powered-run route of
the rev 2 plan
(`docs/requirements/decisions/experience-layer-ablation-causal-validation-execution-plan.md`).
Everything else in rev 2 remains authoritative:

- The rev 2 file itself stays byte-untouched. Its sha256 is
  `2ef4122ef1030c97536b8d6eda37619a9c029fc466d5b8706102201130835471` and is
  digest-recorded in the M9 evidence map
  (`experiments/experience-ablation/evidence-map.mjs`, `PLAN_DOC_RELPATH`);
  rewriting a completed pre-registration retroactively would break both the
  digest chain and pre-registration ethics.
- The completed rev 2 milestones M0-M6 (protocol freeze, fixture generator,
  pair ledger, arm switch, deterministic scorer, sample-size calculator,
  pilot campaign) and their evidence remain authoritative and are reused
  here as instruments.
- The rev 2 M8 exploratory live readout and M9 evidence map remain
  authoritative, including the recorded verdict of the rev 2 study:
  `Causal impact: INCONCLUSIVE` (design assumption invalidated by
  measurement, which rev 2 section 18 explicitly permits).
- The rev 2 M7 powered controlled study is the single element replaced: it
  was mechanically refused by the pre-registered freeze rule and closed by
  explicit user decision (`m7-decision.json`, `skip_powered_study`). This
  document pre-registers the replacement study end to end BEFORE any
  implementation, and must pass adversarial review before work starts.

The honesty scaffolding of rev 2 is retained unchanged in kind: explicit
claim boundary, pre-registration discipline, immutable pre-outcome ledger,
mechanical control-arm isolation, deterministic scoring, stopping rules, and
a no-overclaim rule.

## 2. Trigger

The rev 2 M6 pilot (`expabl-m6-pilot-v1`, story B-beeb) measured the
control-arm in-store fault baseline at 1/30 = 0.0333 with Wilson 95%
confidence interval [0.0059, 0.1667] (a Wilson confidence interval is the
score-method interval for a binomial proportion; it is the interval the
pilot freeze rule operates on). The pre-registered planning band was
[0.5, 0.8]. `sample-size.mjs pilotFreezeCheck` — the executable form of the
rev 2 section 7 freeze rule — mechanically REFUSED the powered-N freeze at
both pre-registered minimum detectable effects (0.25 and 0.35) with
`freeze_baseline_too_low`: at a 0.0333 baseline no N is computable for the
pre-registered MDE band, so the pre-registered powered paired study was
mathematically unsizable. The user then decided `skip_powered_study`
(`m7-decision.json`, 2026-07-03) rather than harden traps or inflate N.

Interpretation (the lesson-aging reading): the six in-store trap classes
were authored from failure modes documented months before the pilot ran.
Hosts improve fastest on well-attested failure patterns, so ARCHIVAL lessons
target mistakes the current host no longer makes — the traps simply failed
to trip the host. The value of a captured lesson is therefore time-bounded:
it lives in the window between a new failure mode's FIRST OCCURRENCE under
the current host and that mode's ABSORPTION into model behavior (the point
at which the unaided host stops making the mistake, via provider model
updates or behavioral drift). Rev 2 measured lessons long after that window
had closed, and measured — correctly — nothing.

Rev 3 makes lessons the same age as the model: it harvests failure modes the
CURRENT pinned host actually produces, captures lessons from them
immediately, and measures recurrence reduction inside the same pinned-model
window. Difficulty is calibrated by construction (the host just failed these
tasks), eliminating the authored-difficulty guess that sank rev 2.

## 3. Terminology

| Term | Definition |
|---|---|
| Failure mode / failure class | A set of observed host failures sharing one normalized root-cause signature (same trigger condition, same failure shape), keyed in the style of the learning-store signature registry (`.lattice/learning/signature-registry.json`). "Class" is the unit of clustering and of the split. |
| Fresh failure | A failure mode produced by the CURRENT pinned host model, confirmed reproducible under that model during the harvest phase of this study. |
| Capture loop | The harvest -> reproduce -> lessonize -> surface pipeline that turns a just-observed failure into a surfaced lesson within the same model window. This is the quantity under test. |
| Archival store | The pre-existing long-lived lesson store measured (and found inert) by rev 2. NOT under test here. |
| Lesson | A dev-memory entry (`validateEntry`-conformant: summary, trigger, lesson, reusePrompt; `authority=non_authoritative`, `gateEvidence=false`) plus optionally an active playbook row, describing a failure MODE — never a specific task's answer. |
| Lessonize | Author a lesson from a harvested, reproduced failure class. |
| Variant | A new task fixture exhibiting the SAME failure mode as its class but with a perturbed surface (different names, values, scenario framing). |
| Recurrence (R) | Binary per variant-run: the class's failure-mode oracle (a hidden deterministic checker) detects the same mode in the post-run workspace. |
| In-store / held-out | The two halves of the random class split: in-store classes have their lessons in the frozen snapshot the treatment arm surfaces; held-out classes deliberately do not. |
| DiD | Difference-in-differences: the in-store paired recurrence delta minus the held-out paired recurrence delta (section 7.2). |
| Pinned-model window | The study period during which the host model identifier is frozen; all runs must carry the identical model id. |
| Discordant pair | A variant whose control and treatment runs disagree on recurrence. |
| ICC (rho) | Intra-class correlation of paired outcome differences among variants of the same class; inflates required N via the design effect DEFF = 1 + (n-1)*rho, where n is variants per class. |
| pilotFreezeCheck | The executable rev 2 freeze rule (`experiments/experience-ablation/sample-size.mjs`): >= 15 control-arm runs, Wilson 95% CI, freeze N at the N-maximizing (variance-maximizing) parameter value within the CI, refuse when unsizable. |

## 4. Claim Boundary

This study may support the following claim:

> For failure modes freshly harvested from the current pinned host,
> automatically surfacing a freshly captured lesson reduces same-mode
> recurrence on perturbed variants, beyond generic priming, within the
> pinned-model window and under the tested task distribution.

This study must not claim:

- the base model became smarter;
- memory is proof or gate evidence (memory remains
  `authority=non_authoritative`, `gateEvidence=false`);
- generalization to failure modes outside the harvested set or to task
  distributions other than the tested one;
- permanence of the effect beyond the pinned-model window;
- anything about the ARCHIVAL store's value — rev 2 already returned
  inconclusive on that, and this study does not reopen it;
- live production behavior from a synthetic-only experiment.

Shared-provenance circularity (disclosed by design, section 11): lessons and
variants both derive from the same harvested failures. The held-out arm of
the split is the control for generic priming; the claim is bounded to
lesson-specific recurrence reduction.

## 5. Revised Hypothesis

### H1'

For freshly harvested failure modes, surfacing a freshly captured lesson at
runtime reduces same-mode recurrence on perturbed variants, measured within
a pinned-model window as a positive difference-in-differences: the
control-minus-treatment recurrence delta on in-store classes exceeds the
same delta on held-out classes.

The quantity under test is the CAPTURE LOOP — whether the
harvest -> lessonize -> surface pipeline can hold the line during the window
before model evolution absorbs a new failure mode. It is NOT the archival
store: rev 2 already established that months-old lessons target mistakes the
current host no longer makes.

### H0'

There is no lesson-specific effect: the control-minus-treatment recurrence
delta is the same on in-store and held-out classes (DiD = 0). Any common
delta is generic priming, not captured-lesson value.

### Secondary Estimands (estimation only, no primary decision weight)

| ID | Estimand | Measurement |
|---|---|---|
| S1 | Generic-priming effect | Held-out paired recurrence delta alone, with cluster-bootstrap CI. |
| S2 | Overhead | Treatment-minus-control time-to-done and command-count deltas across all pairs (equivalence-style reporting). |
| S3 | Consumption fidelity | Expected lesson ids present in the surfaced pack on in-store treatment runs (`expectedMemoryIds` vs `surfacedMemoryIds`). |
| S4 | Per-class effects | Per-class paired deltas as estimation with CI; never hypothesis tests unless a class has a predeclared N. |

## 6. Design

### 6.1 Harvest

Candidate failure modes come from TWO sources, both restricted to failures
attributable to the current host generation:

**Source A — findings-corpus mining.** Mine the learning store's structured
findings corpus: `.lattice/learning/finding-signals.json` (signature-keyed
signal rows with per-signature counts, anchor files, and example finding
ids; 1,511 findings over 333 stories at the time of writing) and
`.lattice/learning/signature-registry.json` (the canonical signature tag
registry). Selection rule, pre-registered:

- Recency window: only signatures whose most recent contributing finding was
  created within the last 30 days before the harvest ledger freeze.
- Minimum occurrence count: >= 2 findings sharing the normalized signature
  within that window (a mode seen once may be noise; a mode recurring under
  the current host is a live failure mode).

Corpus findings do not record the host model id, so corpus-mined candidates
are CANDIDATES ONLY: every candidate must pass the repro-first filter
(section 6.2) UNDER THE PINNED MODEL before it becomes a study class. The
repro filter is thus also the freshness guard — a mode the pinned host no
longer produces is discarded, which is exactly the aging trap rev 2 fell
into.

**Source B — harvest campaign.** Run the pinned host against naturally hard
task families — the committed `experiments/recovery-runner/tasks/` corpus
families and live-story-shaped synthetic tasks in the same layout — and
capture every observed failure through the repro intake (section 6.2).
Campaign failures are fresh by construction (the pinned host just produced
them); they still pass the same repro filter to establish determinism.

Every harvested candidate gets a harvest-ledger row
(`harvest-ledger.jsonl`): {candidateId, source (corpus|campaign), signature,
firstObservedAt, occurrenceCount, anchorRefs}. The ledger is frozen (hashed)
before the split is drawn.

### 6.2 Repro-First Filter

Only failure classes that reproduce deterministically survive. The filter
uses the existing repro-first machinery (all commands verified against
`lattice --help` / `lattice repro_probe --help`, CLI 0.3.153):

- `lattice repro_probe` — record the candidate reproducer: `commandSpec`
  (command, args, env, cwd), `expectedFailure`, `expectedFailurePattern`
  (substring/regex matched against observed output), `executionStatus`
  (`not_run|run_attempted|confirmed_failing`), `producerObservedClass`
  (`target-bug|bootstrap-noise|environment-noise|unknown`),
  `observedFailureSummary`, `boundedOutputExcerpt`, plus optional
  `baselineHeadHash` / `materialHash`. Repro probes are evidence-candidate
  scope, NOT production/DONE evidence — consistent with the claim boundary.
- `lattice repro_probe_get` — retrieve a probe by id for audit.
- `lattice repro_review_set` — record an independent review verdict on the
  probe (the probe author does not self-accept).
- `lattice spike_record` — attach investigation notes linked to a probe.
- `lattice story_create_from_repro` — available for follow-up fix stories;
  NOT used inside the study (fixing a harvested mode mid-study would destroy
  its recurrence signal — see stopping rules).

Determinism criterion, pre-registered: a class survives only if its minimal
reproducer, executed 3 consecutive independent times under the pinned model
in fresh isolated roots, matches `expectedFailurePattern` all 3 times
(`executionStatus=confirmed_failing`, `producerObservedClass=target-bug`)
and its `repro_review_set` verdict accepts the reproduction. Mechanical
failures must reproduce on every run; host-behavioral failures use the same
3-of-3 rule as the operational definition of "reproduces deterministically".
Classes failing the 3-of-3 rule, classed as bootstrap/environment noise, or
rejected in review are discarded (recorded in the harvest ledger with the
discard reason).

**Minimum-yield stopping rule (K_min):** if fewer than K_min = 32
reproducible classes survive the filter, STOP and report
"insufficient harvest yield" — do not proceed to the split, do not lower the
bar. 32 is the floor at which, after the expected calibration attrition
(section 8), the study can still reach the top of the pre-registered MDE
band; the harvest TARGET is 60 reproducible classes, which supports the
bottom of the band (section 7.5 worked example). Harvest may run past K_min
toward the target while budget allows.

### 6.3 Sealed Random Split

- **Lessons first, split second:** ALL surviving classes are lessonized
  BEFORE the split is drawn, so in-store lessons cannot be authored with
  more care than held-out ones. Each lesson must pass the dev-memory
  `validateEntry` contract and describe the failure MODE (trigger pattern +
  failure shape + guard behavior); the mechanical answer-leak checks are in
  section 6.5.
- **Random half/half split:** classes are split 50/50 into in-store and
  held-out by a seeded PRNG (xmur3 + mulberry32 + Fisher-Yates, the
  committed `pair-ledger.mjs` pattern) over sorted class ids. The seed, the
  class list hash, and the resulting membership are sealed in
  `protocol.json` (and `split-seal.json`) BEFORE any variant run executes —
  the split cannot be redrawn after outcomes exist (ledger immutability,
  `guardImmutable` pattern: mutations refuse once `score-records.jsonl`
  exists).
- **Snapshot:** the frozen memory-store snapshot (built by adapting
  `snapshot-builder.mjs` to the harvested lesson table) contains the
  in-store lessons ONLY, plus the minimal anchor story the production render
  path requires. `memorySnapshotHash` is frozen in the protocol
  (`hashDirectorySnapshot`, `protocol.mjs`) and verified before and after
  every run (`run-pilot.mjs` materialization contract, reused unchanged).
- **Disjointness asserted mechanically** (generalizing the
  snapshot-builder disjointness check): (a) in-store and held-out class sets
  are disjoint and their union equals the accepted class set; (b) no byte of
  the frozen snapshot mentions any held-out class's signature, lesson text,
  or identifying tokens; (c) held-out lessons are quarantined OUTSIDE the
  snapshot with their own recorded hash (proving they existed pre-split and
  were excluded, not unwritten). Any assertion failure refuses the seal.

### 6.4 Variant Generation

For each accepted class, a deterministic variant generator (the
`fixture-generator.mjs` corpus layout and seeded-PRNG discipline, extended)
emits fixtures that preserve the failure MODE while perturbing the SURFACE:
renamed identifiers, changed literal values, different scenario framing and
directory shapes — byte-identical on the same seed, neutral fixture ids,
hidden per-fixture oracle (`oracle.mjs`) ported from the class's confirmed
reproducer, plus `reference-good/` / `reference-bad/` overlays proving the
oracle fires on the trap-hit solution and stays quiet on the correct one.

- Per class, the generator emits n_cal + n_max variants: indices 0-3 are
  consumed by the calibration mini-pilot (section 8) and are NEVER pooled
  into the powered analysis; the powered run consumes fresh indices
  4..(4+n-1) with n frozen at R4. Calibration and powered variant sets are
  disjoint by construction.
- Lessons are frozen (hashed, section 6.3) BEFORE variant generation begins,
  so a lesson cannot quote a variant; the ordering is enforced by hash
  timestamps in the protocol, not by convention.
- Lessons must describe the failure mode, never a variant's specific answer;
  this is enforced mechanically by section 6.5.

### 6.5 Similarity-Extended Leakage Audit

The committed leakage audit (`leakage-audit.mjs`: LEAKAGE_STRIP_LIST marker
scan over workspace/** and prompt.md, hidden-artifact placement checks,
prompt-omits-class check) runs unchanged, and is EXTENDED with a
variant-vs-lesson surface-similarity check over ALL (lesson, variant) pairs
— both splits, so a lesson for class A is also checked against class B's
variants. Mechanical definition, pre-registered:

1. **Normalization:** lesson text = concatenated summary + trigger + lesson
   + reusePrompt fields; variant surface = every host-visible byte
   (workspace/** + prompt.md + acceptance.mjs). Both lowercased,
   whitespace-collapsed.
2. **Word 5-gram Jaccard:** the Jaccard similarity (intersection over union)
   of word 5-gram sets between the lesson text and the concatenated variant
   surface must be < 0.05.
3. **Character 12-gram containment:** no character 12-gram of the normalized
   lesson text may appear verbatim in the variant surface, except grams
   fully inside the pre-registered common-vocabulary allowlist (generic
   phrases such as command names — the allowlist is frozen with the audit
   code and recorded in the protocol).
4. **Identifier overlap:** identifiers (`[A-Za-z_][A-Za-z0-9_-]{3,}`)
   extracted from the lesson text, minus the allowlist, must have EMPTY
   intersection with identifiers in the variant workspace. A lesson that
   names a variant's specific answer token fails here.
5. **Inherited strip-list:** the full rev 2 LEAKAGE_STRIP_LIST semantics
   (class names, lesson signature phrases, answer prose, executable residue
   tool names, meta markers) apply to every variant fixture unchanged.

Output: `similarity-audit.jsonl` rows {lessonId, fixtureId, checks, pass} in
deterministic order, appended to the standard `leakage-audit.jsonl`
workflow. Any failing row exits nonzero naming the pair and the check.
Passing the extended audit is an R3 exit criterion AND a hard R5
precondition (the campaign runner already refuses to start without a
complete, all-pass leakage audit; the similarity rows join that gate).

### 6.6 Experiment Arms

Identical to rev 2 — the instruments are reused unchanged:

| Arm | Behavior |
|---|---|
| Control A | Runtime memory pack computed and logged but NOT rendered to the host; memory/playbook retrieval mechanically blocked; any retrieval attempt recorded as `retrieval_violation` and counted. |
| Treatment B | The same pack rendered at the same lifecycle entrypoints; no extra gate power; pack renders `authority=non_authoritative`, `gateEvidence=false`. |

Reused verbatim from the committed chain: full-factorial matched pairs
(every variant runs under BOTH arms; `pair-ledger.mjs` with seeded run
order and immutability guard), the `run-pilot.mjs` per-cell execution
contract (fresh mkdtemp non-git isolated root; frozen-snapshot
materialization into `<workspace>/.lattice/` on BOTH arms with pre/post hash
verification; store-isolation assertion via `observability_snapshot`
resolving the learning root INSIDE the isolated root; experience-delivery
prelude via the real gated `session_brief` entrypoint so
`experience_pack_surfaced` fires on both arms; `LATTICE_EXPERIMENT_ID` /
`LATTICE_EXPERIMENT_ARM` env contract; `LATTICE_GLOBAL_MEMORY_DIR` pinned to
an empty dir; control host prompt byte-identical to raw prompt.md;
RUN-RECORD.md terminal run.json), and the `score.mjs` deterministic scorer
(purity contract, structured-artifact outcomes, storeRoot voiding). The
fail-closed arm contract is inherited: control rendering a pack, treatment
failing to render, or a missing surfaced event aborts the cell before host
execution.

### 6.7 Model Pinning

The host model identifier is a frozen protocol field and a per-run recorded
fact:

- `protocol.json` records `hostModelId` (the exact model identifier string
  the host CLI reports) and `hostCliVersion` at protocol freeze.
- Every run.json records the observed model id from the host invocation; the
  scorer voids any run whose recorded model id differs from the pinned
  `hostModelId`.
- A model change mid-study (any voided run for model mismatch, or the pinned
  model becoming unavailable) is a STOPPING-RULE BREACH (section 10): the
  study stops, and data collected up to the breach is exploratory-only. The
  pre-absorption window claim is only meaningful within one pinned model.
- Residual risk, disclosed: provider-side silent drift under an unchanged
  model id cannot be excluded mechanically. Mitigation: the seeded run order
  interleaves arms and classes across time (so temporal drift is not
  confounded with arm), and run timestamps are recorded for a drift check in
  the analysis report.

## 7. Metrics And Statistics

### 7.1 Outcome Definitions

Primary outcome variable, per arm-run: same-mode recurrence R (binary) — the
class's hidden failure-mode oracle, ported from the confirmed reproducer,
detects the mode in the post-run workspace from structured artifacts only
(deterministic, arm-blind; the `score.mjs` purity and replay contracts
apply). Per variant v, the paired difference is

```
d_v = R_control(v) - R_treatment(v)   in {-1, 0, +1}
```

(+1 = control recurred, treatment did not — the lesson-helped direction).

Voided runs (store-isolation, snapshot-drift, or model-mismatch voids) drop
the whole pair; class means are computed over surviving pairs.

### 7.2 Primary Estimator: Difference-In-Differences

For split S in {in-store, held-out}, let Delta_S be the mean of per-class
mean paired differences:

```
Delta_S = (1/m_S) * sum over classes c in S of  d-bar_c,
d-bar_c = (1/n_c) * sum over variants v of class c of d_v
DiD     = Delta_in-store - Delta_held-out
```

With the design's equal n per class this equals the variant-level mean; the
per-class-mean form is used because it stays unbiased when voids unbalance
classes. Delta_held-out measures generic priming (any effect of rendering
SOME lessons on modes with no lesson in store); DiD isolates the
lesson-specific effect. H1' predicts DiD > 0.

**Primary decision criterion (both conditions required, intersection-union,
no alpha inflation):**

1. DiD > 0 with the two-sided 95% seeded cluster-bootstrap CI (section 7.3)
   excluding 0 from below, AND
2. Delta_in-store > 0 with its own two-sided 95% cluster-bootstrap CI
   excluding 0 from below.

Condition 2 prevents declaring victory on a DiD driven by treatment HARMING
held-out classes rather than helping in-store ones. H1' is supported only
when both hold; otherwise the result is unsupported (or inconclusive if a
stopping rule fired).

### 7.3 Inference: Seeded Cluster Bootstrap

Cluster = failure class (variants within a class share provenance and are
correlated; treating them as independent would fake precision).

Procedure, pre-registered: resample m_in-store classes with replacement from
the in-store classes and m_held-out from the held-out classes (stratified by
split), keep every surviving variant pair of each sampled class (duplicates
kept), recompute Delta_in-store, Delta_held-out, DiD. B = 10,000 replicates;
percentile 95% CIs; PRNG = xmur3 + mulberry32 with the bootstrap seed
committed in `protocol.json` before the powered run, so the analysis report
is byte-reproducible. The same machinery yields the CIs for Delta_in-store
alone (condition 2) and the S1 generic-priming estimate.

### 7.4 Alpha, Power, And MDE Band

| Parameter | Value |
|---|---|
| Alpha | 0.05, two-sided |
| Power | 0.80 |
| MDE band for the DiD | 0.25 - 0.35 absolute |

The MDE band is deliberately large: a freshly captured lesson naming the
exact mode the host just failed should produce a LARGE recurrence reduction
if the capture-loop hypothesis is right; harvested classes are difficulty-
calibrated by construction. Disclosed limitation: if the true lesson-
specific effect is real but below 0.25, this study is not powered to see it
and must not claim absence of effect — only absence of evidence at the
tested MDE.

### 7.5 Sizing Procedure (pilotFreezeCheck Adaptation)

**Honest statement of the gap:** `pilotFreezeCheck` and its companions in
`sample-size.mjs` (`twoProportionNPerArm`, `mcnemarDiscordantPairs`,
`wilson95`) size a SINGLE paired contrast on one stratum against an absolute
MDE. They do NOT directly size a difference of two paired deltas with
class-level clustering. The formulas below are therefore DERIVED explicitly
rather than borrowed by name; what IS inherited from pilotFreezeCheck is its
discipline: measure the nuisance parameters in a pilot, freeze N at the
variance-maximizing (N-maximizing) parameter values within the pilot's 95%
CIs (the lower bound alone is not conservative — the rev 2 F-001 lesson),
and REFUSE the freeze when the study is unsizable.

Variance model (normal approximation for a mean of clustered paired binary
differences; m = classes per split, n = powered variants per class, rho =
ICC of d_v within class, sigma_d^2 = Var(d_v)):

```
Var(Delta_S) ~= sigma_d,S^2 * DEFF / (m * n),   DEFF = 1 + (n - 1) * rho
Var(DiD)      = Var(Delta_in-store) + Var(Delta_held-out)   (independent splits)
```

Required classes per split for MDE at alpha = 0.05 (two-sided), power 0.80
(z_alpha/2 = 1.960, z_power = 0.842):

```
m >= (z_alpha/2 + z_power)^2 * DEFF * (sigma_d,in^2 + sigma_d,held^2) / (n * MDE^2)
```

where sigma_d^2 for a paired binary outcome is pi_10 + pi_01 -
(pi_10 - pi_01)^2 with pi_10 / pi_01 the discordant-pair probabilities — the
McNemar quantities `sample-size.mjs` already manipulates, estimated here
from the calibration mini-pilot (section 8) instead of assumed.

**Freeze inputs and conservative floors (pre-registered):**

- sigma_d,S^2: cluster-bootstrap 95% CI from calibration pairs; freeze at
  the CI upper bound, floored at 0.3 per split.
- rho: cluster-bootstrap 95% CI from calibration; freeze at
  max(CI upper bound, 0.2).
- n: frozen at R4 by a small grid search (n in {4, 6, 8}) minimizing total
  powered arm-runs given the frozen rho; planning value n = 6.
- Per-class control baseline: acceptance band gate only (section 8); it does
  not enter the variance directly (discordance does).

**Worked planning example** (floors: sigma_d^2 = 0.3 per split, rho = 0.2,
n = 6, DEFF = 2.0; (1.960 + 0.842)^2 = 7.849):

| MDE (DiD) | m per split | Classes total | Powered arm-runs (x n x 2 arms) |
|---:|---:|---:|---:|
| 0.35 | 13 | 26 | 312 |
| 0.30 | 18 | 36 | 432 |
| 0.25 | 26 | 52 | 624 |

Plus calibration cost (section 8): |accepted classes| x 4 variants x 2 arms
(256 arm-runs at the K_min = 32 floor). **Budget cap, pre-registered: 2,000
total arm-runs (calibration + powered).** If the frozen parameters size the
study above the cap, or the achievable MDE at the cap falls outside the
[0.25, 0.35] band, the freeze is REFUSED and the study stops and reports —
the same honest terminal outcome pilotFreezeCheck produced for rev 2.

### 7.6 Secondary Outcomes

| Outcome | Analysis |
|---|---|
| Generic priming (S1) | Delta_held-out with cluster-bootstrap CI; estimation only, reported alongside every DiD claim. |
| Overhead (S2) | Paired treatment-minus-control time-to-done and command-count deltas over all pairs; bootstrap CI; equivalence-style reporting (no superiority demand). Clean-task overhead is NOT re-measured; rev 2's clean-task overhead evidence remains the reference and this is disclosed in the report. |
| Consumption fidelity (S3) | Fraction of in-store treatment runs whose surfaced pack contains the class's lesson id; a low value invalidates the delivery mechanism, not the hypothesis, and is reported as such. |
| Per-class breakdown (S4) | Per-class d-bar_c with CI; estimation, never hypothesis tests. |

Multiplicity: the primary is the single two-condition DiD criterion.
Secondaries are estimation-only; if any secondary is ever promoted to a
test, Benjamini-Hochberg at FDR = 0.05 applies across the secondary family
(machinery exists in `experiments/recovery-runner/analyze.mjs`).

## 8. Calibration Mini-Pilot And N Freeze

Before any powered run (the R4 milestone):

- **Cells:** every accepted class x calibration variants 0-3 x BOTH arms
  (paired, so discordance and ICC are estimable) under the full section 6.6
  execution contract. Calibration runs are excluded from the powered
  analysis by construction (disjoint variant indices, section 6.4).
- **Per-class acceptance band (control arm): d-hat_c in [0.3, 0.9]** — the
  class's control-arm variant recurrence point estimate over its >= 4
  control runs must fall within the band.
  - Lower bound 0.3 (detectability floor): below it, the class reproduces on
    the ORIGINAL surface but not on perturbed variants — the perturbation
    destroyed the mode, so the class would measure variant-generation
    quality, not lesson effect, and would dilute power exactly the way rev
    2's 0.0333 baseline did.
  - Upper bound 0.9 (degeneracy guard): a class failing at ~1.0 in control
    suggests the variants are structurally impossible rather than
    trap-bearing; no lesson can help, discordance collapses to zero, and the
    class adds cost without information.
- **Attrition handling:** an out-of-band class gets ONE bounded variant
  regeneration attempt (new seed, same mode) and one re-calibration; still
  out-of-band -> dropped, recorded pre-run in the calibration report. If
  fewer than 13 classes per split survive (the m floor for MDE 0.35), the
  band-never-met stopping rule fires.
- **Pooled freeze (direct pilotFreezeCheck reuse):** pooled control
  recurrence across accepted classes with its Wilson 95% CI
  (`wilson95`; >= 128 control runs at the K_min floor, far above the >= 15
  rule) recorded in `n-freeze.json`; sigma_d^2, rho, n, m frozen per section
  7.5 with the variance-maximizing-within-CI discipline; freeze refusal
  paths as stated there. No powered cell may run before `n-freeze.json`
  exists with a non-refused verdict — enforced the same way M0 enforces
  "no task runs without protocol hash" (the ledger refuses to build).

## 9. Milestones R1-R6

Each milestone names what it reuses from the committed rev 2 instrument
chain; only genuinely new pieces are built.

| Milestone | Goal | Reuses (rev 2 instruments) | Exit criteria |
|---|---|---|---|
| R1 Harvester + repro filter | Harvest ledger of fresh failure classes from findings-corpus mining + harvest campaign; repro-first filter applied. | `lattice repro_probe` / `repro_probe_get` / `repro_review_set` / `spike_record` intake chain; `finding-signals.json` / `signature-registry.json` corpora; recovery-runner task families as campaign substrate. | >= K_min = 32 classes with 3-of-3 pinned-model confirmed reproducers, each carrying a reviewed repro_probe artifact; harvest ledger frozen (hashed) with discard reasons recorded; harvest target 60 pursued while budget allows. |
| R2 Lessonizer + sealed split + snapshot | All classes lessonized, THEN random split drawn and sealed; in-store-only frozen snapshot built. | `snapshot-builder.mjs` (lesson table adapted; disjointness check generalized); `protocol.mjs` freeze + `hashDirectorySnapshot`; dev-memory `validateEntry` / playbook schema contracts; `pair-ledger.mjs` seeded-PRNG pattern for the split draw. | Lessons pass validateEntry and precede variant generation (hash-ordered); split seal in protocol.json before any variant run; all three section 6.3 disjointness assertions pass; memorySnapshotHash + quarantined held-out lesson hash frozen; hostModelId + hostCliVersion frozen in the protocol. |
| R3 Variant generator + similarity-extended leakage audit | n_cal + n_max perturbed-surface variants per class with ported hidden oracles; extended audit implemented and passing. | `fixture-generator.mjs` corpus layout, seeded determinism, reference-good/bad overlays; `leakage-audit.mjs` + LEAKAGE_STRIP_LIST (single marker-semantics source). | Byte-identical corpus on same seed; every oracle fires on reference-bad and passes reference-good; strip-list audit + all four similarity checks (section 6.5) pass over ALL (lesson, variant) pairs; similarity-audit.jsonl complete. |
| R4 Calibration mini-pilot + N freeze | Per-class band gate; nuisance-parameter estimation; m/n/MDE freeze or refusal. | `run-pilot.mjs` campaign runner (isolation, snapshot materialization, prelude, resume) unchanged; `score.mjs` scorer unchanged; `sample-size.mjs` wilson95 + pilotFreezeCheck discipline (adapted per section 7.5). | Calibration report with per-class baselines, band decisions, attrition; n-freeze.json frozen (or refused -> honest stop); >= 13 surviving classes per split; budget check against the 2,000 arm-run cap recorded. |
| R5 Powered paired run | Full-factorial paired run at frozen m and n on fresh variant indices. | `run-pilot.mjs` identity-keyed resume campaign pattern; `pair-ledger.mjs` immutability + seeded run order; RUN-RECORD.md contract; M3 arm-switch env contract. | All cells terminal; zero unresolved isolation/snapshot/arm-contract aborts; snapshot hash identical pre/post; model id identical and equal to hostModelId across every run.json; score-records.jsonl complete with voids documented. |
| R6 Analysis + evidence map | DiD analysis, seeded cluster bootstrap, verdict; claim-to-artifact evidence map. | `analyze.mjs` bootstrap/BH primitives; `live-readout.mjs` / `evidence-map.mjs` composer patterns (deterministic document pairs, digest cross-checks, fail-closed verdict composition); `sample-size.mjs` statistical primitives. | Analysis report byte-deterministic on replay (committed bootstrap seed); primary two-condition decision stated; generic-priming estimate reported alongside; evidence map digest-verifies every artifact incl. this plan and the untouched rev 2 plan; final verdict line supported / unsupported / inconclusive. |

## 10. Stopping Rules

Stop early only for validity or infrastructure failure, never because
interim results look good or bad. Pre-registered stops:

- scorer bug discovered;
- store-isolation breach, snapshot mutation (pre/post hash mismatch), or
  fixture-leakage / similarity-audit breach discovered after runs started;
- control arm rendered a pack, treatment failed to render, or systematic
  retrieval violations on control;
- MODEL-VERSION CHANGE: any run records a model id different from the pinned
  `hostModelId`, or the pinned model becomes unavailable mid-study — the
  window the study measures is gone; collected data becomes
  exploratory-only;
- harvest yield below minimum (K_min = 32 reproducible classes never
  reached);
- calibration acceptance band never met: fewer than 13 in-band classes per
  split after the one bounded regeneration round;
- N freeze refused (unsizable within the MDE band or over the 2,000 arm-run
  budget cap);
- a harvested failure mode is FIXED in the host toolchain mid-study (e.g.
  via `story_create_from_repro` acting on the same class) — that class is
  voided; if voiding drops a split below its frozen m, the study stops.

Every stop is recorded with its trigger artifact; a stopped study reports
honestly as stopped, exactly as the rev 2 refusal did.

## 11. Circularity And No-Overclaim

**Shared provenance, disclosed by design:** lessons and variants BOTH derive
from the same harvested failures. This is not a flaw to hide — it is the
design: the study asks whether capturing a failure helps against that same
failure mode's perturbed recurrence. The controls that keep this honest:

- the held-out arm carries the identical provenance but no lesson in store,
  so it is the control for generic priming (and for "the variants are just
  easy/hard" artifacts);
- the similarity-extended leakage audit (section 6.5) mechanically bounds
  surface overlap, so a positive result cannot come from the lesson quoting
  the variant's answer;
- lessons freeze before variants exist (hash-ordered), so leakage cannot
  flow lesson<-variant either.

**Permitted claims (if the primary criterion holds):**

> In a powered, paired, controlled study on freshly harvested failure modes,
> surfacing a freshly captured lesson reduced same-mode recurrence on
> perturbed variants by DiD = X points beyond generic priming (95% CI
> [a, b]), within the pinned-model window (hostModelId recorded) and under
> the tested task distribution. Generic priming alone measured Y points
> (95% CI [c, d]).

Required disclosure alongside any such claim: the shared provenance of
lessons and variants, and the held-out contrast as the generic-priming
bound.

**Disallowed claims:**

- "the model got smarter" — nothing here changes the base model;
- "memory is gate evidence" — memory remains `authority=non_authoritative`,
  `gateEvidence=false`, and repro probes remain evidence-candidate scope;
- generalization beyond the harvested modes or the tested distribution;
- permanence beyond the pinned-model window — the lesson-aging trigger of
  this very study predicts the effect DECAYS as the model absorbs the mode;
- any claim about the archival store's value (rev 2's inconclusive verdict
  stands untouched);
- live production impact from this synthetic study.

## 12. Evidence Artifacts

Artifacts live under the rev 2 experiment root family with a fresh
experiment id (`expfresh-*`):

```text
.lattice/experiments/experience-ablation/<experimentId>/
  protocol.json              # + hostModelId, hostCliVersion, split seal, similarity allowlist, bootstrap seed
  harvest-ledger.jsonl
  repro-refs.json            # repro_probe / repro_review_set artifact ids per class
  split-seal.json
  memory-snapshot-hash.json  # + quarantined held-out lesson hash
  variant-manifest.jsonl
  pair-ledger.jsonl
  run-order-seed.json
  leakage-audit.jsonl
  similarity-audit.jsonl
  calibration-report.json
  n-freeze.json
  score-records.jsonl
  analysis-report.json
  analysis-report.md
  evidence-map.json
  evidence-map.md
```

Immutability, atomic writes, canonical hashing, and the
"ledger frozen once the first score record exists" rule are inherited from
the committed `protocol.mjs` / `pair-ledger.mjs` implementations unchanged.
These artifacts are empirical evidence for the paper/system claim; they do
not satisfy story DONE or review gates.

## 13. Verification Matrix

| Case | Required result |
|---|---|
| Same seed rerun (split, variants, run order, bootstrap) | Byte-identical seal, corpus, order, and analysis report. |
| Candidate fails 3-of-3 repro | Discarded with reason in the harvest ledger; never enters the split. |
| Held-out class lesson | Exists in quarantine (hashed), absent from every snapshot byte; disjointness assertion fails the seal otherwise. |
| Lesson quoting a variant token | Similarity audit exits nonzero naming lesson, fixture, and check. |
| Control arm-run | No pack rendered; pack computed and logged; retrieval attempts blocked and recorded. |
| Treatment arm-run | Pack rendered via the production prelude; `authority=non_authoritative`, `gateEvidence=false`. |
| Run with wrong model id | Voided by the scorer; study-level stopping rule evaluated. |
| Snapshot pre/post hash mismatch | Cell aborted fail-closed, no run.json; mid-run discovery stops the study. |
| Store isolation | Resolved learning root inside the isolated mkdtemp root for every run; violation voids the run. |
| Calibration class out of band | One regeneration round, then dropped and recorded; never silently retained. |
| Powered run before n-freeze.json | Refused mechanically (ledger/runner precondition). |
| Analysis rerun on same score records | Same report digest (committed bootstrap seed). |
| Rev 2 plan file after this study | sha256 still `2ef4122e...` (digest-checked by the evidence map). |

## 14. Recommended Execution Order

1. Adversarial review of THIS document (user directive: review before
   implementation; the rev 2 lesson is that unreviewed design assumptions
   are what pilots then falsify expensively).
2. R1 harvest (both sources) until K_min = 32 reached, target 60.
3. R2 lessonize-all, seal split, freeze snapshot + model pin.
4. R3 variants + extended audit; fix generator until all-pass.
5. R4 calibration (~256 arm-runs at floor); freeze or refuse N.
6. R5 powered run (312-624 arm-runs at planning values; hard cap 2,000
   total) — schedule against the shared host token budget the same way the
   rev 2 M7 footprint note prescribed; do not overlap another live campaign.
7. R6 analysis + evidence map; publish the verdict line.

## 15. Definition Of Done

The study is complete only when every row below holds; each row is
mechanically checkable and names its artifact so the R6 evidence map can
digest-verify it (the `evidence-map.mjs` SECTION-rows pattern):

- protocol frozen with hostModelId, hostCliVersion, split seal, similarity
  allowlist, bootstrap seed, and memorySnapshotHash (`protocol.json`,
  `memory-snapshot-hash.json`);
- harvest ledger frozen with >= K_min reproducible classes, each bound to a
  reviewed repro artifact (`harvest-ledger.jsonl`, `repro-refs.json`);
- split disjointness assertions passed and sealed pre-run
  (`split-seal.json`);
- strip-list and similarity audits complete and all-pass over all
  (lesson, variant) pairs (`leakage-audit.jsonl`, `similarity-audit.jsonl`);
- calibration report and N freeze (or refusal) recorded before any powered
  cell (`calibration-report.json`, `n-freeze.json`);
- powered paired score records complete; every record asserts isolated
  storeRoot and the pinned model id; snapshot hash identical pre/post
  (`score-records.jsonl`);
- analysis report contains the DiD estimator, seeded cluster-bootstrap CIs
  for DiD and Delta_in-store, the two-condition primary decision, and the
  generic-priming estimate (`analysis-report.json/.md`);
- no-overclaim text including the shared-provenance disclosure is in the
  report (`analysis-report.md`);
- claim-to-artifact evidence map generated and digest-clean, including the
  untouched rev 2 plan digest (`evidence-map.json/.md`);
- final summary states whether H1' was supported, unsupported, or
  inconclusive — a stopped or freeze-refused study reports that outcome
  honestly, as rev 2 did.
