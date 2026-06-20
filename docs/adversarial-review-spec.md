# Adversarial Multi-Lens Review — Methodology Spec

**Status:** design spec (contract-first). Defines a Lattice review *mode* that
empirically out-performed single-pass review during the parallel-decomposition
gate program. Standalone-readable; every empirical claim below is grounded in
the merged story findings (`.lattice/story/actives/<id>/findings.json`,
verifiable via `git log main`).

This document is **not code**. It freezes the schemas (§2/§3) so an
implementation program (§5) can build the mode without re-design.

---

## §1 — Motivation + Empirical Evidence

### 1.1 The thesis

A single review pass — whether one host (e.g. one Codex run) or one dimensional
lane (e.g. only `lattice-review-quality`) — reliably catches **local** defects:
a null deref on this line, a wrong comparator in this function, a missing
try/catch in this read. It systematically **misses integration-level** defects:

- **unguarded doors** — a second/third code path that reaches the same
  dangerous sink, which the pass never enumerated;
- **missing consumers** — a producer/consumer edge the change *claims* but the
  runtime does not actually wire;
- **over-claims** — a registration, gate, or test that asserts coverage it does
  not have (the smoke that never reaches the crash site; the read-only command
  registered as a gate producer).

These are not "harder versions of local bugs." They are **gaps between what was
reviewed and what exists.** A single lens, however careful, reviews the surface
it was pointed at. The defect lives in the surface it was *not* pointed at. The
fix is structural, not effort: **independent lenses widen the reviewed surface,
and a dedicated completeness critic hunts specifically for the un-reviewed
surface.**

### 1.2 Concrete program evidence (verified against findings.json)

Three merged stories from the parallel-decomposition gate program. Attribution
below is exact per each finding's `agent` field — **attribution accuracy is a
MUST**; the discoveries are credited to the component that actually filed them.

**S4 — B-fa7c (merged, `b6ef51079`): the corrupt-contract crash.**
The new wave projection read every story's `scope-contract.json` for the first
time. `store.readScopeContract` returns `null` for a *missing* contract but
**re-throws** (`SyntaxError`) for a *corrupt/unparseable* one. `storyRef()`
handled only `null`, so a single corrupt contract anywhere crashed the entire
`parallel_wave_create` command.

- The **crash itself** (the unguarded `readScopeContract` in
  `lattice-parallel-wave.ts`) was filed by **`claude-quality`** — a *dimensional
  lens*, not the critic (B-fa7c F-002, MAJOR). A crash-safety/edge lens
  (**`codex`**, F-007/F-008) independently probed the same blast radius from the
  escape-hatch and end-to-end angles.
- Separately, the **completeness critic** (`claude-critic`, B-fa7c F-003, MAJOR)
  found the **test-coverage gap**: the adversarial smoke's "does not throw"
  assertions exercised the *pure helpers*, **not the real corrupt-peer crash
  site** in `storyRef` — false confidence. The critic did **not** discover the
  crash; it discovered that the test did not reach it.

The division of labor is the whole point: a dimensional lens found the live
crash; the critic found that the safety net had a hole.

**S5 — B-086b (merged, `2481cbbc4`): the bypassable hard gate.**
The parallel hard-block was wired into exactly one door. The
**completeness critic** (`claude-completeness-critic`) found two more:

- **Round 1** — the **express-channel bypass** (B-086b F-003, MAJOR): the block
  was enforced only on `PLAN→DEV` (`canStartDevGuard`). The `INIT_CHECK→DEV`
  express channel (`canSkipPlanGuard`) **never called** the gate, so a
  quick-skip story walked straight through.
- **Round 2** — the **rework-rollback door bypass** (B-086b F-006, BLOCKER):
  the `REVIEW→DEV` and `TEST→DEV` rollback transitions were *also* unguarded —
  two more `START→DEV` doors reaching DEV without the gate.

The dimensional lenses and single-pass **Codex missed both door bypasses.**
Codex's findings were genuinely valuable but **local**: a light-profile early
return (F-001, BLOCKER) and a non-equivalent count-coercion refactor (F-002,
MAJOR). Codex **passed round 2** outright; the critic re-opened it. Single-pass
review confirmed the door it was looking at was sound — and was right about that
door, and blind to the others.

**B-b29e (merged, `3556165c2`): the over-claimed gate producer.**
The completeness critic (`claude-completeness-critic`, B-b29e F-001, MAJOR)
found that `scope_contract_check` — a **pure read** (`readScopeContract` +
`buildScopeDiffPack`, **zero writes**) — had been registered as a
parallel-decomposition gate **producer**, asserting a producer→gate edge the
runtime does not have. An over-claim of coverage, caught by the lens that asks
"does this registration match reality?"

### 1.3 Honest framing

Single-pass review is **not useless.** In every case above it caught real,
shippable-blocking local defects (B-fa7c F-001 mode='off' edge cases; B-086b
F-001/F-002 the light-profile bypass and the count-coercion regression). The
value of this methodology is **not** "the critic is smarter." It is:

1. a **wider defect surface** from several independent lenses, each pointed at a
   different facet, so fewer surfaces go un-reviewed; and
2. a **completeness critic** whose sole job is to hunt the integration gaps —
   the doors, consumers, and claims that per-facet review structurally misses.

Neither replaces the other. The lenses find depth; the critic finds *what was
not looked at.*

---

## §2 — The Methodology (mechanics + data shapes)

### 2.1 LENS

A **lens** is an independent review agent that reviews **one facet** of a change
and returns structured findings. A lens sees the diff + relevant source; it does
**not** see the other lenses' outputs (independence is load-bearing — shared
context collapses the surface back to one pass).

**Canonical lens set** (task-tunable — drop/add per change):

| Lens | Facet | Asks |
|---|---|---|
| `concept/scope` | intent ↔ implementation | does the code do what the story claims, within scope? |
| `code-quality` | correctness of *this* code | null/throw/type/comparator/refactor-equivalence |
| `behavior/correctness` | runtime semantics | does the changed path behave per contract on real inputs? |
| `test-coverage` | does the test reach the risk? | do assertions exercise the actual sink, not a proxy? |
| `crash-safety/edge` | failure modes | corrupt input, missing file, boundary, fail-open vs fail-closed |
| `docs-consistency` | claims ↔ reality | registries/metadata/docs match the runtime |

The set is **tunable**: a pure-docs change may run only `concept` +
`docs-consistency`; a concurrency change adds a dedicated race lens. The
**completeness critic (§2.4) is always present** — it is what makes the mode
adversarial-*complete*, not just multi-lens.

### 2.2 FINDING schema (frozen)

```
Finding {
  severity: "BLOCKER" | "MAJOR" | "MINOR",
  title:    string,   // one-line summary
  file:     string,   // path
  line:     number,   // anchor (best-effort; symbols are more stable)
  issue:    string,   // what is wrong + why it matters
  fix:      string    // concrete remediation
}
```

A lens returns **PASS** (zero findings) or one-or-more `Finding`s. A `Finding`
at this stage is **raw / unverified** — it is a *claim*, not yet a defect.

### 2.3 VERDICT schema + per-finding adversarial verification (frozen)

Each raw finding is independently judged by **M skeptics** (recommend **M=2**).
A skeptic returns:

```
Verdict {
  isReal:         boolean,
  agreedSeverity: "BLOCKER" | "MAJOR" | "MINOR" | "NOT_A_DEFECT",
  reasoning:      string   // must cite the concrete code that confirms/refutes
}
```

**Refute-by-default rule.** A skeptic **defaults to `isReal=false`.** To flip to
`isReal=true` it must **concretely confirm the defect against the code** — quote
the line, trace the path, show the throw actually escapes. "Looks plausible" is a
**refute.** This is what filters the single largest failure mode of unsupervised
multi-agent review: confident-but-wrong findings.

**Confirmation threshold.** A finding is **CONFIRMED** iff at least a
**threshold** of the M skeptics confirm. With **M=2**, the recommended default is
**≥1 confirm** (a single concrete confirmation outranks a non-confirmation,
because the burden is to *prove* the defect, and one proof suffices). This is
**tunable**, and the tradeoff is explicit:

- **threshold = 1-of-2 (recommended default):** maximizes recall — a real defect
  one skeptic spots survives even if the other missed it. Cost: a wrong-but-
  convincing finding that fools one skeptic gets through to the fix queue. Net
  bias toward **safety** (fix the questionable one).
- **threshold = 2-of-2 (strict):** maximizes precision — both must confirm.
  Cost: a real defect only one skeptic could see is dropped. Net bias toward
  **low noise.**

Use 1-of-2 by default (review optimizes for not-missing-defects); raise to 2-of-2
only when fix-churn from false positives is the dominant cost. A
**`NOT_A_DEFECT`** verdict from all skeptics **drops** the finding (it never
counts against convergence).

### 2.4 COMPLETENESS CRITIC contract (frozen)

The critic is a distinguished lens with a different input and a different
question.

```
CompletenessCritic {
  input:  { change, confirmedFindings },   // the diff + everything CONFIRMED so far
  job:    "what did the review MISS?",
  output: Finding[]                          // new findings → go through §2.3 too
}
```

It hunts the integration surface the per-facet lenses structurally miss:

- **a 5th door** — another code path to the same sink (B-086b: the express
  channel and the two rollbacks);
- **an unverified claim** — a registration/test/gate asserting coverage it lacks
  (B-fa7c: the smoke that never reached the crash site; B-b29e: the read-only
  command registered as a producer);
- **a modality not run** — an input class, profile, or config (e.g. mode='off',
  `light` profile) the review never exercised;
- **an interaction** — two changes that are each fine but wrong together.

Critic output is **not privileged**: each critic finding is **itself raw** and
goes through §2.3 adversarial verification before it counts. A confirmed critic
finding **may REOPEN the round** (§3).

---

## §3 — Convergence + Loop Semantics

### 3.1 Convergence criterion

A review round is **CLEAN** iff **all three** hold:

1. **every lens returns PASS** (after its findings are resolved), **and**
2. **every surfaced finding is adversarially refuted-or-fixed** — i.e. each raw
   finding is either dropped by §2.3 (all-skeptic `NOT_A_DEFECT`) or CONFIRMED
   and then **fixed** (with the fix re-reviewed), **and**
3. **the completeness critic finds nothing new** (its output is empty, or every
   critic finding was refuted).

If any of the three fails, the round is **NOT** clean.

### 3.2 Loop-until-dry / reopen

```
round:
  run all lenses (independent)           ─┐
  collect raw findings                    │
  run completeness critic                 │  (sees confirmed findings)
  adversarially verify ALL raw findings   │  (§2.3, refute-by-default)
  if no CONFIRMED finding remains:        │
      round is CLEAN  → converged ────────┘
  else:
      fix each CONFIRMED finding
      REOPEN: a new round on the fixed change
```

A critic-found defect → **fix → re-review** is the central loop: the critic
forces a new round, the new round re-runs the lenses + critic on the *fixed*
material, and the process repeats **until a round is dry** (clean by §3.1). B-086b
is the canonical trace: round 1 critic found the express channel → fixed →
round 2 critic found the two rollback doors → fixed → a subsequent round was
clean. Single-pass would have stopped after round 1 (or after Codex's
round-2 PASS).

### 3.3 Harness independence

This is a Lattice **review MODE composed of agents**, **not** a dependency on any
specific harness orchestration tool. The lenses, skeptics, and critic are agent
roles; they can be driven by **sequential agent dispatch** (run lens A, then B,
… then the critic, then the skeptics) just as well as by parallel orchestration.
The contract is the *data flow* (§2 schemas + §3 loop), not a concurrency engine.

---

## §4 — Lattice Integration Contract + MVP vs Future

### 4.1 The existing substrate this composes over

The mode does **not** invent a new ledger. It composes existing Lattice review
primitives:

- **Review lanes** — `lattice-review-{concept,scope,quality,behavior,test,docs,
  channel,delivery}` are the existing dimensional lanes; lenses **map onto**
  these lanes.
- **`review_run_start`** → obtains a `reviewRunId` for the current REVIEW round
  and reviewer lane.
- **`finding_add`** → records a finding (categories `happy|edge|adversarial|
  missing`) bound to the current `reviewRunId`.
- **`review_pass_set`** → records a lane's no-finding / no-blocker PASS
  conclusion (a pass-only `finding_add` is misuse).
- **full-3×2 escalation** — defined inline below.

**full-3×2 escalation (definition).** The strong-proof escalation tier is **3
distinct review rounds × 2 independent PASS hosts**: the **claude-code** host and
the **codex** host each independently review and PASS, across **three** separate
rounds, with every PASS submitted via **`autopilot_review_submit`** and **bound
to the current `materialDigest`/`materialHash`** of the change. It is the
existing strong escalation; this mode is a **review MODE / escalation TIER** that
*feeds* it (the lenses + critic + verifier produce the per-round, per-host
review work that the 3×2 ledger records).

### 4.2 How lenses → lanes → findings, with verification before they count

```
lens (facet)            → maps to a lattice-review-<lane>
  ↓ raw Finding
adversarial verify (§2.3) → M skeptics, refute-by-default
  ↓ CONFIRMED only
finding_add (reviewRunId) ─ recorded against the lane's review run
  ↓
completeness critic       → new raw findings → re-enter §2.3
  ↓
lane PASS (no confirmed)  → review_pass_set (reviewRunId)
```

A raw finding that is **refuted** by the skeptics is **never** `finding_add`-ed
(it did not survive verification). Only CONFIRMED findings reach the ledger. A
lane that ends a round with zero confirmed findings calls `review_pass_set`.

### 4.3 How a critic-REOPENED round binds to the escalation ledger

A reopened round is a **new round**, and the program's known mechanics apply:

- **new round = new `reviewRunId`.** Each reviewer lane calls
  `review_run_start` again for the new round; findings/passes in the new round
  carry the new `reviewRunId`. Stale-round runs are not current-latest and do not
  satisfy the gate.
- **materialHash freshness.** A fix **changes the materialHash/materialDigest**
  of the change. Any review evidence bound to the *pre-fix* digest is stale;
  **re-binding is required** — the new round's runs and PASSes bind to the **new**
  digest. (This is the same freshness mechanic the program hit repeatedly: a
  fix re-stamps the material, so prior PASSes must be re-earned on the fresh
  head. `lattice validate` re-stamps; escalation verdicts re-bind to the new
  digest.)

Concretely: critic re-opens → fix lands (new digest) → all lenses + 2 hosts
re-review on the fresh digest under new `reviewRunId`s. A reopened round
therefore *consumes* a full 3×2 row only when its PASSes are bound to the
post-fix digest.

### 4.4 MVP vs FUTURE

| Capability | Tier | Status |
|---|---|---|
| Documented, reusable **orchestration** over existing lanes (this spec as the runbook) | **MVP** | buildable now |
| Lens→lane mapping using `review_run_start` / `finding_add` / `review_pass_set` | **MVP** | existing primitives |
| Adversarial verification (M=2 skeptics, refute-by-default) as a **prompt/role protocol** over findings | **MVP** | no new storage; verdicts live in reasoning + which findings get `finding_add`-ed |
| Completeness critic as a **defined role** run each round before convergence | **MVP** | role + prompt, drives reopen |
| Reopen → new `reviewRunId` + re-bind to fresh `materialHash` | **MVP** | existing freshness mechanics |
| First-class **CLI review mode** (`lattice review --mode=adversarial`) | **FUTURE** *(not-yet-implemented)* | — |
| Dedicated **completeness-critic lane** (`lattice-review-completeness`) | **FUTURE** *(not-yet-implemented)* | — |
| **Structured verdict storage** (persist `Verdict{isReal,agreedSeverity,reasoning}` per finding, not just confirmed-or-not) | **FUTURE** *(not-yet-implemented)* | — |

**MVP** is a *documented, reusable orchestration over the existing lanes + minimal
finding/verdict hooks* — runnable today with sequential agent dispatch and the
current CLI. **FUTURE** items are labeled **not-yet-implemented** and require new
code (§5 S1–S4).

### 4.5 HONESTY note — local verdicts, not Authority receipts

All verdicts produced by this mode — lens PASSes, skeptic confirmations, critic
conclusions, even a full local 3×2 — are **LOCAL host verdicts.** They are
**NOT** Authority Server receipts. Local-mode adversarial review **must not be
presented as production Authority completion**: no `receiptVerified`,
`authorityDone`, or `productionDone` claim follows from local review alone. An
Authority receipt requires an actual Authority Server submission verified by the
authority flow. This mode strengthens the *local* review surface; it does not
cross the authority boundary.

---

## §5 — Implementation Program (contract-first)

Mirrors the parallel-decomposition spec §8 shape: a frozen contract first, then
independent builds, then integration. **§2/§3's schemas are the FROZEN
contract** — `Finding`, `Verdict`, the lens set, the convergence criterion, and
the loop are fixed by this document, so the build proceeds **without
re-design.**

**S0 — Frozen contract (SERIAL, first).** **MVP.**
Codify, in a single source-of-truth module/types, the `Finding` schema (§2.2),
the `Verdict` schema (§2.3), the canonical lens set + "task-tunable" flag (§2.1),
the completeness-critic IO contract (§2.4), and the **review-mode interface**
(round → {run lenses, run critic, verify, converge-or-reopen}, §3). No behavior;
types + the mode interface only. Every later story imports this.
*Acceptance:* the schemas/interface compile and match §2/§3 exactly; no
downstream story needs a schema change. *Depends:* — .

**S1 — Lens runner (PARALLEL).** **MVP.**
Drive the canonical lens set as independent review agents over a change, each
mapped to its `lattice-review-<lane>`, each returning PASS or raw `Finding[]`.
Enforce independence (no lens sees another's output). *Acceptance:* given a
change, produces per-lane raw findings via the S0 `Finding` schema; lanes run
without cross-contamination. *Depends:* [S0] (imports `Finding`, lens set).

**S2 — Adversarial verifier (PARALLEL).** **MVP.**
Implement the M-skeptic, refute-by-default verification (§2.3): each raw finding
→ M `Verdict`s → CONFIRMED by threshold (default 1-of-2) → only CONFIRMED
findings flow to `finding_add`; `NOT_A_DEFECT`-by-all are dropped. *Acceptance:*
a planted wrong-but-plausible finding is refuted and never `finding_add`-ed; a
real defect with one concrete confirmation is CONFIRMED at threshold 1-of-2.
*Depends:* [S0] (imports `Verdict`). Disjoint from S1.

**S3 — Completeness-critic lane (PARALLEL → FUTURE-leaning).** **MVP role; lane
is FUTURE.**
Run the critic each round with input `{change, confirmedFindings}`, emit new raw
findings (which re-enter S2), and signal **reopen** when any critic finding is
CONFIRMED. MVP = a defined role + prompt driven by the runner. *Optional/FUTURE*
= a first-class `lattice-review-completeness` lane with structured storage.
*Acceptance:* on a B-086b-style change (one guarded door, two unguarded), the
critic surfaces the unguarded doors and triggers reopen. *Depends:* [S0, S2]
(critic findings go through the verifier).

**S4 — Escalation-flow integration (SERIAL, last).** **MVP.**
Wire the round/reopen loop into the Lattice escalation ledger: per-round
`review_run_start` → CONFIRMED `finding_add` → lane `review_pass_set`; on reopen,
new `reviewRunId` + re-bind to the fresh `materialHash`/`materialDigest`; feed
the 3×2 host PASSes (claude-code + codex) via `autopilot_review_submit` per §4.3.
*Acceptance:* a critic-reopened round produces new run IDs bound to the post-fix
digest; a clean round (§3.1) records lane PASSes; no stale-digest PASS satisfies
the gate. **Local-only — no Authority receipt is claimed (§4.5).** *Depends:*
[S1, S2, S3].

**MVP cut:** S0 + S1 + S2 + S4 (with S3 as the *role* form) is a runnable mode
today over existing lanes. The first-class CLI mode, the dedicated
completeness-critic lane, and structured verdict storage (§4.4 FUTURE rows) are
the optional follow-ons. The critical path is **S0 → slowest of {S1,S2,S3} →
S4** — the same contract-first shape the parallel-decomposition program proved.
