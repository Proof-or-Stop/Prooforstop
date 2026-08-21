# Follow-up story specs from B-3f3d

Ten framework defects found while building B-3f3d, grouped into four proposed
stories. None are specific to B-3f3d; all reproduce on any story that hits the
same shape.

Grouped by root cause, not by discovery order — several findings share one fix.

Pre-existing `BUG-001`..`BUG-004` and `BUG-F107-INCOMPLETE` (already carried to
story B-8af0) are excluded; these ten were logged during this session.

---

## Story A — Unblock critic receipts (highest priority)

**Why first:** these two stack into a hard deadlock. Until both are resolved, no
correctly-sandboxed critic can sign any receipt, so no story that needs a
topology-critic terminal state can reach DONE.

### `BUG-CRITIC-DISPATCH-PROVENANCE-UNSATISFIABLE` — the live blocker

`deriveRoleProvenance` (topology-critic-receipt.ts:139-158) requires a `dispatch`
process-event whose `sessionId` equals the signing session's own id. But
`dispatch` is not in the critic's `allowedCommandIds`
(prompt-role-contract-registry.ts:300), so the critic cannot record it, and an
orchestrator-issued dispatch records the *orchestrator's* session id.

Verified live: two independently dispatched critic sessions failed on **both**
verdicts, while `review_run_start` from the same sessions succeeded.

Three candidate designs — this is a decision, not a mechanical fix, because it
changes who is able to sign:
1. host injects dispatch provenance into the spawned subagent session
2. `dispatch` becomes recordable by the critic role
3. the binding keys on something a sandboxed critic can actually present

Whichever is chosen must preserve the property that an implementer cannot sign a
critic receipt for their own work. That property is currently *working* — my own
session was correctly refused when I tried to test the fix myself.

### `BUG-TOPOLOGY-CRITIC-RECEIPT-UNREACHABLE` — already fixed, needs tests

Fixed in `9f9f53a514`. Ships with **no test coverage** (this is also finding
F-115's complaint about a sibling change). Story A should add:
- a critic can record `request_changes` over a stale basis
- a critic still cannot record `pass` over a stale basis
- both assertions must bite under mutation

---

## Story B — Stop the status surface reporting false green

**Why grouped:** four defects, one shape. The status output reads green while the
underlying assurance is absent. I personally misread three of these as good news
during this session, which is the strongest evidence they are misleading rather
than merely imprecise.

| bug | false signal |
|---|---|
| `BUG-STATUS-STALE-LANE` | cross-epoch backfill renders a previous wave's terminal as if current; five "pass" rows displayed beside a `LANES_INCOMPLETE` blocker |
| `BUG-VERIFIED-COUNT-MISREADS-AS-CLEAN` | `Verified findings: 0` whenever nothing is dispositioned yet — indistinguishable from "nothing found". Printed 0 while three lanes showed `finding` |
| `BUG-CHECKLIST-DONE-IGNORES-USERSEES` | `6/6 done` while three items never delivered their declared output |
| `BUG-PREREVIEW-STALE-REPORTED-AS-TAMPERED` | staleness surfaced under the literal code `PR_ARTIFACT_TAMPERED`, which reads as a security event and misdirects remediation |

Acceptance criterion for the story: each of the four must distinguish
"assurance absent" from "assurance present and clean" in its rendered output.

Note on the last row: a critic pushed back on my framing, correctly. The trigger
is a recomputed-digest mismatch, consistent with staleness — but "tampered" is
the literal code name and should not be minimised to cosmetic staleness without
the artifact author demonstrating it. Treat as needs-investigation, not
confirmed-benign.

---

## Story C — Make `userSees` a real contract, or stop calling it one

### `BUG-USERSEES-NEVER-MECHANICALLY-CHECKED`

Three checklist items (CHK-003/004/005) each declared `userSees` output no code
produces. All three were marked done and passed DEV→REVIEW. Each was caught only
by a reviewer hand-grepping one call site, spread across three separate waves:

    wave 1: 0 found   wave 2: 2 found   wave 3: 1 found

That curve has no terminating condition, because nothing compares a declared
literal against emitted output. The field carries a delivery contract's weight
with none of its enforcement.

Concrete instances (all verified):
- **F-120** / CHK-003: promises `"Wave: n/max"`; code emits `Current wave: n/max`
  (review-inventory.ts:258). Promises lane states `pending|complete|blocked`; the
  type is `'pass' | 'finding'` (types.ts:1670) — `complete`/`blocked` are unreachable.
- **F-119** / CHK-004: promised literals have zero grep hits in `packages/main/src`.
- **F-118** / CHK-005: promises five labelled lines; code emits
  `console.log(JSON.stringify(...))` (review-inventory-epoch-smoke.ts:782) and
  throws an uncaught AssertionError instead of printing `FAIL`.

Two acceptable outcomes: mechanically check declared literals against emitted
output, or stop presenting `userSees` as a contract. Either is fine; the current
middle ground is not.

---

## Story D — Parallel reviewer throughput

### `BUG-EPOCH-LOCK-SERIALIZES-PARALLEL-LANES`

All epoch writes serialize on one per-story lock
(`.lattice/locks/review-inventory/<story>-epochs.lock`), while the documented
workflow recommends dispatching lanes in parallel. Measured this session: quality
waited ~7min, test-coverage ~6min, docs ~7min, concept ~383s (it had to move the
call to a background process to survive the foreground timeout).

Worse, in wave 2 the docs lane was starved through 45+ consecutive failed
attempts (RR-482..RR-533), nearly losing ~40 minutes of completed review work, and
burning 50 run ids. The competing writer was my own status polling; the lock
cleared the instant I stopped. Lane-vs-lane contention is independent of that and
persists.

The recommended workflow degrades exactly as it scales. Candidate directions:
finer-grained locking (per-lane rows), a fair queue, or internal retry in
`review_pass_set` rather than surfacing a lock timeout to the caller.

### `BUG-CRITIC-FINDINGS-INVISIBLE` (include here or in Story A)

`evaluateReviewInventoryWave` (review-inventory-epoch.ts:361) aggregates
`rawFindings` only over `epoch.requiredLanes`. The topology-critic lane is
filtered out of `ACTIVE_MODULAR_REVIEWER_ROLE_IDS`
(prompt-role-contract-registry.ts:28-29 — deliberate, but with no explanatory
comment), so it is never in `requiredLanes`.

Effect is bidirectional: critic findings can neither block saturation (assurance
hole) nor be dispositioned (they accumulate forever). F-089, F-113 and F-117 are
stuck open for exactly this reason.

---

## Small, unblocked

### `BUG-REPLAY-ACCEPTANCE-SYMBOL-MISSING`

`runReplayAcceptance` has zero grep hits, so `acceptance_topology_check` reports
`PR_PLANNED_PATH_UNRESOLVED` for CHK-005's declared path. **The behaviour is fully
implemented** as module-local `replay()` (review-inventory-epoch-smoke.ts:497,
called twice at 639-640 for a determinism check). Fix is to export it under the
declared name, or amend the declaration to the real symbol — not to write new
logic. I initially reported this as "declared but unimplemented"; that overstated
it by an order of magnitude.

---

## Suggested order

1. **Story A** — nothing else can reach DONE until receipts can be signed
2. **Story C** — the discovery curve won't converge without it
3. **Story B** — highest risk of a future agent shipping on a false green
4. **Story D** — throughput and the stuck-findings channel
5. the small one, any time

Story B deserves a note beyond its priority: B-3f3d exists to prevent manufactured
saturation signals, and its own status layer repeatedly produced them. The defect
class it was built to stop reappeared inside the tool built to stop it.
