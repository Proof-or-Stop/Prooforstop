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

**Threshold-confirm rule (NOT majority).** A finding is **CONFIRMED** iff the
number of confirming skeptics meets a fixed **confirm-threshold T** (`confirms ≥
T`). The recommended default is **T=1 of M=2** — *threshold-confirm, default
1-of-2*. This is deliberately **not** a majority vote: with M=2 a majority would
require 2 confirmations, but a single skeptic who **concretely confirms the
defect against the code** is sufficient to keep the finding, because the burden
is to *prove* the defect and one proof suffices (the other skeptic's
non-confirmation under refute-by-default carries no disproving weight). T is
**tunable**, and the tradeoff is explicit:

- **T = 1 of 2 (recommended default):** maximizes recall — a real defect one
  skeptic spots survives even if the other missed it. Cost: a wrong-but-
  convincing finding that fools one skeptic gets through to the fix queue. Net
  bias toward **safety** (fix the questionable one).
- **T = 2 of 2 (strict, = unanimous at M=2):** maximizes precision — both must
  confirm. Cost: a real defect only one skeptic could see is dropped. Net bias
  toward **low noise.**

Use T=1-of-2 by default (review optimizes for not-missing-defects); raise to
T=2-of-2 only when fix-churn from false positives is the dominant cost. A finding
that **no** skeptic confirms (all `isReal=false`, i.e. `confirms = 0 < T`) is
**dropped** — it never counts against convergence.

### 2.4 COMPLETENESS CRITIC contract (frozen)

The critic is a distinguished lens with a different input and a different
question. It runs at **one fixed point in the canonical order** (§3.2): **after**
the lens raw findings have been adversarially verified, so its `confirmedFindings`
input is the verified set, never the raw set.

```
CompletenessCritic {
  input:  { change, confirmedFindings },   // the diff + the CONFIRMED lens findings (post §2.3)
  job:    "what did the review MISS?",
  output: Finding[]                          // new raw findings → go through §2.3 too
}
```

**Canonical order (frozen — §2.4, §3.2, §4.2 all agree).**
`run lenses → adversarially verify the lens raw findings (§2.3) → pass the
CONFIRMED lens findings + the change to the critic → adversarially verify the
critic's raw findings (§2.3, same rule) → converge or reopen (§3).` The critic
is **never** run on un-verified raw findings, and its own output is **never**
privileged — it re-enters §2.3.

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
round:                                              # canonical order — matches §2.4 and §4.2
  run all lenses (independent)                  ─┐
  collect lens RAW findings                      │
  adversarially verify lens raw findings (§2.3)  │   → CONFIRMED lens findings (refuted dropped)
  run completeness critic on                     │
      { change, CONFIRMED lens findings }        │   → critic RAW findings
  adversarially verify critic raw findings (§2.3)│   → CONFIRMED critic findings (refuted dropped)
  if no CONFIRMED finding remains (lens+critic): │
      round is CLEAN  → converged ───────────────┘
  else:
      fix each CONFIRMED finding
      REOPEN: a new round on the fixed change
```

The critic always runs **after** lens-finding verification (so it sees the
verified set, never raw noise) and its findings are verified the **same** way
before they count. This single order is frozen and identical in §2.4 and §4.2.

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

- **REVIEW lanes (`review_run_start --lane` enum, verified against
  `command-catalog.ts`)** — exactly six: `lattice-review-concept`,
  `lattice-review-quality`, `lattice-review-test-coverage`,
  `lattice-review-behavior`, `lattice-review-docs`, `lattice-review-channel`.
  Lenses **map onto these six** (mapping in §4.2). These are the only lanes a
  `review_run_start` call accepts.
- **Other-phase reviewer artifacts (NOT `review_run_start` lanes).**
  `lattice-review-scope-plan` is the **PLAN** scope reviewer (writes
  `scope-check.json` via `scope_check_save`); `lattice-review-delivery` is the
  **TEST/DONE** delivery reviewer (writes `delivery-check.json` via
  `delivery_check_set`). They are separate phase artifacts and are **not** part
  of the REVIEW-round lens set. A dedicated completeness lane does **not** exist
  today (FUTURE, §4.4).
- **`review_run_start`** → obtains a `reviewRunId` for the current REVIEW round
  and reviewer lane (one of the six).
- **`finding_add`** → records a finding bound to the current `reviewRunId`
  (schema mapping in §4.2: `severity ∈ critical|high|medium|low`, `desc`,
  `category ∈ happy|edge|adversarial|missing|…`, optional `files[]`, `agent`).
- **`review_pass_set`** → records a lane's no-finding / no-blocker PASS
  conclusion (a pass-only `finding_add` is misuse).
- **full-3×2 escalation** — defined abstractly below.

**full-3×2 escalation (abstract definition).** The strong-proof escalation tier
is **3 distinct review rounds × 2 INDEPENDENT PASS hosts**: each round, two
independent hosts each review and PASS, with **every verdict bound to the current
`materialDigest`** and carrying a **distinct `hostId` / `sessionId` / `keyId`**
(independence is established by these distinct identities + bindings — **provider
names are diagnostic, not the proof of independence**). Each host PASS is
submitted via **`autopilot_review_submit`**. *In THIS program* the two concrete
hosts are **claude-code** and **codex**, but that pairing is only this program's
example; any two hosts with distinct host/session/key identities satisfy the
contract. This mode is a **review MODE / escalation TIER** that *feeds* the 3×2
ledger (the lenses + verifier + critic produce the per-round, per-host review
work the ledger records).

### 4.2 How lenses → lanes → findings (canonical order + ledger mapping)

**Lens → lane mapping (the six real REVIEW lanes).**

| Canonical LENS (§2.1) | REVIEW lane (`review_run_start --lane`) |
|---|---|
| concept / scope | `lattice-review-concept` |
| code-quality | `lattice-review-quality` |
| behavior / correctness | `lattice-review-behavior` |
| test-coverage | `lattice-review-test-coverage` |
| crash-safety / edge | `lattice-review-behavior` (or `lattice-review-quality`) |
| docs-consistency | `lattice-review-docs` |

(`lattice-review-channel` carries channel-integrity review when relevant. The
completeness critic has **no dedicated lane today** — its MVP provenance is in
§4.3; a `lattice-review-completeness` lane is FUTURE, §4.4.)

**Canonical order (matches §2.4 / §3.2 exactly):**

```
per lane: review_run_start --lane <lane>      → reviewRunId
run lens (facet)                              → raw Finding[]
adversarial verify lens raw findings (§2.3)   → CONFIRMED lens findings
  ↓
MAP each CONFIRMED finding to ledger fields (below) → finding_add(reviewRunId, agent)
  ↓
completeness critic on {change, CONFIRMED lens findings} → critic raw Finding[]
adversarial verify critic raw findings (§2.3) → CONFIRMED critic findings
  ↓ (any confirmed critic finding ⇒ REOPEN, §4.3)
MAP + finding_add the CONFIRMED critic findings too
  ↓
lane ends round with zero confirmed findings  → review_pass_set(reviewRunId)
```

A finding **refuted** by the skeptics is **never** `finding_add`-ed. Only
CONFIRMED findings reach the ledger.

**LEDGER MAPPING — methodology `Finding` (§2.2) → `finding_add` args (REQUIRED).**
A builder must **map before calling `finding_add`**; passing the abstract
severity `BLOCKER`/`MAJOR`/`MINOR` or the raw `{file,line,issue,fix}` fields
directly to `finding_add` is a **Zod error** (its enums are
`critical|high|medium|low` and its fields are `desc` + `files[]`).

| methodology `Finding` field | `finding_add` arg | mapping rule |
|---|---|---|
| `severity: BLOCKER` | `--severity critical` | BLOCKER → `critical` |
| `severity: MAJOR` | `--severity high` | MAJOR → `high` |
| `severity: MINOR` | `--severity medium` | MINOR → `medium` (use `low` for cosmetic) |
| `title` + `issue` + `fix` | `--desc` | compose: `"<title> — <issue> Fix: <fix>"` |
| `file` (+ `line`) | `--files '["<file>"]'` | array; cite `line` inside `desc` |
| (lens facet) | `--category` | choose `happy\|edge\|adversarial\|missing` (e.g. an unguarded door / missing consumer → `missing` or `adversarial`; a boundary/throw → `edge`) |
| (current run) | `--reviewRunId` | the lane's `reviewRunId` from `review_run_start` |
| (lens / critic identity) | `--agent` | a **real** `lattice-review-*` lane matching the bound `reviewRunId`'s lane; critic findings reuse a lane and carry `[completeness-critic]` in `--desc` (§4.3) — `--agent` is **never** a non-`lattice-review-` value |

So the order is **verify → MAP → `finding_add`**: the abstract severity lives in
the methodology layer; the ledger only ever sees `critical|high|medium|low`.

### 4.3 Critic provenance (MVP) + how a critic-REOPENED round binds the ledger

**MVP critic provenance — the critic has no dedicated lane today.** Reviewer
evidence only counts as REVIEW-lane evidence when the finding's **`agent` starts
with `lattice-review-`**: Lattice's reviewer-evidence logic gates on
`agent.startsWith('lattice-review-')` and validates the `reviewRunId ↔ lane`
binding (the finding's `agent` must equal the bound run's `lane`) — see
`packages/main/src/core/review-run.ts`. `review_run_start` itself rejects any
agent not starting with `lattice-review-`, and there is **no
`lattice-review-completeness`** lane today.

Therefore, in MVP, a CONFIRMED critic finding **must** be recorded with `--agent`
set to a **real existing review lane** — recommended **`lattice-review-quality`**
or **`lattice-review-behavior`** (whichever the finding most concerns) — and
bound to **that lane's current `reviewRunId`** (so the lane binding validates and
the finding counts as lane evidence). The completeness-critic **provenance is
carried in the `--desc`** (prefix it with **`[completeness-critic]`**) **and/or a
`signatureTag`** — **NOT** in the `--agent` field. Putting `completeness-critic`
in `--agent` would store the finding as non-reviewer/main provenance: it would
**not** count as lane evidence and the lane binding would not be validated.

A critic-driven **reopen is a normal `DEV → REVIEW` round** with re-bound evidence
(below). A dedicated **`lattice-review-completeness` lane** and a **structured
provenance field** (so the critic gets first-class, machine-readable provenance
instead of a `--desc` tag) stay **FUTURE** (§4.4).

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

Concretely: critic re-opens → fix lands (new digest) → all lenses + the two
independent hosts re-review on the fresh digest under new `reviewRunId`s. A
reopened round therefore *consumes* a full 3×2 row only when its PASSes are bound
to the post-fix digest.

### 4.4 MVP vs FUTURE

| Capability | Tier | Status |
|---|---|---|
| Documented, reusable **orchestration** over the six existing lanes (this spec as the runbook) | **MVP** | buildable now |
| Lens→lane mapping (§4.2) using `review_run_start` / `finding_add` / `review_pass_set` | **MVP** | existing primitives |
| **Ledger mapping** (BLOCKER/MAJOR/MINOR → critical/high/medium; `{file,line,issue,fix}` → `desc`+`files[]`; pick `category`) before `finding_add` | **MVP** | §4.2 table; prevents the Zod error |
| Adversarial verification (M skeptics, refute-by-default, **threshold-confirm default T=1-of-2 — not majority**) as a **prompt/role protocol** | **MVP** | no new storage; verdicts live in reasoning + which findings get `finding_add`-ed |
| Completeness critic as a **defined role** run each round (after lens verification) | **MVP** | role + prompt, drives reopen |
| Critic provenance via `finding_add` under a **real review lane** (`--agent lattice-review-quality`/`-behavior`, bound to that lane's `reviewRunId`), with `[completeness-critic]` in `--desc`/`signatureTag` — **not** in `--agent` | **MVP** | §4.3; no dedicated lane needed |
| Dedicated **`lattice-review-completeness` lane** + **structured provenance field** (first-class critic provenance) | **FUTURE** *(not-yet-implemented)* | — |
| Reopen → new `reviewRunId` + re-bind to fresh `materialHash`/`materialDigest` | **MVP** | existing freshness mechanics |
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
(round → {run lenses → verify lens findings → run critic → verify critic findings
→ converge-or-reopen}, the canonical order of §2.4/§3.2/§4.2). No behavior;
types + the mode interface only. Every later story imports this.
*Acceptance:* the schemas/interface compile and match §2/§3 exactly; no
downstream story needs a schema change. *Depends:* — .

**S1 — Lens runner (PARALLEL).** **MVP.**
Drive the canonical lens set as independent review agents over a change, each
mapped per the §4.2 table to one of the **six real REVIEW lanes**
(`lattice-review-concept` / `-quality` / `-test-coverage` / `-behavior` /
`-docs` / `-channel`), each returning PASS or raw `Finding[]`. Enforce
independence (no lens sees another's output). *Acceptance:* given a change,
produces per-lane raw findings via the S0 `Finding` schema; every emitted lane is
in the six-lane enum; lanes run without cross-contamination. *Depends:* [S0]
(imports `Finding`, lens set).

**S2 — Adversarial verifier (PARALLEL).** **MVP.**
Implement the M-skeptic, refute-by-default verification (§2.3): each raw finding
→ M `Verdict`s → **CONFIRMED by threshold-confirm, default T=1-of-2 (not a
majority)** → only CONFIRMED findings are **mapped (§4.2) then `finding_add`-ed**;
findings with `confirms < T` are dropped. *Acceptance:* a planted
wrong-but-plausible finding gets `confirms=0` and is never `finding_add`-ed; a
real defect with **one** concrete confirmation is CONFIRMED at T=1-of-2; the
mapping turns a `BLOCKER` into `--severity critical` (no abstract severity
reaches `finding_add`). *Depends:* [S0] (imports `Verdict`). Disjoint from S1.

**S3 — Completeness critic (role MVP; dedicated lane FUTURE).** **MVP role.**
Run the critic each round **after lens-finding verification** with input
`{change, CONFIRMED lens findings}`, emit new raw findings (which re-enter S2),
and signal **reopen** when any critic finding is CONFIRMED. MVP provenance (§4.3):
record CONFIRMED critic findings via `finding_add` under a **real review lane**
(`--agent lattice-review-quality` / `-behavior`, bound to that lane's
`reviewRunId`) with the completeness-critic provenance in `--desc`
(`[completeness-critic]` prefix) and/or `signatureTag` — **never** in `--agent`
(an `--agent` not starting with `lattice-review-` does not count as lane
evidence). *Optional/FUTURE* = a first-class `lattice-review-completeness` lane +
structured provenance/verdict storage. *Acceptance:* on a B-086b-style change (one guarded door, two
unguarded), the critic surfaces the unguarded doors, its findings pass S2, and it
triggers reopen; each critic finding is stored under a real `lattice-review-*`
lane (so it counts as lane evidence) with `[completeness-critic]` provenance in
`--desc`/`signatureTag`. *Depends:* [S0, S2] (critic findings go through the
verifier).

**S4 — Escalation-flow integration (SERIAL, last).** **MVP.**
Wire the round/reopen loop into the Lattice escalation ledger: per-round
`review_run_start` → mapped CONFIRMED `finding_add` → lane `review_pass_set`; on
reopen, new `reviewRunId` + re-bind to the fresh `materialHash`/`materialDigest`;
feed the **3×2 PASSes from two independent hosts** (each with distinct
`hostId`/`sessionId`/`keyId`; claude-code + codex in this program) via
`autopilot_review_submit` per §4.1/§4.3. *Acceptance:* a critic-reopened round
produces new run IDs bound to the post-fix digest; a clean round (§3.1) records
lane PASSes; no stale-digest PASS satisfies the gate. **Local-only — no Authority
receipt is claimed (§4.5).** *Depends:* [S1, S2, S3].

**MVP cut:** S0 + S1 + S2 + S4 (with S3 as the *role* form) is a runnable mode
today over existing lanes. The first-class CLI mode, the dedicated
completeness-critic lane, and structured verdict storage (§4.4 FUTURE rows) are
the optional follow-ons. The critical path is **S0 → slowest of {S1,S2,S3} →
S4** — the same contract-first shape the parallel-decomposition program proved.
