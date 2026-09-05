# B-3f3d — handoff

Story: *Freeze REVIEW candidates and require bounded multi-lane finding saturation before remediation DEV*
Phase: REVIEW. Branch `story/B-3f3d`, 355 commits. 11 open bugs, 10 open findings.

Everything below was verified against source in this session. Where I originally
got something wrong and later corrected it, the correction is marked — those are
the parts most worth not re-deriving.

---

## Why the story is not DONE

Two independent deadlocks. The first is fixed; the second is a design decision I
deliberately did not make alone.

### 1. Basis-verification deadlock — FIXED (`9f9f53a514`)

`currentTopologyReceiptStateForContext` (proofstory.ts) threw unconditionally when
`basisVerification.ok` was false, *before* either verdict branch. That closed
`topology_critic_receipt_set` for **both** `pass` and `request_changes`.

Why that was inescapable: the throw verifies the frozen
`preReview.preReviewBasisArtifact`, which only `pre_review_check` can refresh, and
that command is `allowedPhases: ['DEV']`. DEV needs a finalized review-inventory
receipt, which needs a critic terminal state — the thing the throw blocked.

Fix: the basis requirement now lives on the pass branch only.

    if (args.verdict === 'pass' && !state.basisVerification.ok) throw ...

PASS is not weakened — it requires `basisVerification.ok` *and* the pre-existing
full receipt self-verification at the next line. `request_changes` may now be
signed over a stale basis, which is an honest record of what the critic judged.

An independent critic confirmed no pass-path regression and established something
I did not know: the older `basisStatus !== 'complete'` guard
(topology-critic-receipt.ts:407) does **not** catch this case — `basisStatus`
reads `complete` while the digests mismatch. So the new check is non-redundant.

### 2. Dispatch-provenance deadlock — NOT fixed, needs your decision

`deriveRoleProvenance` (topology-critic-receipt.ts:139-158) requires a recorded
`dispatch` process-event whose `sessionId` **equals the signing session's own id**:

    && candidate.sessionId === args.sessionId

But `dispatch` is not in the critic's `allowedCommandIds`
(prompt-role-contract-registry.ts:300 — only `topology_critic_receipt_set`,
`topology_critic_receipt_check`, `review_run_start`, `finding_add`,
`review_pass_set`, `review_inventory_critic_set`). So the critic cannot record the
event it needs, and a dispatch issued by the orchestrator records the
orchestrator's session id, which never matches a freshly-spawned subagent.

Verified live: two independently dispatched critic sessions each failed on **both**
verdicts with `no current registered dispatch provenance`, while `review_run_start`
from those same sessions succeeded.

**Net effect: no correctly-sandboxed critic can sign a receipt.**

I did not fix this. The first deadlock had a safety argument (the downstream
context is descriptive; it needs the basis readable, not verified; PASS keeps two
guards). This one touches *who may sign a critic receipt* — relaxing it dismantles
what the mechanism exists to protect. Options, none of which I should pick alone:

- host injects dispatch provenance into the subagent session
- `dispatch` becomes recordable by the critic role
- the binding keys on something a sandboxed critic can actually present

---

## What did work

Three complete saturation waves on epoch RI-048, five required lanes each:

| wave | outcome | receipt |
|---|---|---|
| 1 | F-114, F-115, F-116 | CRIT-01 |
| 2 | F-118, F-119 | CRIT-02 |
| 3 | F-120 | CRIT-03 |

All dispositioned `verified_family`. **None dismissed.** The epoch then hit
`maxWaves: 3` without saturating, and the framework's own instruction at
`REVIEW_INVENTORY_BUDGET_EXHAUSTED` is *"cancel and replan/decompose/escalate,
never manufacture PASS"* — so RI-048 was cancelled per that directive, with the
wave 1-3 signed history retained.

The core mechanism this story exists to build — frozen cutoff, bounded waves,
critic disposition, budget exhaustion — **worked, under three rounds of real use.**

---

## The pattern worth carrying forward

Of the 12 defects logged, four share one shape: **the status surface reads green
while the underlying assurance is absent.**

- `BUG-STATUS-STALE-LANE` — cross-epoch backfill shows old passes as current
- `BUG-VERIFIED-COUNT-MISREADS-AS-CLEAN` — "Verified findings: 0" when nothing is
  dispositioned yet, indistinguishable from "nothing found"
- `BUG-CHECKLIST-DONE-IGNORES-USERSEES` — 6/6 done while three items never
  delivered their declared output
- `BUG-PREREVIEW-STALE-REPORTED-AS-TAMPERED` — staleness surfaced as tampering

This story's whole purpose is preventing manufactured saturation signals, and its
own output layer repeatedly made that class of error. I misread three of these as
good news during this session.

Related: `BUG-USERSEES-NEVER-MECHANICALLY-CHECKED`. Three checklist items
(CHK-003/004/005) declared `userSees` text no code produces; each was caught only
by a reviewer hand-grepping one call site, across three separate waves (0 → 2 → 1).
Nothing compares a declared literal against emitted output, so the field carries a
delivery contract's weight with none of its enforcement.

---

## DEV work, ordered (all verified)

Do none of this while an epoch is OPEN — it mutates material and invalidates the wave.

1. **Delete `.remember-scratch-readmanifest.json`** — a reviewer's draft payload
   committed by accident in `665e0edf9c`. Currently the one blocking scope
   violation (`mode=enforce`). Delete it; do **not** `scope_contract_acknowledge`,
   which would assert it legitimately belongs in scope.
2. **`acceptance_basis_generate`** — refresh the basis.
3. **`acceptance_rollout_report`** — command-policy.ts:437, DEV-only, sole writer
   of the signed Wave 4 report. *Not listed in `--help`, but it exists.* Current
   failure is staleness only: the underlying data is a genuine full 3×2 (3 rounds
   × claude-cli/codex-cli), so this needs a **re-sign, not a quorum re-run**.
   *(Caveat a critic raised: `mislabeled3x1Count: 0` is a self-declared metric the
   verifier trusts once tamper checks pass — not independently re-derived.)*
4. **Export `replay()`** as `runReplayAcceptance` — review-inventory-epoch-smoke.ts:497,
   called at 639-640. **Correction to an earlier claim of mine:** the behaviour is
   fully implemented; only the exported name is missing. This is a rename/export,
   not new logic.
5. **Fix findings** F-114 (my rationale in command-policy.ts/config.ts is factually
   wrong — see below), F-115 (no test coverage for the REVIEW widening), F-116
   (doc-code drift), F-118/F-119/F-120 (`userSees` mismatches).

### F-114 — the accurate rationale to replace my wrong one

I wrote that the REVIEW widening of `acceptance_basis_generate` breaks a deadlock
where a stale basis blocks the topology critic receipt, which blocks
`review_inventory_finalize`. **That chain is wrong.** `review_inventory_finalize`
consumes a `ReviewInventoryCriticReceipt` via `review_inventory_critic_set` —
a different command writing a different artifact from `topology_critic_receipt_set`.
I conflated them for most of the session.

The accurate statement: the widening is **inert** for stories that already have a
pre-review artifact (proofstory.ts:309 prefers the frozen snapshot), but **does
take effect** for stories without one, via the `?? planArtifact` branch.

---

## Cannot be closed through the normal channel

F-089, F-113, F-117 come from the topology-critic lane, which is filtered out of
`ACTIVE_MODULAR_REVIEWER_ROLE_IDS` (prompt-role-contract-registry.ts:28-29 —
deliberate, but carrying no explanatory comment). It is therefore never in
`epoch.requiredLanes`, so `evaluateReviewInventoryWave`
(review-inventory-epoch.ts:361) never sees its findings. They can neither block
saturation nor be dispositioned. `BUG-CRITIC-FINDINGS-INVISIBLE`.

---

## Operational notes

- Use `node packages/main/dist/cli.js`, not the global `lattice` shim (stale dist).
- **Do not poll `review_inventory_status` while lanes are working.** Every call
  takes the same per-story epoch lock. My polling starved the docs lane through
  45+ failed `review_pass_set` attempts (RR-482..RR-533), nearly losing ~40 minutes
  of its completed work. The lock cleared the moment I stopped. Wait for agent
  completion notifications. See `BUG-EPOCH-LOCK-SERIALIZES-PARALLEL-LANES`.
- **Commit before requesting review.** `review_run_start` refuses to bind a review
  to uncommitted material source changes. Lattice metadata under
  `.lattice/story/` is excluded from material hashing and does not block it.
- **Dispatch with identity**: `env LATTICE_AGENT=<role> node packages/main/dist/cli.js ...`.
  The dispatcher supplies it; a critic setting it on itself would be fabrication.

---

## On the reviewers

Every substantive correction this session came from a reviewer refusing, not from
my own re-reading. The topology critic refused three times; each refusal exposed a
real error of mine — including that my own justification for a fix was false, and
that I was asking for review of uncommitted code. Two lanes independently
converged on the `userSees` defects without duplicating each other's findings.

If you tune anything here, keep the refusals cheap and keep reviewer identity
independent of the implementer. That is what worked.
