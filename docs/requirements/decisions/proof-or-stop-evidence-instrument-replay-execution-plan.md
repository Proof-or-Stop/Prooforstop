# Proof-or-Stop Evidence-Instrument Replay & Tamper Campaign Execution Plan

Status: DRAFT rev 3 (authored 2026-07-05; operator-approved for landing via
a dedicated docs story, then implementation stories per milestone.)

Revision provenance: rev 2 resolved 21 surviving findings from the
2026-07-05 adversarial self-review (3 lenses x per-finding refutation, 25
candidates). Load-bearing corrections: the seed-swap tamper class was a
no-op (seed is content-inert in the instrument — verified against
`buildBaselineRows`); H2's "reason" adjudication now uses a frozen per-class
flag-fingerprint table; ledger integrity claims are re-scoped to what
unsigned self-digests actually detect; determinism claims are bound to a
recorded environment; per-hypothesis verdicts are three-state. rev 3 adds
section 6.5 (operator decision, 2026-07-05): cross-vendor (Codex) roles —
red-team, audit, replication — and the explicit rule that outcome-judging
stays deterministic code, never any model.

## 1. Problem

The paper's thesis is "don't trust the agent, trust the evidence". Every
experiment and gate in this repo ultimately rests on a small set of
evidence-chain primitives: deterministic generators, digest-bound manifests,
fail-closed verifiers. The memory/playbook runtime baseline
(`packages/main/src/core/playbook-runtime-baseline.ts`) is the canonical
instance: a synthetic gold-checked retrieval benchmark at two scales
(small = exactly 1,000 records, full = exactly 1,000,000 records) whose
verifier re-derives digests and refuses (`status: fail`) when the evidence
chain is broken.

But the instrument's own trust story is currently backed only by:

- a committed single-shot smoke (`playbook-runtime-memory-baseline-smoke.ts`)
  covering several tamper cases — including manifest-REFRESHED
  (self-consistent) tampers via its `refreshManifest` path, a coverage class
  this plan's matrix must extend rather than duplicate; and
- ad-hoc manual replays (most recently the 2026-07-05 operator demo: 3
  consecutive small-profile verifies returned byte-stable digests and
  `expectedIdsFoundRate: 1`; a 1-byte tamper of `records.jsonl` in an
  isolated copy returned `status: fail` with `recordsDigestStable: false`
  and `staleDetected: true` — while the surface score
  `expectedIdsFoundRate` remained a perfect 1.0. Note: the same output
  showed `malformedRowsSkipped: 1`, which is the clean small profile's
  built-in corrupt row, NOT tamper evidence; detection came from the digest
  flags alone).

That demo is the seed of this plan and exhibits the core proof-or-stop
property worth PROVING SYSTEMATICALLY rather than anecdotally: **the verdict
follows the evidence chain, not the surface score** — a tampered corpus can
still score a perfect expectedIdsFoundRate (1.0) over the gold queries, and
the verifier must refuse anyway.

No committed harness today runs the instrument as a CAMPAIGN: N replays x 2
scales, a systematic tamper-class matrix with frozen expected verdicts,
interruption/resume, and a final verdict computed offline from an
append-only ledger rather than from any agent's narration.

## 2. Purpose (why do this)

1. **Foundation, not feature.** The operator's locked priority (2026-07-02)
   is coding-solid + Tier-C evidence foundation; domain packs are frozen.
   This campaign hardens the foundation layer every other experiment leans
   on — including the completed experience-ablation study (M0-M9, verdict
   INCONCLUSIVE) and the rev-3 pre-registration, both of which consume
   digest-bound evidence primitives of exactly this kind.
2. **A cheap, fully deterministic paper exhibit.** The paper's operational
   evidence section currently proves loop discipline with expensive live
   campaigns (recovery powered run, injection probes). This campaign adds
   the complementary exhibit at near-zero token cost: *the measuring stick
   itself is evidence-backed* — reproducible on replay, fail-closed under
   enumerated tamper, operable unattended.
3. **A reusable batch-campaign template.** The ledger + offline-verdict
   pattern (identity-keyed idempotent iterations, append-only evidence,
   verdict from files) is the same skeleton rev-3 or any future powered run
   needs; proving it end-to-end on a deterministic instrument first
   de-risks the pattern before it carries a nondeterministic study. M5's
   transcript-vs-ledger scoring method is explicitly a pilot of the
   instrumentation rev-3's live phase would need.

Explicitly NOT a goal: measuring agent quality, memory value, or retrieval
relevance. This campaign proves properties of the INSTRUMENT, not of the
thing the instrument measures (see Claim Boundary).

## 3. Claim Boundary

May claim, if all hypotheses are supported:

> Under the recorded environment (pinned node version, platform, and
> instrument commit), the memory-baseline evidence instrument is
> replay-deterministic (identical digests over N independent replays at 1k
> and 1M scale), tamper-evident for the enumerated tamper matrix (every
> class in the fail-closed set fails closed with its pre-registered
> fingerprint, including classes that leave surface scores perfect), and
> campaign-operable (an
> unattended batch completed with every iteration ending in a
> machine-checkable proof record or an explicit stop record, surviving the
> probed interruption classes — process kill at an iteration boundary and
> mid-iteration — without duplication or gaps).

Must NOT claim:

- anything about agent honesty, capability, or behavior (no agent output is
  scored in the primary arms; M5 output is excluded from the report);
- anything about memory/experience-layer VALUE (rev 2 of the ablation plan
  returned inconclusive; this campaign does not reopen it);
- tamper-PROOF (the campaign proves detection of the enumerated classes
  only; an unenumerated adversary class is out of scope — the tamper matrix
  is a coverage list, not a security proof);
- adversarial ledger integrity (ledger self-digests detect accidental
  corruption and naive edits only; an editor who recomputes digests defeats
  them — cryptographic signing is the separate Tier-C program, referenced
  not implemented here);
- cross-environment determinism (the claim binds to the recorded
  environment; a second-environment spot-check is an optional arm, see 6.1);
- generalization to other instruments beyond the one under test (the
  TEMPLATE may be reused; the RESULT binds to this instrument).

## 4. Hypotheses

Verdicts are THREE-STATE per hypothesis: supported / falsified /
not-evaluable (with a machine-readable reason). A stop record in a replay
arm makes H1 not-evaluable at that scale (never silently "supported"), and
the section 3 claim requires all four SUPPORTED verbatim.

| ID | Hypothesis | Falsifier | Not-evaluable trigger |
|---|---|---|---|
| H1 Replay determinism | All N replay iterations per scale produce proof records, and their records/gold/manifest digests and gold metrics are pairwise identical. | Any digest or metric drift across replay proof records. | Any replay-arm stop record at that scale. |
| H2 Tamper fail-closed | Every class in the frozen FAIL-CLOSED set (each carrying a failure signal per section 6.1's two-pronged viability check) yields `status: fail` AND its observed values over the frozen fingerprint domain (boolean flag vector + declared numeric predicates) match the frozen per-class fingerprint. Accepted-behavior combinations are dispositioned separately and are not part of this set. | Any fail-closed-set class returning `status: pass`, or observed fingerprint-domain values that contradict the frozen fingerprint (misattribution). | A tamper class whose mutation cannot be applied (harness precondition failure). |
| H3 Campaign integrity (proof-or-stop) | 100% of iterations terminate in exactly one ledger record (proof XOR stop); after both probed kills + resume, the ledger identity multiset equals the protocol cross-product exactly (0 dup / 0 gap); the mid-iteration casualty resolves to a stop record or a clean re-run, never a silent half-record. | Any iteration with neither record, both records, a prose-only outcome, or a post-resume duplicate/gap. | (none — H3 is evaluable whenever the campaign ran) |
| H4 Scale envelope | At both scales: either the run stays within the frozen budget cap, or the breach is itself stop-recorded with reason `budget_cap`. End-of-run RSS and elapsed are recorded per iteration. | A cap breach WITHOUT a stop record (silent overrun). | Full-profile arm never started (operator abort before first iteration). |

## 5. Reuse Inventory (what exists; what is net-new)

Existing, reused as-is (NOT rebuilt):

- Generator/verifier + CLI: `memory_playbook_baseline_generate` /
  `memory_playbook_baseline_verify` with `profile`, `seed`, `outputDir`,
  `inputDir`, `keepGenerated` — already supports isolated copies, which the
  tamper arm requires. Two verified instrument facts the protocol must
  record: (a) **seed is content-inert** — `buildBaselineRows(profile)` takes
  no seed; seed is manifest metadata only, bound by manifestDigest; records
  and gold files are byte-identical across seeds; (b) the verifier emits a
  ~20-flag boolean vector plus `status`, and NO textual reason field —
  "reason" adjudication must therefore be fingerprint-based (section 6.1).
- Single-shot tamper smoke: `playbook-runtime-memory-baseline-smoke.ts`
  (gold tamper, corruptRows, recordCount overrides — including
  manifest-refreshed variants via `refreshManifest`). The tamper matrix
  EXTENDS this coverage; classes already covered are cited and re-asserted
  through the harness for ledger completeness (cheap), not re-engineered.
- Campaign patterns: identity-keyed resume + append-only ledger + offline
  analyzer (`experiments/recovery-runner/` run-driver/adjudicate/analyze;
  `experiments/experience-ablation/run-pilot.mjs`). The driver here is a
  deliberately smaller instance of the same shape.
- Statistical primitives are NOT needed: all four hypotheses are exact
  (all-or-nothing) properties; no sampling, no CIs, no power analysis.

Net-new (the actual work):

- the tamper-class MATRIX harness (`tamper.mjs`, systematic, isolated-copy,
  per-class verdict records against frozen fingerprints);
- the replay campaign driver + ledger (`run-batch.mjs`, N x 2-scale,
  resume-safe, lockfile-guarded);
- the interruption/resume probe (`resume-probe.mjs`, a committed producer —
  spawns the driver, kills it deterministically, restarts, emits the
  reconciliation);
- the offline verdict generator (`analyze-batch.mjs`, report computed from
  ledger files only, byte-reproducible);
- the documented /loop operator recipe (section 6.3).

## 6. Design

### 6.1 Geometry

Three arms plus one optional spot-check, all deterministic:

1. **Replay arm (H1, H4):** for each scale in {small, full}: N independent
   generate+verify cycles into fresh isolated directories. N is a BUDGET
   decision, not a statistical one (H1 is exact; any N >= 2 detects drift):
   proposed N=30 small (~3 min at the measured ~6 s/verify — long enough to
   exercise the ledger and resume machinery at realistic length) and N=3
   full (each full cycle materializes 1M records; its cost is measured once
   in M0 and the final N frozen there). The asymmetry is deliberate and
   recorded in protocol.json. Seed is recorded as a constant in
   protocol.json with an explicit `contentInert: true` annotation.
2. **Tamper arm (H2):** the matrix is structured on TWO EXPLICIT AXES:
   (mutation class) x (manifest handling: raw | refreshed). Raw mutations
   exercise the digest mechanism; manifest-REFRESHED (self-consistent)
   mutations exercise the contract/gold checks behind it and are where the
   informative coverage lives (the smoke already proves several refreshed
   cases; the matrix extends, citing overlaps). Initial class list, frozen
   in M0 after a per-class VIABILITY CHECK (each mutation must demonstrably
   produce a byte or contract difference — the rev-1 seed-swap class failed
   exactly this check and was dropped): records.jsonl byte-flip / row drop /
   row duplicate / row reorder / field rename / truncation (each raw, plus
   selected refreshed variants); gold-queries.json edit (raw + refreshed);
   manifest.json recordCount edit / profile edit / digest edit (raw only —
   refreshing a manifest edit is definitionally a different corpus);
   cross-PROFILE swap (small records under a full manifest). For each
   frozen class, M0 also freezes its EXPECTED FINGERPRINT over an EXPLICIT
   DOMAIN — the fingerprint is NOT the whole verify result, only these
   frozen fields: (a) the exact boolean verify-flag vector (each flag named,
   required-false or required-true) AND (b) a declared set of numeric-metric
   predicates over the gold metrics (e.g. `expectedIdsFoundRate == 1.0` vs
   `< 1.0`), because some classes fail only in a rate, not a boolean flag;
   fields outside this frozen domain do not participate in the match.
   "Truthful reason" is thereby operationalized: the observed values over the
   frozen domain must match the frozen fingerprint. If a class's fingerprint
   cannot be predicted at M0 time, deciding it (by running the mutation once
   and reviewing the result) is an M0 deliverable — never a mid-M1 discovery.

   VIABILITY IS TWO-PRONGED, and this is what keeps H2 falsifiable rather
   than vacuous. A class enters the H2 FAIL-CLOSED set only if its frozen
   fingerprint carries a genuine failure signal — at least one required-false
   flag OR a failing numeric predicate. A (class x manifestHandling)
   combination whose self-consistent variant is legitimately verify-ACCEPTED
   (all flags true, all metrics at gold — e.g. a row-reorder re-manifested
   into an equivalent corpus) is NOT a tamper failure and must NOT be
   enumerated as an H2 class: enumerating it would mechanically falsify H2
   exactly as the rev-1 seed-swap no-op would have. Such a combination is
   instead DISPOSITIONED at M0 as an ACCEPTED-BEHAVIOR / false-positive-guard
   observation — recorded with its own frozen `status: pass` fingerprint in a
   separate acceptance bucket (evidence that the instrument does not
   false-positive on a benign refresh) and explicitly EXCLUDED from H2's
   fail-closed accounting. The M0 viability check thus both DROPS no-op
   classes (no byte/contract difference at all) and RECLASSIFIES accept-only
   classes (a real difference that verify legitimately accepts) out of the
   fail-closed set — the disposition of every candidate is recorded, never
   left implicit.
3. **Resume probe (H3):** `resume-probe.mjs` spawns the replay arm, kills it
   deterministically twice — (a) at a frozen iteration boundary, (b)
   mid-iteration via a driver-supported crash hook (`--crash-after=<step>`:
   after workspace write, before ledger append) — restarts, and reconciles:
   the ledger identity multiset must equal the protocol cross-product
   exactly; the mid-iteration casualty must resolve to a stop record or a
   clean re-run, never a silent half-record. A wall-clock (uncontrolled)
   kill may be run as a secondary trial; the deterministic hook is the
   scored one. The driver takes a lockfile so a concurrent second driver
   records `precondition_failed` instead of corrupting the ledger.
4. **Optional second-environment spot-check (claim-scope extension only):**
   one replay cycle per scale on a second node version or machine. Not part
   of the primary claim; if run, extends section 3's environment scope to
   the two recorded environments.

Iteration identity is frozen in protocol.json as:
`iterationId := <arm>/<scale>/<index>` for replay (index 1..N) and
`tamper/<scale>/<class>/<manifestHandling>` for the tamper arm. The
expected identity set is the protocol cross-product; dup/gap is a multiset
comparison against it.

### 6.2 Proof-or-stop iteration contract

Every iteration ends in exactly one of:

- **proof record** (JSONL, identity-keyed): {iterationId, arm, scale,
  tamperClass?, manifestHandling?, verifyStatus, verifyFlags (the FULL
  boolean flag vector, copied verbatim), digests {records, gold, manifest}
  (copied from the generate result / the run's manifest.json — the verifier
  reports stability booleans, not digest values, so the driver sources
  digests from the generation side), goldMetrics, elapsedMs, endOfRunRss
  (named honestly: the instrument reports `process.memoryUsage().rss` at
  end of verify, not a true peak), env {nodeVersion, platform,
  instrumentCommit}, recordDigest};
- **stop record**: {iterationId, stopReason (machine-enum: budget_cap /
  verify_crash / precondition_failed / operator_abort), rawError?, env,
  recordDigest}.

`recordDigest` = sha256 of the record's canonical JSON with the
recordDigest field absent (preimage frozen in protocol.json). The analyzer
re-derives it per record and refuses on mismatch — this detects ACCIDENTAL
corruption and naive edits only (see section 3's ledger-integrity
disclaimer; signing is Tier-C, out of scope).

Prose is never an outcome. The driver exits nonzero if any iteration ends
without a record (that exit is itself H3 evidence).

### 6.3 Driver vs babysitter (the /loop clarification)

The DRIVER is a committed script (`run-batch.mjs`): anyone can reproduce
the campaign with one node command; the evidence must not depend on any
interactive session. Claude's `/loop` is the optional OPERATOR BABYSITTER:
it re-invokes the driver, watches for stop records, and reports — but its
narration carries zero evidentiary weight; the ledger is the only source of
truth. The babysitter must never launch a second driver while one runs (the
lockfile enforces this mechanically). This separation is itself part of the
point being demonstrated.

### 6.4 Verdict

`analyze-batch.mjs` reads ONLY the ledger + per-run artifacts, evaluates
H1-H4 mechanically (H1: pairwise digest equality across replay proof
records per scale; H2: per-class fingerprint match against protocol.json;
H3: identity-multiset reconciliation; H4: cap-vs-stop accounting), and
emits report.json + report.md with a content digest. Re-running the
analyzer on the same ledger must reproduce the same digest. Per-record
digest verification runs first; any mismatch aborts the verdict with a
named record id.

### 6.5 Cross-vendor roles (Codex): red-team, audit, replication — never outcome-judging

The OUTCOME judge is deterministic code (`analyze-batch.mjs`); no model —
Claude or Codex — ever judges a hypothesis. Cross-vendor involvement is
mandatory exactly where a MIND does the work, because a single model family
shares blind spots (repo precedent: Codex host-2 found the B-337f forgery
payloads, the B-7de9 JSON-leak family, and lane-missed findings in B-36ba /
B-70e4 that Claude-only review did not):

1. **Red-team at M0 (tamper-class enumeration):** before the matrix is
   frozen, Codex independently proposes tamper classes (especially
   manifest-refreshed self-consistent ones) and reviews the per-class
   fingerprints. The frozen matrix records which classes each vendor
   proposed. H2's ceiling is the enumeration's imagination; the matrix must
   reflect the union of two vendors' imaginations, not one.
2. **Standard genuine 2-host story review:** every implementation story
   (M0-M4) carries the repo-standard Codex host-2 adversarial review of the
   harness/driver/analyzer code.
3. **Cross-host replication at M4:** Codex independently re-runs
   `analyze-batch.mjs` against the committed ledger and must reproduce the
   report digest (guards against a shared driver/analyzer bug from a
   single author; the Tier-C pinned-manifest discipline, not self-report).
4. **M5 scoring (if run):** the babysitter narrator and the claim
   extractor must be DIFFERENT vendors (e.g. Claude narrates, Codex
   extracts claims, deterministic code matches claims against the ledger).

Independence ceiling, disclosed: cross-vendor is NOT full independence —
both CLIs run under the same operator on the same machine
(cross-vendor-same-operator, per the Tier-C threat model).

## 7. Evidence Artifacts

All under `experiments/pos-instrument-replay/` (new directory; committed
generators per repo policy — every number in the report has a committed
producer):

| Artifact | Producer | Content |
|---|---|---|
| protocol.json (+hash) | M0 | frozen N per scale, content-inert seed constant, tamper-class matrix split into a FAIL-CLOSED set (each class with its per-class expected fingerprint over the explicit domain: boolean flag vector + numeric-metric predicates) and an ACCEPTANCE bucket (self-consistent verify-accepted combinations with `status: pass` fingerprints), iterationId rule + cross-product, recordDigest preimage rule, budget caps, stop-reason enum, env pins {nodeVersion, platform, instrumentCommit} |
| tamper-verdicts.jsonl | M1 `tamper.mjs` | one verdict record per (class x manifestHandling), full flag vector + gold metrics + fingerprint-match boolean + disposition (fail-closed \| accepted-behavior) |
| batch-ledger.jsonl | M2 `run-batch.mjs` | append-only proof/stop records per section 6.2 |
| resume-reconciliation.json | M3 `resume-probe.mjs` | pre/post-kill ledger diff, identity-multiset comparison, dup/gap counts (must be 0/0), casualty disposition |
| report.json / report.md (+digest) | M4 `analyze-batch.mjs` | three-state H1-H4 verdicts, scale envelope (elapsed / endOfRunRss), no-overclaim text |
| selfchecks (one per .mjs) | each milestone | hermetic, mkdtemp-isolated, run by `node <file>`; the M2 selfcheck exercises the budget_cap stop path with an injected sub-second cap; the M3 selfcheck exercises the crash hook |

## 8. Milestones

**5 core milestones + 1 optional.** Sized deliberately small: this is a
deterministic-CLI campaign — no live LLM runs, no sample-size machinery, no
multi-day schedule. Each milestone is one Lattice story.

| # | Milestone | Delivers | Exit criterion |
|---|---|---|---|
| M0 | Protocol freeze + reuse audit + viability check + cost calibration | protocol.json (+hash) per section 7, including the per-class fingerprint table; documented map of which classes the existing smoke already covers; per-class TWO-PRONGED VIABILITY verification (each fail-closed class demonstrably changes bytes or contract AND carries a failure signal; no-op classes dropped, accept-only classes reclassified into the acceptance bucket); ONE measured full-profile generate+verify to set the budget cap and full-N. | Protocol hash frozen; every candidate class dispositioned (fail-closed \| accepted \| dropped) and every fail-closed class fingerprinted; full-profile cost recorded; env pins recorded. |
| M1 | Tamper-class matrix harness | `tamper.mjs` + selfcheck; isolated-copy mutation per (class x manifestHandling); verdict records with full flag vectors + gold metrics. | Every fail-closed-set class fails closed AND matches its frozen fingerprint, and every acceptance-bucket combination matches its `status: pass` fingerprint (H2 evidence complete); selfcheck hermetic. |
| M2 | Replay campaign driver + ledger | `run-batch.mjs` + selfcheck; N x 2-scale replays; append-only identity-keyed ledger; proof-or-stop contract + recordDigest + lockfile; injected-cap stop path selfchecked; /loop babysitter recipe documented. | Full campaign completes; H1/H4 evidence complete; driver exits nonzero on any recordless iteration. |
| M3 | Interrupt/resume idempotence probe | `resume-probe.mjs` + selfcheck; deterministic boundary + mid-iteration (crash-hook) kills; resume-reconciliation.json. | 0 duplicates, 0 gaps vs the protocol cross-product; casualty resolved to stop-or-rerun (H3 evidence complete). |
| M4 | Offline verdict + report | `analyze-batch.mjs` + selfcheck; three-state verdicts; report digest reproducible; per-record digest re-check refuses on mismatch; no-overclaim text embedded verbatim. | Verdict computed from ledger only; rerun reproduces the digest; claim text matches section 3 exactly. |
| M5 (optional, exploratory) | Babysitter transcript-vs-ledger scoring pilot | /loop babysitter session transcript scored AGAINST the ledger: every claim the narrating agent makes about campaign state checked for ledger support. | Exploratory only; n=1 anecdote; EXCLUDED from report.json and all claims; sole purpose = pilot the transcript-vs-ledger scoring method for the future rev-3 live phase; runs only on explicit operator opt-in. |

Dependency order: M0 → M1 → M2 → M3 → M4 (strict); M5 any time after M2.

## 9. Verification Matrix

| Case | Required result |
|---|---|
| Same profile rerun (same env) | Byte-identical digests, identical gold metrics. |
| Any fail-closed-set tamper class | `status: fail` AND observed fingerprint-domain values (flags + numeric predicates) match the frozen fingerprint. |
| Tamper with perfect surface score | Still fail-closed (the 2026-07-05 demo case, systematized). |
| Manifest-refreshed tamper that still breaks a contract/gold check | `status: fail`; verdict matches its frozen fingerprint (contract/gold flags, not digest flags). |
| Manifest-refreshed variant that is self-consistent and verify-ACCEPTED (e.g. row reorder) | Dispositioned at M0 as ACCEPTED-BEHAVIOR (frozen `status: pass` fingerprint), recorded in the acceptance bucket, EXCLUDED from H2's fail-closed set — not a falsifier. |
| No-op candidate class at M0 | Viability check rejects it BEFORE freeze (never a mid-campaign matrix edit). |
| Iteration crash | Stop record with machine-readable reason; driver nonzero exit if recordless. |
| Kill at boundary + mid-iteration, resume | Identity multiset equals protocol cross-product; 0 dup / 0 gap; casualty disposition recorded. |
| Concurrent second driver | `precondition_failed` stop via lockfile; ledger uncorrupted. |
| Budget cap hit | Recorded `budget_cap` stop, not a silent skip (path selfchecked via injected sub-second cap). |
| Analyzer rerun on same ledger | Same report digest. |
| Analyzer on corrupted/naively-edited ledger | Refuses with named record id (per-record digest mismatch). Adversarial re-digest edits: out of scope (disclosed, Tier-C). |

## 10. No-Overclaim Rule

Allowed if all four hypotheses are SUPPORTED: the section 3 "May claim"
text, verbatim, environment scope included.

Disallowed: "the evidence chain is tamper-proof"; "Proofbound evidence
cannot be forged"; "the ledger is tamper-evident against adversaries";
"this validates the memory system"; any sentence attributing
agent-behavioral meaning to a deterministic-instrument result; any M5
number appearing in a claim.

If any hypothesis is falsified or not-evaluable, the report states it
plainly with the machine-readable reason; a genuine instrument defect found
by H2 is a higher-value outcome than a clean pass.

## 11. Cost & Schedule

- Token cost: ~zero for M0-M4 (deterministic CLI; agent time is authoring
  only). M5 is the only token-consuming arm and is optional.
- Compute: small profile ~6s/verify (measured 2026-07-05); full profile
  measured once in M0 before freezing its N (budget-capped in protocol).
- Schedule: no shared-fleet contention (unlike rev-3's harvest campaign);
  can run entirely on one machine in hours.

## 12. Definition Of Done

- protocol.json frozen (hash recorded) BEFORE any scored run, with every
  candidate class two-pronged-viability-checked (no-op dropped, accept-only
  reclassified into the acceptance bucket) and every fail-closed class
  fingerprinted over its explicit domain at freeze time;
- all four hypothesis verdicts computed by the committed analyzer from the
  committed ledger, three-state, report digest reproducible;
- every artifact in section 7 committed with its named producer;
- no-overclaim text embedded in the report verbatim;
- final summary states per-hypothesis: supported / falsified /
  not-evaluable (with reason), and lists any instrument defect found.
