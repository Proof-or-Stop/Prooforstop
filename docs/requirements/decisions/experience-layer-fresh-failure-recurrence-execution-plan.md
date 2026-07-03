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
- Naming reconciliation: `m7-decision.json` lists a REJECTED alternative
  also called "rev 3" — re-sizing the SAME authored-trap study by amending
  baseline/MDE at the measured 0.0333 baseline. That rejected alternative is
  not this plan: this rev 3 is a successor design on freshly harvested
  failures whose difficulty is calibrated by construction; it keeps the MDE
  band but replaces the authored traps entirely.

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
`freeze_baseline_too_low`: at a 0.0333 baseline (even at the CI's
N-maximizing upper bound, 0.1667) no N is computable for the pre-registered
MDE band, so the pre-registered powered paired study was mathematically
unsizable. The user then decided `skip_powered_study`
(`m7-decision.json`, 2026-07-03) rather than harden traps or inflate N.

Interpretation (the lesson-aging reading): the six in-store trap classes
were authored from failure modes documented months before the pilot ran.
Hosts improve fastest on well-attested failure patterns, so ARCHIVAL lessons
target mistakes the current host no longer makes — the traps simply failed
to trip the host. The value of a captured lesson is therefore time-bounded:
it lives in the window between a new failure mode's FIRST OCCURRENCE under
the current host and that mode's ABSORPTION into model behavior (the point
at which the unaided host stops making the mistake, via provider model
updates or behavioral drift). On this reading, rev 2 measured lessons long
after that window had closed — an interpretation consistent with the pilot
data, not established by it (section 5).

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
| Capture loop | The harvest -> reproduce -> lessonize -> surface pipeline that turns a just-observed failure into a surfaced lesson within the same model window. The study manipulates only its LAST step — surfacing a freshly captured lesson — under study-idealized batch conditions; operational loop viability is not measured (sections 5, 11). |
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

The quantity under test is surfacing a freshly captured lesson within the
pinned-model window. It is NOT the archival store: rev 2's pilot showed that
the months-old authored traps no longer trip the current host — consistent
with, but not proving, lesson aging. Because lessons are authored in one
careful pre-split batch by the study team at a single time point, the
operational capture pipeline (incremental, automated, latency-bound) and the
window's duration are NOT under test; section 11 disallows claims about
them.

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
Campaign runs execute under the same isolation contract as arm-runs
(section 6.6): fresh mkdtemp non-git isolated roots with the store-isolation
assertion, so harvest failures can never write into the production learning
store that Source A mines — the contamination channel rev 2 section 12
documents for arm-runs is closed for harvest runs too.

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

**Minimum-yield stopping rule (K_min = 40) and harvest budget:** if fewer
than K_min = 40 reproducible classes survive the filter within the
pre-registered harvest budget, STOP and report "insufficient harvest yield"
— do not proceed to the split, do not lower the bar.

- **Harvest budget (makes the stop decidable):** at most 500 harvest-phase
  host runs (Source B campaign tasks + all 3-of-3 repro confirmation
  executions, combined, including discarded candidates) and at most 21
  calendar days from the first harvest run to the harvest-ledger freeze.
  Exhausting either bound below K_min fires the stop MECHANICALLY —
  "never reached" has a deadline, so the honest terminal outcome can
  actually occur. Harvest-phase runs are budgeted separately from the 2,000
  arm-run cap (section 7.5), which covers calibration + powered arm-runs
  only; harvest budget accounting is recorded in the harvest ledger.
- **K_min derivation (explicit binomial attrition model):** the calibration
  band gate (section 8, n_cal = 8, one bounded regeneration retry) accepts
  a class with true control recurrence p with per-attempt probability
  P(3 <= Bin(8, p) <= 7): p = 0.35 -> 0.572 (0.817 with retry);
  p = 0.40 -> 0.684 (0.900); p = 0.50 -> 0.852 (0.978);
  p = 0.625 -> 0.941 (0.997). Planning acceptance a = 0.8 per class
  (pessimistic; covers corpora with substantial mass near the lower band
  edge, true p >= 0.35 — a corpus concentrated exactly at the 0.3 edge
  would under-run the model at 0.695 with retry, a risk the R4 calibration
  report monitors by comparing realized attrition against this model).
  Post-split survivors per split are Binomial(K/2, a); the m floor at the
  top of the MDE band (0.35, n = 6) is 13 per split. K = 40 gives
  P(each split >= 13) = 0.968, jointly 0.937 — a defensible floor. The
  earlier draft's K = 32 gives only 0.598 per split (0.358 jointly), a
  coin flip against even a healthy corpus, and was therefore NOT a
  defensible floor; the floor is raised, not the claim weakened.
- **Targets:** the harvest TARGET is 60 accepted classes, which robustly
  supports MDE 0.30 (P > 0.99 per split of >= 18 survivors at a = 0.8);
  the bottom of the band (0.25, m = 26 per split) is reachable only if
  accepted yield lands near 66-70 classes, pursued only while the harvest
  budget allows. Harvest may run past K_min toward these targets within
  the budget.

### 6.3 Ordered Freezes And Sealed Random Split

The freeze order is: lessons -> variants -> split -> snapshot. Each step is
hash-frozen before the next begins, enforced by hash timestamps in the
protocol, not by convention.

- **Lessons first:** ALL surviving classes are lessonized BEFORE variant
  generation and BEFORE the split is drawn, so no lesson can quote a
  variant, and in-store lessons cannot be authored with more care than
  held-out ones (at lessonize time nobody knows which classes will be
  in-store). Each lesson must pass the dev-memory `validateEntry` contract
  and describe the failure MODE (trigger pattern + failure shape + guard
  behavior); the mechanical answer-leak checks are in section 6.5.
  Lessonize writes to a STUDY-LOCAL memory root only — never the production
  dev-memory store — so no concurrent session on this repository can
  consume a study lesson mid-study.
- **Variants second (split-blind):** the full variant corpus is generated
  and frozen (hashed) BEFORE the split is drawn. Variant authoring
  therefore cannot be tailored to a class's split assignment — the
  assignment does not exist yet — closing the channel where in-store
  variants are made lesson-susceptible while held-out variants are not.
  The generator manifest (section 6.4) records every generator input hash
  and asserts no lesson file is among them.
- **Split third — random, stratified, sealed:** classes are split 50/50
  into in-store and held-out by a seeded PRNG (xmur3 + mulberry32 +
  Fisher-Yates, the committed `pair-ledger.mjs` pattern), STRATIFIED by
  harvest source (corpus vs campaign) and, within Source B, by task family,
  drawn over sorted class ids within each stratum — a simple random split
  at m = 13-20 per split routinely realizes source-composition imbalance
  that the DiD would absorb. At most 2 accepted classes per task family
  enter the study (excess dropped deterministically by sorted class id,
  recorded in the harvest ledger); a 2-member family stratum sends exactly
  one class to each split. The split seed is drawn and committed only AT
  the split draw — deliberately NOT pre-committed at R2, because a
  pre-committed seed over the frozen class list would make the split
  precomputable during lesson/variant authoring. The seed, the class list
  hash, and the resulting membership are sealed in `protocol.json` (and
  `split-seal.json`) BEFORE any variant run executes — the split cannot be
  redrawn after outcomes exist (ledger immutability, `guardImmutable`
  pattern: mutations refuse once `score-records.jsonl` exists).
- **Snapshot fourth:** the frozen memory-store snapshot (built by adapting
  `snapshot-builder.mjs` to the harvested lesson table) contains the
  in-store lessons ONLY, plus the minimal anchor story the production render
  path requires. Anchor-story and playbook-row bytes are part of the audited
  pack surface (section 6.5). `memorySnapshotHash` is frozen in the protocol
  (`hashDirectorySnapshot`, `protocol.mjs`) and verified before and after
  every run (`run-pilot.mjs` materialization contract, section 6.6).
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

- Per class, the generator emits n_cal + n variants (8 + 6 = 14): indices
  0-7 are consumed by the calibration mini-pilot (section 8) and are NEVER
  pooled into the powered analysis; the powered run consumes fresh indices
  8-13 with n pinned at 6 (section 7.5). Calibration and powered variant
  sets are disjoint by construction.
- Generator inputs are auditable: `generator-manifest.json` records the
  path + hash of every input the generator read (confirmed reproducer,
  perturbation templates, seeds) and mechanically asserts that no lesson
  file hash appears among them — the generator is lesson-blind by
  construction and split-blind by ordering (section 6.3).
- Lessons are frozen (hashed, section 6.3) BEFORE variant generation begins,
  so a lesson cannot quote a variant; the ordering is enforced by hash
  timestamps in the protocol, not by convention.
- Lessons must describe the failure mode, never a variant's specific answer;
  this is enforced mechanically by section 6.5.
- `acceptance.mjs` must be format-only, proven mechanically: it must exit 0
  on BOTH the `reference-good` AND `reference-bad` overlays — an acceptance
  script that passes the known-wrong solution provably encodes no
  correctness knowledge. This proof is an R3 exit criterion, and
  `acceptance.mjs` is part of the audited variant surface (section 6.5).

### 6.5 Similarity-Extended Leakage Audit

The committed leakage audit (`leakage-audit.mjs`: marker scan,
hidden-artifact placement checks, prompt-omits-class check) is extended for
fresh classes and run over ALL (lesson, variant) pairs — both splits, so a
lesson for class A is also checked against class B's variants. Mechanical
definition, pre-registered:

1. **Surfaces and tokenization (shared by every check below):** lesson-side
   text = the FULL rendered pack bytes for the class — the `validateEntry`
   entry fields (summary, trigger, lesson, reusePrompt) PLUS the class's
   playbook row PLUS the anchor-story bytes, exactly as the production
   render path renders them from the frozen snapshot (held-out lessons are
   rendered identically from quarantine for audit purposes; nothing the
   treatment host can see escapes the audit). Variant surface = every
   host-visible byte of the fixture: `workspace/**` + `prompt.md` +
   `acceptance.mjs`. ALL checks below run over these two full surfaces; no
   check uses a narrower scope (in particular, `prompt.md` and
   `acceptance.mjs` are inside the identifier check's scope). Both sides
   are lowercased and whitespace-collapsed; word tokenization splits on
   `[^a-z0-9_-]+`; both sides tokenize with the IDENTICAL published
   function in the audit code, frozen under the protocol hash. Non-text
   (binary) files are scanned as raw bytes by checks 3, 5, and 6 and
   excluded from word-gram checks, with every exclusion recorded in the
   audit output.
2. **Word 5-gram containment:** |lesson 5-grams ∩ surface 5-grams| /
   |lesson 5-grams| must be < 0.05. Containment (normalized by the LESSON's
   gram count) replaces the earlier draft's Jaccard: union normalization is
   size-variant and vacuous for asymmetric texts — a full verbatim lesson
   embedded in a large variant surface can pass a Jaccard threshold, but
   scores containment 1.0 here.
3. **Character 12-gram containment:** no character 12-gram of the normalized
   lesson text may appear verbatim in the variant surface, except grams
   fully inside the frozen common-vocabulary allowlist (item 7).
4. **Identifier overlap:** identifiers (`[A-Za-z_][A-Za-z0-9_-]{3,}`)
   extracted from the lesson text, minus the allowlist, must have EMPTY
   intersection with identifiers extracted (same regex) from the FULL
   variant surface (workspace/** + prompt.md + acceptance.mjs). A lesson
   that names a variant's specific answer token fails here.
5. **Per-class answer-token denylist:** at R3, for every class, the audit
   auto-extracts the distinguishing byte sequences between the
   `reference-good` and `reference-bad` overlays (line-diff tokens), plus
   the spelled-out numeral forms of every numeric distinguishing token
   (e.g. `25` -> `twenty-five`, `twenty five`, `twentyfive`). A lesson-side
   surface containing ANY denylisted token for its class fails the audit —
   the mechanical form of "a lesson must not name its variant's answer",
   covering verbatim tokens AND their spelled-out numeral forms
   (`answer-denylist.jsonl`). Digit-leading literals, which the check-4
   identifier regex can never match, are caught here.
6. **Inherited strip-list with pre-registered fresh-class derivation:** the
   rev 2 LEAKAGE_STRIP_LIST marker semantics (class names, lesson signature
   phrases, answer prose, executable residue tool names, meta markers)
   apply to every variant fixture, with the per-class marker CONTENT for
   fresh classes derived by a pre-registered rule (the committed list is
   rev-2-class-specific and cannot match fresh classes): markers := the
   class's normalized signature key + identifiers extracted (check-4 regex)
   from its lesson text + verdict tokens from its oracle spec. A selfcheck
   asserts every class contributes >= 1 class-specific marker; an empty
   per-class marker set fails the audit. The scan surface includes
   `acceptance.mjs` (the committed scanner covered only prompt.md +
   workspace/**; this is a pre-registered extension — an acceptance script
   is host-visible and must not carry answer knowledge, see also the
   format-only proof in section 6.4).
7. **Allowlist governance (frozen BEFORE variants exist):** the
   common-vocabulary allowlist content is frozen in `protocol.json` at R2,
   BEFORE variant generation begins. Admission is mechanical, not
   judgmental: a token or gram is admissible only if it (a) occurs in >= 3
   distinct accepted classes' confirmed reproducers, or (b) belongs to the
   fixed framework-vocabulary scan (CLI command names and
   repository-generic terms) committed with the audit code before harvest.
   Answer-bearing tokens are denied by construction: the audit asserts
   allowlist ∩ answer-token denylist (item 5) = EMPTY for every class and
   fails closed otherwise. Any post-freeze allowlist edit is a protocol
   AMENDMENT: it changes the protocol hash, forces a full audit re-run, and
   is recorded as an amendment event — the allowlist cannot be quietly
   tuned until the audit passes.
8. **Residual risk, disclosed as un-mechanizable:** semantic paraphrase of
   an answer (synonym chains, arithmetic relations such as "swap the
   digits") is not mechanically detectable by any surface audit. The
   denylist (item 5) catches verbatim and spelled-out-numeral leaks; what
   remains is bounded only by the mode-not-answer authoring rule and is
   disclosed in section 11 alongside any positive claim.

Output: `similarity-audit.jsonl` rows {lessonId, fixtureId, checks, pass} in
deterministic order, appended to the standard `leakage-audit.jsonl`
workflow. Any failing row exits nonzero naming the pair and the check.
Passing the extended audit is an R3 exit criterion AND a hard R5
precondition (the campaign runner already refuses to start without a
complete, all-pass leakage audit; the similarity rows join that gate).

### 6.6 Experiment Arms

Identical to rev 2 in arm semantics; the instruments are reused with
exactly TWO pre-registered deltas, enumerated at the end of this section:

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
execution. It is EXTENDED with one further assertion: a held-out-class
treatment cell whose rendered pack is EMPTY aborts fail-closed before host
execution — the generic-priming contrast (section 7.2) is meaningful only
if priming actually renders, and an adapted snapshot at 13-30 lessons must
not be assumed to render the way the pilot's fixed 8-lesson pack did.
Per-split rendered-pack-size distributions are recorded for the R6 report.

The two pre-registered deltas from the rev 2 binaries (both in service of
the model pin, section 6.7) are: (1) `run-pilot.mjs` — the frozen hostCmd
embeds `--model <hostModelId>` and `--output-format json`, and the runner
parses the provider-reported model id and the host CLI version into
REQUIRED run.json fields (`modelId`, `hostCliVersion`), failing the cell
closed when either is absent or unparsable; (2) `score.mjs` — a new void
class for `modelId` / `hostCliVersion` mismatch against the frozen protocol
values. Everything else is reused byte-unchanged.

### 6.7 Model And Host-Stack Pinning

The pin is mechanical, not attested. The host model identifier and the host
stack are frozen protocol fields and per-run recorded, enforced facts:

- **Snapshot id only:** `protocol.json` records `hostModelId` as a
  fully-qualified, date-suffixed snapshot model id (it must match `-\d{8}$`
  or the provider's documented snapshot-id format). Protocol freeze REFUSES
  aliases (`sonnet`, `opus`, `default`, undated family names): an alias is
  a floating pointer the provider can retarget without the string changing,
  which would silently end the very window the study measures.
- **Pin in the command, echo in the output:** the frozen hostCmd template
  embeds `--model <hostModelId>` and `--output-format json`; the rendered
  template's hash (`hostCmdHash`) is frozen in `protocol.json`, so a
  mid-study flag or permission-mode change is detectable. The runner parses
  the provider-REPORTED model id from the JSON output into a REQUIRED
  `modelId` field of run.json, and the host CLI version (`claude
  --version`) into a REQUIRED `hostCliVersion` field; a cell whose output
  lacks either fails closed before scoring. The scorer voids any run whose
  `modelId` or `hostCliVersion` differs from the frozen protocol values.
  These are the two pre-registered deltas from the rev 2 instruments
  (section 6.6): the reused chain has no model-observation mechanism of its
  own, so without these deltas the pin would reduce to operator
  self-attestation and the "wrong model id" checks would compare a typed
  constant to itself.
- **Host stack frozen too:** host CLI auto-update is DISABLED for the
  campaign duration (setting recorded in the protocol). The absorption
  theory of section 2 includes host-side behavioral drift — CLI upgrades,
  system-prompt revisions, harness changes — so a host CLI version change
  is a stopping-rule breach exactly like a model change (section 10).
- **Staleness cap, pre-registered:** the last powered run must complete
  within 45 days of the harvest-ledger freeze. Past the cap the study STOPS
  as "window expired" and all collected data is exploratory-only — the
  study demands freshness of itself, not only of its inputs (section 6.1's
  30-day recency rule).
- **Drift check, pre-registered (statistic, threshold, consequence):**
  control-arm recurrence in the first half vs the second half of powered
  runs (ordered by run timestamp, pooled over splits) is compared; if the
  two-proportion 95% CI excludes 0 AND the absolute difference exceeds
  0.15, the primary verdict is downgraded to INCONCLUSIVE (window drift),
  whatever the DiD CI says. The seeded run order interleaves arms and
  classes across time, so temporal drift is not confounded with arm.
- **Residual risk, disclosed:** provider-side silent drift under an
  UNCHANGED snapshot id cannot be excluded mechanically. The snapshot-id
  rule removes alias retargeting from this residual (that failure is
  client-detectable and refused at freeze); what remains is genuinely
  un-mechanizable and is bounded by the staleness cap and the drift check.
- A model or host-stack change mid-study (any voided run for `modelId` /
  `hostCliVersion` mismatch, or the pinned model becoming unavailable) is a
  STOPPING-RULE BREACH (section 10): the study stops, and data collected up
  to the breach is exploratory-only. The pre-absorption window claim is
  only meaningful within one pinned model and host stack.

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

Voided runs (store-isolation, snapshot-drift, model-mismatch, or
host-CLI-version voids) drop the whole pair; class means are computed over
surviving pairs. A class with ZERO surviving pairs exits the analysis set
entirely (no 0/0 class mean is ever computed); m_S is recomputed over
classes with >= 1 surviving pair, and if ANY cause of class-level attrition
— voids of any kind, not only mid-study fixes — drops a split's surviving
class count below its frozen m, the below-frozen-m stopping rule fires
(section 10).

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
stopping rule fired). "Excluding 0 from below" is STRICT: the lower
percentile bound must be > 0; a bootstrap lower bound exactly equal to 0.0
(possible with lumpy resampling distributions) fails the condition.

### 7.3 Inference: Seeded Cluster Bootstrap

Cluster = failure class (variants within a class share provenance and are
correlated; treating them as independent would fake precision).

Procedure, pre-registered: resample m_in-store classes with replacement from
the in-store classes and m_held-out from the held-out classes (stratified by
split), keep every surviving variant pair of each sampled class (duplicates
kept), recompute Delta_in-store, Delta_held-out, DiD. B = 10,000 replicates;
percentile 95% CIs (subject to the R4 coverage verification below); PRNG =
xmur3 + mulberry32 with the analysis bootstrap seed committed in
`protocol.json` at the R2 protocol freeze, so the analysis report is
byte-reproducible. The same machinery yields the CIs for Delta_in-store
alone (condition 2) and the S1 generic-priming estimate.

Small-m coverage is verified, not assumed: percentile bootstrap CIs on few
clusters (m per split as low as 13, class means on a 1/6 grid) are known to
undercover, so R4 includes a seeded coverage simulation (section 8) with a
pre-registered fallback ladder percentile -> BCa -> cluster-t (Satterthwaite
degrees of freedom); the CI method actually used at R6 is the first to
reach the coverage bar and is frozen in `n-freeze.json` before any powered
run. Family-level dependence is bounded by design: at most 2 classes per
task family, split-stratified so a 2-member family contributes one class to
each split (section 6.3); cluster = class remains the resampling unit, and
this residual dependence is disclosed in the report.

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

- sigma_d,S^2: seeded cluster-bootstrap 95% CI from calibration pairs (the
  calibration-bootstrap seed is committed in `protocol.json` at the R2
  protocol freeze, before any calibration run executes, so `n-freeze.json`
  is byte-reproducible); freeze at the CI upper bound, floored at 0.3 per
  split.
- rho: estimated by the one-way random-effects ANOVA (method-of-moments)
  estimator over calibration d_v — (MSB - MSW) / (MSB + (n_cal - 1) * MSW)
  with class as the grouping factor, negative estimates truncated to 0 —
  with a seeded cluster-bootstrap 95% CI; freeze at
  max(CI upper bound, 0.2).
- n: PINNED at 6 (pre-registered constant; powered variant indices 8-13).
  An earlier draft froze n at R4 by a cost-minimizing grid search over
  {4, 6, 8}; that objective is vacuous — total powered arm-runs scale as
  rho * n + (1 - rho), monotone increasing in n for any rho > 0, so the
  search always returns the grid minimum and could never select its own
  planning value. n is therefore pinned, and every derived floor in this
  document (m = 13 per split at MDE 0.35, K_min = 40, the section 6.2
  attrition model) is computed at n = 6.
- m: from the formula above; when attrition unbalances the splits the
  asymmetric form is used:
  Var(DiD) = sigma_d,in^2 * DEFF / (n * m_in)
           + sigma_d,held^2 * DEFF / (n * m_held).
- Per-class control baseline: acceptance band gate (section 8) PLUS the
  pooled MDE-achievability refusal below — the baseline no longer merely
  "does not enter the variance"; it bounds the achievable effect.

**MDE-achievability refusal (`freeze_mde_exceeds_achievable_did`),
pre-registered:** the maximum physically achievable DiD is bounded by the
mean in-store control recurrence (treatment recurrence cannot go below 0,
and positive generic priming only shrinks DiD further). The freeze
therefore computes L_in = the Wilson 95% LOWER bound of pooled in-store
control recurrence over the calibration control runs (>= 104 runs at the
13-class floor), and REFUSES the freeze with
`freeze_mde_exceeds_achievable_did` whenever the frozen MDE exceeds
L_in - delta_prime, where delta_prime = 0.05 is the pre-registered
generic-priming allowance. This is the direct DiD analogue of the rev 2
`freeze_baseline_too_low` guard — the guard that mechanically saved rev 2
from running an impossible study — restored to the adapted sizing: without
it, a corpus whose perturbed variants truly recur near the band floor could
pass every other freeze check and bake an "unsupported" verdict in at
freeze time, a false PASS strictly worse than rev 2's honest refusal.

**Worked planning example** (floors: sigma_d^2 = 0.3 per split, rho = 0.2,
n = 6, DEFF = 2.0; (1.960 + 0.842)^2 = 7.849):

| MDE (DiD) | m per split | Classes total | Powered arm-runs (x n x 2 arms) |
|---:|---:|---:|---:|
| 0.35 | 13 | 26 | 312 |
| 0.30 | 18 | 36 | 432 |
| 0.25 | 26 | 52 | 624 |

**Pessimistic sensitivity row** (sigma_d^2 = 0.5 per split, rho = 0.4,
DEFF = 3.0): MDE 0.35 then requires m = 33 per split — 66 classes, 792
powered arm-runs — above even the 60-class harvest target. If the frozen
CI-upper parameters land near this row, refusal is the EXPECTED outcome
unless accepted yield materially exceeds the target; the floor table above
is the optimistic boundary of the design, not its forecast.

**Calibration cost accounting (honest form):** calibration cost accrues to
ALL calibrated classes — including classes later dropped by the band gate
and every one-shot regeneration re-calibration (16 additional arm-runs per
retried class) — at n_cal = 8 variants x 2 arms per class. At the
K_min = 40 floor: 640 base calibration arm-runs, planning expectation ~800
with retries; at the 60-class target: 960 base, ~1,200 with retries.

**Budget cap, pre-registered: 2,000 total arm-runs (calibration including
retries and dropped classes, plus powered).** Harvest-phase host runs
(Source B campaign tasks and repro confirmations) are governed by the
separate harvest budget in section 6.2 and do not draw on this cap. If the
frozen parameters size the study above the cap, or the achievable MDE at
the cap falls outside the [0.25, 0.35] band, or the MDE-achievability
refusal fires, the freeze is REFUSED and the study stops and reports — the
same honest terminal outcome pilotFreezeCheck produced for rev 2.

### 7.6 Secondary Outcomes

| Outcome | Analysis |
|---|---|
| Generic priming (S1) | Delta_held-out with cluster-bootstrap CI; estimation only, reported alongside every DiD claim, together with per-split rendered-pack-size distributions (empty held-out treatment packs abort fail-closed, section 6.6 — a priming contrast that never rendered priming would be vacuous). |
| Overhead (S2) | Paired treatment-minus-control time-to-done and command-count deltas over all pairs; bootstrap CI; equivalence-style reporting (no superiority demand). Clean-task overhead is NOT re-measured; rev 2's unpowered exploratory pilot overhead evidence (5 clean fixtures, tagged unpowered/exploratory, cost not recorded) remains the ONLY reference and is disclosed as such in the report. |
| Consumption fidelity (S3) | Fraction of in-store treatment runs whose surfaced pack contains the class's lesson id; a low value invalidates the delivery mechanism, not the hypothesis, and is reported as such. |
| Per-class breakdown (S4) | Per-class d-bar_c with CI; estimation, never hypothesis tests. |

Multiplicity: the primary is the single two-condition DiD criterion.
Secondaries are estimation-only; if any secondary is ever promoted to a
test, Benjamini-Hochberg at FDR = 0.05 applies across the secondary family
(machinery exists in `experiments/recovery-runner/analyze.mjs`).

## 8. Calibration Mini-Pilot And N Freeze

Before any powered run (the R4 milestone):

- **Cells:** every accepted class x calibration variants 0-7 (n_cal = 8) x
  BOTH arms (paired, so discordance and ICC are estimable) under the full
  section 6.6 execution contract. Calibration runs are excluded from the
  powered analysis by construction (disjoint variant indices, section 6.4).
- **Per-class acceptance band (control arm): p-hat_c in [0.3, 0.9]** — the
  class's control-arm variant recurrence point estimate over its >= 8
  control runs must fall within the band. (Notation: p-hat_c is the
  control-arm recurrence PROPORTION for class c; d-bar_c in section 7.2 is
  the mean PAIRED DIFFERENCE — different quantities, deliberately different
  symbols.) Honest granularity note: with n_cal = 8 the observable
  estimates land on eighths, so the de facto acceptance set is
  {3/8 .. 7/8} = [0.375, 0.875]. n_cal was raised from the earlier draft's
  4 to 8 precisely because a 4-run gate collapses the band to {1/2, 3/4}
  and its sampling noise alone generates attrition far above what that
  draft's K_min tolerated; the section 6.2 model now accounts for the
  remaining noise explicitly.
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
  out-of-band -> dropped, recorded pre-run in the calibration report. The
  expected attrition is not hand-waved: the section 6.2 binomial model
  publishes the acceptance probabilities and is the basis of K_min = 40;
  the calibration report compares realized attrition against that model.
  If fewer than 13 classes per split survive (the m floor for MDE 0.35 at
  n = 6), the band-never-met stopping rule fires.
- **Pooled freeze (pilotFreezeCheck discipline, adapted per section 7.5):**
  pooled control recurrence across accepted classes with its Wilson 95% CI
  (`wilson95`; >= 320 calibration control runs at the K_min = 40 floor, far
  above the >= 15 rule) recorded in `n-freeze.json`, with the pooled
  IN-STORE Wilson LOWER bound feeding the
  `freeze_mde_exceeds_achievable_did` refusal (section 7.5); sigma_d^2,
  rho, m frozen per section 7.5 (n pinned at 6) with the
  variance-maximizing-within-CI discipline; freeze refusal paths as stated
  there.
- **Coverage simulation (R4 exit criterion):** a seeded simulation (1,000
  simulated datasets under H0 at the frozen m, n, sigma_d^2, rho; inner
  bootstrap B = 2,000; seed committed at R2 alongside the
  calibration-bootstrap seed) must show realized CI coverage >= 93% for the
  pre-registered percentile method; if it fails, the pre-registered
  fallback ladder is BCa, then cluster-t with Satterthwaite degrees of
  freedom; if no method reaches 93%, the freeze is REFUSED (the inference
  machinery cannot deliver its nominal alpha at the frozen geometry). The
  method actually frozen is recorded in `n-freeze.json`
  (`coverage-check.json`) and used unchanged at R6.
- No powered cell may run before `n-freeze.json` exists with a non-refused
  verdict — enforced the same way M0 enforces "no task runs without
  protocol hash" (the ledger refuses to build).

## 9. Milestones R1-R6

Each milestone names what it reuses from the committed rev 2 instrument
chain; only genuinely new pieces are built.

| Milestone | Goal | Reuses (rev 2 instruments) | Exit criteria |
|---|---|---|---|
| R1 Harvester + repro filter | Harvest ledger of fresh failure classes from findings-corpus mining + harvest campaign (isolated roots); repro-first filter applied. | `lattice repro_probe` / `repro_probe_get` / `repro_review_set` / `spike_record` intake chain; `finding-signals.json` / `signature-registry.json` corpora; recovery-runner task families as campaign substrate; section 6.6 isolation contract for campaign runs. | >= K_min = 40 classes with 3-of-3 pinned-model confirmed reproducers, each carrying a reviewed repro_probe artifact, within the pre-registered harvest budget (500 harvest-phase host runs / 21 days); harvest ledger frozen (hashed) with discard reasons and budget accounting recorded; harvest target 60 (stretch 66-70 for the bottom of the MDE band) pursued while the harvest budget allows. |
| R2 Lessonizer + protocol freeze (lessons, allowlist, pin, seeds) | All classes lessonized to the study-local root; lesson set, similarity allowlist, model/host-stack pin, and seeds frozen BEFORE any variant exists. | dev-memory `validateEntry` / playbook schema contracts; `protocol.mjs` freeze + `hashDirectorySnapshot`. | All lessons pass validateEntry and live in the study-local root; lesson-set hash frozen BEFORE variant generation; similarity allowlist frozen under its mechanical admission rule (section 6.5 item 7); hostModelId (fully-qualified dated snapshot id — aliases refused) + hostCliVersion + hostCmdHash frozen; calibration, coverage, and analysis bootstrap seeds committed; host auto-update disabled and recorded. |
| R3 Variant generator + audits + sealed split + snapshot | Perturbed-surface variants (indices 0-13) with ported hidden oracles; extended audit passing; THEN stratified split sealed and in-store-only snapshot built. | `fixture-generator.mjs` corpus layout, seeded determinism, reference-good/bad overlays; `leakage-audit.mjs` + LEAKAGE_STRIP_LIST semantics (per-class content derived per section 6.5 item 6); `pair-ledger.mjs` seeded-PRNG pattern for the split draw; `snapshot-builder.mjs` (lesson table adapted; disjointness generalized). | Byte-identical corpus on same seed; generator-manifest.json records input hashes with no lesson file among them; every oracle fires on reference-bad and passes reference-good; acceptance.mjs exits 0 on BOTH overlays (format-only proof); strip-list (per-class derivation + non-empty selfcheck) + all similarity checks (section 6.5) pass over ALL (lesson, variant) pairs; allowlist ∩ answer-denylist empty; THEN the source/family-stratified split drawn and sealed and the snapshot built — all three section 6.3 disjointness assertions pass; memorySnapshotHash + quarantined held-out lesson hash frozen. |
| R4 Calibration mini-pilot + N freeze | Per-class band gate at n_cal = 8; nuisance-parameter estimation; coverage simulation; m/MDE freeze or refusal. | `run-pilot.mjs` campaign runner (isolation, snapshot materialization, prelude, resume) with the two section 6.6 deltas; `score.mjs` scorer with the model/CLI-version void delta; `sample-size.mjs` wilson95 + pilotFreezeCheck discipline (adapted per section 7.5). | Calibration report with per-class p-hat_c baselines, band decisions, attrition compared against the section 6.2 model; coverage-check.json with the frozen CI method (>= 93% realized coverage or refusal); n-freeze.json frozen (or refused -> honest stop) including the freeze_mde_exceeds_achievable_did check; >= 13 surviving classes per split; budget check against the 2,000 arm-run cap recorded (accounting includes dropped classes and retries). |
| R5 Powered paired run | Full-factorial paired run at frozen m (n = 6) on fresh variant indices 8-13. | `run-pilot.mjs` identity-keyed resume campaign pattern; `pair-ledger.mjs` immutability + seeded run order; RUN-RECORD.md contract; M3 arm-switch env contract. | Pre-R5 reproducer re-check complete (every class's frozen reproducer fires; non-firing classes voided); all cells terminal; zero unresolved isolation/snapshot/arm-contract aborts; snapshot hash identical pre/post; `modelId` and `hostCliVersion` present in every run.json and equal to the frozen protocol values; every held-out treatment cell rendered a non-empty pack; last powered run within the 45-day staleness cap; R5-close reproducer re-check complete; score-records.jsonl complete with voids documented. |
| R6 Analysis + evidence map | DiD analysis, seeded cluster bootstrap (frozen CI method), verdict; claim-to-artifact evidence map. | `analyze.mjs` bootstrap/BH primitives; `live-readout.mjs` / `evidence-map.mjs` composer patterns (deterministic document pairs, digest cross-checks, fail-closed verdict composition); `sample-size.mjs` statistical primitives. | Analysis report byte-deterministic on replay (committed seeds); primary two-condition decision stated with the strict CI boundary rule; generic-priming estimate + per-split pack-size distributions reported alongside; pre-registered drift check computed and its consequence applied; m_S recomputed against frozen m; evidence map digest-verifies every artifact incl. this plan and the untouched rev 2 plan; final verdict line supported / unsupported / inconclusive. |

## 10. Stopping Rules

Stop early only for validity or infrastructure failure, never because
interim results look good or bad. Pre-registered stops:

- scorer bug discovered;
- store-isolation breach, snapshot mutation (pre/post hash mismatch), or
  fixture-leakage / similarity-audit / answer-denylist breach discovered
  after runs started;
- control arm rendered a pack, treatment failed to render, a held-out
  treatment cell ran with an empty pack undetected, or systematic
  retrieval violations on control;
- MODEL-OR-HOST-STACK CHANGE: any run records a `modelId` or
  `hostCliVersion` different from the pinned protocol values, or the pinned
  model becomes unavailable mid-study — the window the study measures is
  gone; collected data becomes exploratory-only;
- WINDOW EXPIRED: the 45-day staleness cap (section 6.7) is exceeded before
  the last powered run completes; collected data becomes exploratory-only;
- harvest yield below minimum: K_min = 40 reproducible classes not reached
  within the pre-registered harvest budget (500 harvest-phase host runs /
  21 calendar days, section 6.2) — the budget makes this stop mechanically
  decidable;
- calibration acceptance band never met: fewer than 13 in-band classes per
  split after the one bounded regeneration round;
- N freeze refused (unsizable within the MDE band, over the 2,000 arm-run
  budget cap, `freeze_mde_exceeds_achievable_did`, or coverage-simulation
  failure across all pre-registered CI methods);
- BELOW-FROZEN-M, any cause: a split's count of classes with >= 1 surviving
  pair falls below its frozen m — whether from model voids, host-CLI
  voids, isolation voids, snapshot voids, or mid-study fixes (a class with
  zero surviving pairs exits m_S, section 7.1);
- a harvested failure mode is FIXED in the host toolchain mid-study (e.g.
  via `story_create_from_repro` acting on the same class) — detected
  MECHANICALLY, not by honor: every accepted class's frozen reproducer is
  re-executed once immediately before R5 begins and once at R5 close
  (`reproducer-recheck.jsonl`); a reproducer that no longer fires voids its
  class, and the below-frozen-m rule above then applies.

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
  surface overlap, and the per-class answer-token denylist forbids a lesson
  naming its variant's answer verbatim or in spelled-out numeral form, so a
  positive result cannot come from the lesson quoting the variant's answer;
- lessons freeze before variants exist (hash-ordered), so leakage cannot
  flow lesson<-variant either; and variants freeze before the split is
  drawn (section 6.3), so variant authoring is split-blind and cannot
  manufacture an in-store/held-out lesson-susceptibility asymmetry;
- residual risk, disclosed: semantic paraphrase of an answer (synonym
  chains, arithmetic relations such as digit transposition) is NOT
  mechanically detectable by any surface audit; this residual is
  un-mechanizable, and any positive claim must carry this disclosure.

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
- permanence beyond the pinned-model window;
- any causal claim about lesson aging, decay, or model absorption —
  including "the effect decays over time" and "this explains rev 2's
  null": no age or temporal contrast is measured anywhere in this design
  (lesson age is never manipulated; there is a single time point), so the
  lesson-aging reading remains an untested interpretation (sections 2, 5);
- operational pipeline-viability or window-duration claims — e.g. "the
  capture loop can hold the line in production": only the surfacing step is
  manipulated, under study-idealized batch conditions, and the window's
  duration is never measured;
- any claim about the archival store's value (rev 2's inconclusive verdict
  stands untouched);
- live production impact from this synthetic study.

## 12. Evidence Artifacts

Artifacts live under the rev 2 experiment root family with a fresh
experiment id (`expfresh-*`):

```text
.lattice/experiments/experience-ablation/<experimentId>/
  protocol.json              # + hostModelId (dated snapshot id), hostCliVersion, hostCmdHash, split seal, similarity allowlist, calibration/coverage/analysis bootstrap seeds, staleness cap, auto-update-disabled record
  harvest-ledger.jsonl       # + harvest budget accounting, family-cap drops
  repro-refs.json            # repro_probe / repro_review_set artifact ids per class
  generator-manifest.json    # variant-generator input hashes; asserts no lesson file among inputs
  split-seal.json
  memory-snapshot-hash.json  # + quarantined held-out lesson hash
  variant-manifest.jsonl
  pair-ledger.jsonl
  run-order-seed.json
  leakage-audit.jsonl
  similarity-audit.jsonl
  answer-denylist.jsonl      # per-class auto-extracted answer-token denylists
  calibration-report.json
  coverage-check.json        # R4 seeded CI coverage simulation + frozen CI method
  n-freeze.json
  reproducer-recheck.jsonl   # pre-R5 and R5-close reproducer re-execution results
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
| Harvest budget/deadline exhausted below K_min = 40 | Mechanical stop; "insufficient harvest yield" recorded with the budget accounting. |
| hostModelId given as an alias (no date suffix) | Protocol freeze refused. |
| Held-out class lesson | Exists in quarantine (hashed), absent from every snapshot byte; disjointness assertion fails the seal otherwise. |
| Lesson file among variant-generator inputs | generator-manifest assertion fails; corpus rejected. |
| Lesson quoting a variant token (verbatim or spelled-out numeral) | Similarity audit / answer-denylist check exits nonzero naming lesson, fixture, and check. |
| Allowlist entry intersecting an answer denylist | Audit fails closed; removing the entry is a protocol amendment with full audit re-run. |
| acceptance.mjs exits nonzero on reference-good or reference-bad | Format-only proof fails; variant corpus rejected at R3. |
| Control arm-run | No pack rendered; pack computed and logged; retrieval attempts blocked and recorded. |
| Treatment arm-run | Pack rendered via the production prelude; `authority=non_authoritative`, `gateEvidence=false`. |
| Held-out treatment cell renders an empty pack | Cell aborts fail-closed before host execution. |
| Run with missing/unparsable model id or host CLI version | Cell fails closed before scoring; no run.json field means no scoreable run. |
| Run with wrong model id or host CLI version | Voided by the scorer; study-level stopping rule evaluated. |
| Snapshot pre/post hash mismatch | Cell aborted fail-closed, no run.json; mid-run discovery stops the study. |
| Store isolation | Resolved learning root inside the isolated mkdtemp root for every run (arm-runs AND Source B harvest runs); violation voids the run. |
| Calibration class out of band | One regeneration round, then dropped and recorded; never silently retained. |
| Frozen MDE exceeds achievable DiD (L_in - 0.05) | Freeze refused with `freeze_mde_exceeds_achievable_did`; no powered cell runs. |
| Coverage simulation < 93% for every pre-registered CI method | Freeze refused; honest stop. |
| Powered run before n-freeze.json | Refused mechanically (ledger/runner precondition). |
| Class reproducer no longer fires at pre-R5 or R5-close re-check | Class voided mechanically; below-frozen-m stop evaluated. |
| Class with zero surviving pairs | Exits m_S (no 0/0 mean); below-frozen-m stop evaluated. |
| Last powered run past the 45-day staleness cap | Study stops as window-expired; data exploratory-only. |
| Analysis rerun on same score records | Same report digest (committed seeds, frozen CI method). |
| Rev 2 plan file after this study | sha256 still `2ef4122e...` (digest-checked by the evidence map). |

## 14. Recommended Execution Order

1. Adversarial review of THIS document (user directive: review before
   implementation; the rev 2 lesson is that unreviewed design assumptions
   are what pilots then falsify expensively).
2. R1 harvest (both sources, isolated roots, budget-bounded: <= 500
   harvest-phase host runs, <= 21 days) until K_min = 40 reached; target
   60, stretch 66-70.
3. R2 lessonize-all (study-local root); freeze lessons, similarity
   allowlist, model pin (dated snapshot id), hostCmdHash, and seeds.
4. R3 variants + extended audit (incl. acceptance format-only proof); fix
   generator until all-pass; THEN seal the stratified split and freeze the
   snapshot.
5. R4 calibration (640 base arm-runs at the K_min floor, ~800 with retries;
   960/~1,200 at target) + coverage simulation; freeze or refuse N (incl.
   the MDE-achievability check).
6. R5: pre-check reproducers, then powered run (312-792 arm-runs across the
   planning range; hard cap 2,000 total arm-runs; within the 45-day
   staleness cap) — schedule against the shared host token budget the same
   way the rev 2 M7 footprint note prescribed; do not overlap another live
   campaign. Close with the second reproducer re-check.
7. R6 analysis + evidence map; publish the verdict line.

## 15. Definition Of Done

The study is complete only when every row below holds; each row is
mechanically checkable and names its artifact so the R6 evidence map can
digest-verify it (the `evidence-map.mjs` SECTION-rows pattern). Temporal
rows ("pre-run", "before any powered cell") are digest-verified post hoc
through the protocolHash binding carried by every score record
(`score-records.jsonl`), which chains each run to the protocol state it ran
under:

- protocol frozen with hostModelId (dated snapshot id), hostCliVersion,
  hostCmdHash, split seal, similarity allowlist, committed seeds
  (calibration / coverage / analysis), staleness cap, and memorySnapshotHash
  (`protocol.json`, `memory-snapshot-hash.json`);
- harvest ledger frozen with >= K_min = 40 reproducible classes within the
  pre-registered harvest budget, each class bound to a reviewed repro
  artifact, discard reasons and budget accounting recorded
  (`harvest-ledger.jsonl`, `repro-refs.json`);
- ordered freezes hold: lessons before variants (hash-ordered), variants
  before the split, split sealed before any variant run, with generator
  inputs lesson-free (`generator-manifest.json`, `split-seal.json`);
- split disjointness assertions passed and sealed pre-run
  (`split-seal.json`; verified via the score-records protocolHash binding);
- strip-list, similarity, and answer-denylist audits complete and all-pass
  over all (lesson, variant) pairs, and the acceptance format-only proof
  passed (`leakage-audit.jsonl`, `similarity-audit.jsonl`,
  `answer-denylist.jsonl`);
- calibration report and N freeze (or refusal) recorded before any powered
  cell, including the MDE-achievability check and the coverage-simulation
  verdict (`calibration-report.json`, `n-freeze.json`,
  `coverage-check.json`; verified via the score-records protocolHash
  binding);
- total arm-runs within the 2,000 cap (calibration including dropped
  classes and retries, plus powered) and harvest-phase runs within the
  harvest budget (`calibration-report.json`, `n-freeze.json`,
  `harvest-ledger.jsonl`);
- powered paired score records complete; every record asserts isolated
  storeRoot, the pinned `modelId`, and the pinned `hostCliVersion`;
  snapshot hash identical pre/post; reproducer re-checks passed at R5 start
  and close (`score-records.jsonl`, `reproducer-recheck.jsonl`);
- analysis report contains the DiD estimator, seeded cluster-bootstrap CIs
  for DiD and Delta_in-store (frozen CI method), the two-condition primary
  decision with the strict boundary rule, the generic-priming estimate,
  per-split pack-size distributions, the drift-check result, and the
  recomputed m_S vs frozen m (`analysis-report.json/.md`);
- no-overclaim text including the shared-provenance disclosure and the
  paraphrase-residual disclosure is in the report (`analysis-report.md`);
- claim-to-artifact evidence map generated and digest-clean, including the
  untouched rev 2 plan digest (`evidence-map.json/.md`);
- final summary states whether H1' was supported, unsupported, or
  inconclusive — a stopped or freeze-refused study reports that outcome
  honestly, as rev 2 did (`analysis-report.md`, `evidence-map.md`).
