# Milestone Ledger Status Review Findings

Status: executed-pass-with-corrections (independent takeover audit, 2026-07-05)
Story: B-b550
Source plan: `docs/requirements/decisions/milestone-ledger-status-review-and-hardening-plan.md`
Scope: document review and hardening assessment only

## Executive Verdict

The read-only and PLAN-only safety boundary of the ProofStory milestone surface
holds: this review found no blocker and no unsafe path requiring an emergency
code change. The existing implementation matches the intended safety boundary:

- `milestone_status` and `milestone_closeout` are read-only observer commands
  (their only subprocesses are read-only `git` freshness probes; no lifecycle,
  reviewer, or evidence-writing command runs).
- `milestone_ledger_set` and `milestone_ledger_add` are explicit PLAN-phase
  story-scoped mutating commands.
- Direct milestone ledger writes stay candidate unless an accepted intent
  collision confirms unchanged ledger rows.
- Missing milestone ledgers are diagnostics for ordinary stories and blockers
  only where ProofStory policy requires milestone evidence AND the gate mode is
  `enforce` (the default `observe`/`warn` modes are advisory).
- Milestone progress helps progress reporting, handoff, and admission safety,
  but it does not replace lifecycle, review, validation, delivery, DONE, or
  production-readiness gates.

Independent takeover audit (2026-07-05). A second host re-verified every M0-M6
claim against source and refuted several; this report is corrected for those
inaccuracies (see the per-milestone "Correction" notes). Concretely: the reviewed
CLI source version is `0.3.159`, not `0.3.160`; the intent-hardening smoke does
NOT assert duplicate-row coverage; the strict-DONE requirement is conditional on
`doneGateMode: enforce`; and the status/closeout render output carries no explicit
DONE/Authority/production disclaimer string (it simply makes no such claim). None
of these overturns the safety verdict, but the audit also surfaced real
design-hardening gaps (an ungated `not_applicable` self-exemption, a stale-evidence
disagreement between `milestone_status` and the DONE gate, milestone closeout
acting as an undesigned second DONE gate, and missing negative-control tests).
Those are recorded as a bounded follow-up hardening story scope in M7, not fixed
here — this story is document-review-only and left source and test directories
untouched.

## M0. Source Inventory

Verdict: executed-pass (corrected).

Canonical root: the review was executed in the canonical Proofbound worktree at
`/Users/jek/Documents/Work/proofbound/.worktrees/B-b550`. The retired
Orchestrate root was not used as implementation truth.

Live Proofbound context:

- `lattice session_brief --storyId=B-b550` reported Story `B-b550`, phase `DEV`,
  and the same canonical worktree path.
- Version note (takeover audit correction): the installed global `lattice` binary
  reports `0.3.160`, but the worktree SOURCE under review declares `0.3.159` (both
  the root and `packages/main` `package.json`). This review's truth is the
  worktree source tree, so `0.3.159` is the authoritative version for the reviewed
  code; the earlier `0.3.160` citation was the installed binary, not the source.
- The stale-root lesson from dev-memory was applied: old Orchestrate planning
  prose is not allowed to override current source, tests, and Lattice facts.

Command-surface inventory:

- `milestone_ledger_set`
- `milestone_ledger_add`
- `milestone_ledger_get`
- `milestone_status`
- `milestone_closeout`

Authoritative implementation sources:

- `packages/main/src/handlers/proofstory.ts`
- `packages/main/src/core/proofstory.ts`
- `packages/main/src/core/types.ts`
- `packages/main/src/handlers/milestone-status.ts`
- `packages/main/src/core/milestone-status.ts`
- `packages/main/src/core/command-policy.ts`
- `packages/main/src/core/process-fact-levels.ts`
- `packages/main/src/core/process-fact-registry.ts`

Authoritative docs:

- `docs/requirements/decisions/proofstory-intent-collision-execution-plan.md`
- `docs/requirements/decisions/milestone-ledger-status-review-and-hardening-plan.md`
- `docs/requirements/NAV.md`

Test and smoke inventory:

- `packages/main/tests/milestone-status.test.mjs`
- `packages/main/src/tasks/proofstory-intent-hardening-smoke.ts`

Stale or retired-root note: no path under
`/Users/jek/Documents/Work/Orchestrate` is treated as authoritative for this
review.

## M1. Read-Only Boundary

Verdict: executed-pass (clarified).

Sub-objective results:

| ID | Outcome | Evidence |
|---|---|---|
| M1.a | pass | `assertMilestoneStatusReadOnlyBoundary` allows only `storyId`, `format`, and `json`. |
| M1.b | pass | Unknown keys fail before story facts are read. Live CLI probe rejected `--surpriseFlag=true`. |
| M1.c | pass | Missing ledger builds a report and does not write storage. |
| M1.d | pass | Status output launches no lifecycle or reviewer commands; its only subprocesses are read-only `git` freshness probes (see correction). |
| M1.e | pass | Status output writes no evidence, summaries, review passes, milestone storage, or lifecycle facts. |
| M1.f | pass | Output makes no DONE, Authority, or production-readiness claim (it carries no explicit disclaimer string either — see M6 correction). |

Source facts:

- `packages/main/src/handlers/milestone-status.ts` validates arguments before
  store reads.
- `packages/main/src/core/milestone-status.ts` hard-codes `readOnly: true`,
  `runCommands: false`, `writeEvidence: false`, `advancePhase: false`, and
  `launchReviewers: false`.
- `packages/main/src/core/command-policy.ts` classifies `milestone_status` and
  `milestone_closeout` as read-only, all-phase commands with destructive risk
  `none`.

Live rejection evidence:

```text
lattice milestone_status --storyId=B-b550 --surpriseFlag=true
Argument validation failed:
  (root): Unrecognized key: "surpriseFlag"
```

```text
lattice milestone_closeout --storyId=B-b550 --surpriseFlag=true
Argument validation failed:
  (root): Unrecognized key: "surpriseFlag"
```

Read-only status evidence:

```text
lattice milestone_status --storyId=B-b550 --format=json
mode.readOnly=true
mode.runCommands=false
mode.writeEvidence=false
mode.advancePhase=false
mode.launchReviewers=false
```

Correction (takeover audit): `runCommands: false` describes lifecycle/reviewer
command execution, not a literal zero-subprocess claim. `milestone_status` does
spawn read-only `git rev-parse` / `ls-tree` / `status --porcelain` through the
`currentMilestoneStatusEvidenceBinding` freshness path
(`core/milestone-status.ts` -> `core/evidence-freshness.ts`). These are read-only
observations and do not breach the boundary. Separately,
`handlers/milestone-status.ts` co-locates the write function
`captureMilestoneCloseoutSnapshotFromStore` (calls `store.writeMilestoneCloseout`),
but it is reachable ONLY from the DONE lifecycle transition
(`transition-orchestrator.ts`, guarded by `phase === 'DONE'`), never from the
`milestone_status` or `milestone_closeout` command handlers. Boundary intact.

Boundary finding: none.

## M2. Ledger Write Contract

Verdict: executed-pass (hardening note).

Sub-objective results:

| ID | Outcome | Evidence |
|---|---|---|
| M2.a | pass | `milestone_ledger_set` is allowed only in PLAN by command policy. |
| M2.b | pass | `milestone_ledger_add` is allowed only in PLAN by command policy. |
| M2.c | pass | Both write commands are `storyScopedMutating` gate-evidence commands. |
| M2.d | pass | Ledger rows are hash-bound and state is candidate or confirmed. |
| M2.e | pass | Direct writes cannot accidentally become confirmed gate evidence. |
| M2.f | pass | Replacement by `milestone_ledger_set` resets changed rows to candidate rather than preserving confirmation. |

Lifecycle phase policy: `packages/main/src/core/command-policy.ts` restricts
`milestone_ledger_set` and `milestone_ledger_add` to `['PLAN']`.

State behavior:

- `buildMilestoneLedger` computes a stable ledger hash over normalized rows.
- A requested confirmed state survives only when an existing confirmed ledger has
  the same hash.
- `addMilestoneToLedger` explicitly resets the ledger to candidate and clears
  accepted intent binding before rebuilding.
- `confirmMilestoneLedger` is the separate path that binds an accepted intent
  collision to the current ledger.

Confirmed binding evidence from this story:

```text
lattice milestone_ledger_get --storyId=B-b550 --json
state=confirmed
ledgerHash=sha256:7e6ee013ad6725702ffe65de67d190a818d5fefe115e1750d41b57d47f4ca724
acceptedIntentBinding.intentCollisionId=IC-20260705121840
```

Overwrite safety judgment: `milestone_ledger_set` can replace rows by design,
but it is PLAN-only, explicit, hash-bound, and cannot preserve confirmed gate
evidence across changed rows. This is not an unsafe silent overwrite in the
current contract.

Hardening note (takeover audit): `confirmMilestoneLedger` mints `state: confirmed`
from an accepted intent collision (`collisionAccepted`) and does not itself
re-assert `collision.confirmedLedgerHash === ledger.ledgerHash` at confirm time.
In the current contract this is safe because any later row change routes through
`milestone_ledger_set` / `addMilestoneToLedger`, which reset the ledger to
candidate; but an explicit confirm-time hash re-check would make the invariant
local rather than emergent. Recorded as a hardening item in M7, not a blocker.

Write-surface finding: none (contract is safe; one hardening item deferred to M7).

## M3. Missing-Ledger Policy

Verdict: executed-pass (corrected).

Missing-state matrix:

| Story class or state | Expected behavior | Review outcome |
|---|---|---|
| Ordinary story with no milestone trigger | `milestone_status` reports missing ledger and specific next action; no status-path mutation occurs. | pass |
| Ordinary single-outcome shrinkage with explicit user confirmation | Does not invent a milestone-ledger requirement. | pass |
| Structural or semantic milestone trigger | ProofStory diagnostics require milestone-ledger coverage. | pass |
| Candidate ledger with accepted intent collision missing confirmation | Diagnostics can report missing confirmed milestone ledger. | pass |
| REVIEW/DONE with strict milestone path | Under `doneGateMode: enforce`, DONE intent equivalence blocks unless a confirmed ledger covers the required milestone evidence; under the default `observe`/`warn` modes the same gap is advisory (non-blocking). | pass |
| Missing-ledger status output | Next action is specific and non-mutating in the status command itself. | pass |

Source facts:

- `packages/main/src/core/proofstory.ts` adds `missing_milestone_ledger` only when
  milestone triggers exist.
- The same module distinguishes candidate from confirmed milestone ledgers and
  can emit `missing_confirmed_milestone_ledger`.
- DONE intent equivalence checks strict milestone paths for confirmed ledger and
  covered required milestone evidence, but only returns a blocking result when
  `doneGateMode === 'enforce'` (`proofstory.ts`: `blocking = mode === 'enforce' &&
  gaps.length > 0`); the default gate mode is `observe`.
- `packages/main/tests/milestone-status.test.mjs` asserts missing-ledger status
  produces a report and does not pretend all rows are complete.
- `packages/main/src/tasks/proofstory-intent-hardening-smoke.ts` asserts
  confirmed single-outcome shrinkage does not invent a milestone-ledger
  requirement.

Missing-ledger next action is a recommendation to run
`lattice milestone_ledger_set --storyId=...`; the `milestone_status` command
itself does not perform that write.

Correction (takeover audit): the original matrix stated the strict-DONE
requirement unconditionally; it is in fact gated on `doneGateMode: enforce`
(default `observe`). Whether milestone-triggered stories should default to
`enforce` is a design question recorded in M7.

Missing-state finding: none.

## M4. Schema And Progress Model

Verdict: executed-pass (caveat).

Sub-objective results:

| ID | Outcome | Evidence |
|---|---|---|
| M4.a | pass | `MilestoneLedgerItem` contains `id`, `sourceRequirementId`, `claim`, `doneMeans`, and `requiredEvidence`. |
| M4.b | pass | `checklistRefs` and `verificationIntentRefs` bind rows to checklist and evidence intent surfaces. |
| M4.c | pass (with caveat) | Status values `planned`, `covered`, `done`, `not_applicable` suffice for progress tables; `not_applicable` is an operator-set, enum-validated self-exemption (see caveat below). |
| M4.d | pass | `parentLedgerId` and `assignedStory` support parent and child story linkage. |
| M4.e | pass | Prose-only docs cannot mint hidden milestone claims; rows come from explicit ledger commands. |
| M4.f | pass | No schema addition is required for current grouped status reports. |

The schema supports honest progress reporting because it projects explicit rows
and evidence bindings instead of deriving hidden sub-objectives from prose.
Future UI grouping can use the current row fields and should avoid inventing
new completion claims.

Caveat (takeover audit): `not_applicable` is validated only against the enum on
write (`normalizeMilestone`, `VALID_MILESTONE_STATUSES`); no rule proves a row so
marked is genuinely inapplicable, yet such rows render in the `completed` progress
group and drop out of the uncovered-required-milestone check. This is tolerable
only because setting it requires a PLAN-phase, hash-bound, intent-collision-
confirmed ledger write; still, gating or justifying `not_applicable` is a hardening
item recorded in M7.

Schema adequacy finding: none (schema adequate; one self-exemption hardening item deferred to M7).

## M5. Test Coverage And Negative Controls

Verdict: executed-pass (corrected).

Coverage map:

| Required coverage | Existing evidence |
|---|---|
| `milestone_status` read-only behavior | `packages/main/tests/milestone-status.test.mjs` covers mode flags and malformed-argument rejection. |
| Missing-ledger status reports | The test suite asserts missing ledger risk, next action, and no fake completion. |
| Ledger set/add/get schema behavior | `packages/main/src/tasks/proofstory-intent-hardening-smoke.ts` covers set/add/get, malformed payloads, parent rows, child story refs, candidate state, and hash presence. |
| Milestone-triggered missing-ledger gates | ProofStory hardening smoke asserts structural milestone triggers require a ledger. |
| Milestone status cannot satisfy DONE by itself | Closeout tests reject missing ledger, empty reports, candidate ledgers, risky reports, and incomplete reports. |
| Parser and pre-read negative controls | Tests verify unknown CLI flags reject before story facts are printed and malformed args reject before active-story metadata reads. |

Correction (takeover audit): the original coverage map overstated three points.
(1) The intent-hardening smoke does NOT assert duplicate-row handling — a source
grep for `duplicat*` over `proofstory-intent-hardening-smoke.ts` returns zero hits
— so that coverage claim is withdrawn. (2) No closeout test feeds a stale-only
status report into `buildMilestoneCloseoutSnapshot`; the stale-evidence test only
asserts `milestone_status` demotes the row, so the "stale reports" closeout
conjunct is withdrawn. (3) Suite-wiring asymmetry:
`packages/main/tests/milestone-status.test.mjs` is a `.mjs` under
`packages/main/tests/`, is not named by any `test:*` npm script, and is not
discovered by `run-all-smokes` (which globs `dist/tasks/*-smoke.js`); its own
header documents manual invocation, so it does NOT run in the aggregate suite.

Negative-control / test-gap list (recorded for the M7 follow-up):
- duplicate ledger-row negative control (no test today);
- empty / all-`not_applicable` confirmed-ledger negative control;
- stale-only report rejected by `buildMilestoneCloseoutSnapshot`;
- `milestone-status.test.mjs` wired into an aggregate suite runner so it is not
  silently skipped.

None of these is a blocker for this document-review story, but they are real
coverage gaps and belong in the M7 follow-up.

## M6. Capability Impact Boundary

Verdict: executed-pass (corrected).

The verified capability is specific and bounded:

- structured milestone rows improve progress reporting;
- missing-ledger gates improve unattended execution safety for stories that opt
  into or trigger milestone proof;
- checklist and verification-intent refs improve host handoff and restart
  continuity;
- status reports remain useful because they are observers, not hidden repair
  commands.

Overclaim boundary:

- milestone status does not replace `lifecycle_check`;
- milestone status does not replace review assurance;
- milestone status does not replace validation;
- milestone status does not replace delivery checks;
- milestone status does not replace the DONE gate;
- milestone status does not claim Authority or production readiness.

Correction (takeover audit): the claim that the status/closeout output "says it
is read-only and never claims DONE/Authority/production" is precise only in the
negative sense. `renderMilestoneStatusReport` and the missing-ledger/closeout
reports emit `Mode: read-only` and make no DONE/Authority/production claim, but
they carry NO explicit disclaimer string to that effect — the absence of an
overclaim is not the same as an affirmative disclaimer. Separately, the
`milestone_status` command-policy reason string does not mention Authority at all
(only `milestone_closeout`'s reason does). Adding an explicit output disclaimer
and closing the Authority-silence in the `milestone_status` reason string are
recorded as M7 hardening items. The bounded-capability judgment itself stands:
milestone progress is not a substitute for any lifecycle, review, validation,
delivery, or DONE gate.

Capability finding: none (capability bounded; two disclaimer/string hardening items deferred to M7).

## M7. Review Outcome And Decision

Verdict: executed-pass-with-corrections.

Closure table:

| Milestone | Outcome | Solved problem | Evidence |
|---|---|---|---|
| M0 | pass (corrected) | Source truth fixed before judging gaps; version citation corrected `0.3.160` -> `0.3.159`. | Source inventory and canonical-root note. |
| M1 | pass | Status commands are read-only observers; the only subprocesses are read-only `git` freshness probes. | Source review plus live unknown-flag rejection. |
| M2 | pass | Ledger writes are explicit, PLAN-only, and candidate-safe; one confirm-time hash re-check deferred to M7. | Command policy, proofstory source, live confirmed-binding read. |
| M3 | pass (corrected) | Missing-ledger strict-DONE requirement is gated on `doneGateMode: enforce`, not unconditional. | ProofStory diagnostics and smoke/test references. |
| M4 | pass (caveat) | Ledger schema supports honest progress reporting; `not_applicable` self-exemption flagged. | Type review. |
| M5 | pass (corrected) | Withdrew duplicate-row and stale-report coverage claims; recorded four real test gaps. | Test and smoke inventory plus source grep. |
| M6 | pass (corrected) | Capability claims bounded; missing output disclaimer and Authority-silence flagged. | Command policy and render-string review. |
| M7 | pass | Review closes as documentation-only completion with corrections and a bounded follow-up scope. | This findings report, updated source plan, and NAV entry. |

Implementation decision: the read-only + PLAN-only safety boundary is sufficient
and needs no emergency code change, so this document-review story ships no code
(source and test directories stayed read-only per the plan Non-Goals). The
independent takeover audit did, however, surface bounded design-hardening gaps
that warrant a narrow follow-up implementation story.

Follow-up story scope (proposed here, NOT created by this review):
Title: "Harden ProofStory milestone status/ledger observability boundary".
1. Add explicit DONE/Authority/production-readiness disclaimer strings to the
   `milestone_status` / `milestone_closeout` rendered output, and add Authority
   to the `milestone_status` command-policy reason string.
2. Add negative-control tests: duplicate ledger rows; empty / all-`not_applicable`
   confirmed ledger; a stale-only report rejected by `buildMilestoneCloseoutSnapshot`.
3. Wire `packages/main/tests/milestone-status.test.mjs` into an aggregate suite
   runner so it is not silently skipped by `run-all-smokes`.
4. Reconcile the stale-evidence disagreement between `milestone_status` (which
   demotes stale rows) and `evaluateDoneIntentEquivalence` (which can still pass
   via `evidenceCoversIntent`), and reconcile
   `captureMilestoneCloseoutSnapshotFromStore` acting as an undesigned second DONE
   gate with divergent throw semantics.
5. Decide whether `not_applicable` rows need an explicit justification/gate, and
   whether `confirmMilestoneLedger` should re-assert
   `confirmedLedgerHash === ledgerHash` at confirm time.
6. Revisit the milestone-triggered gate-mode default (`observe`).
This follow-up scope is code + tests only; it does not change the read-only or
PLAN-only contract that this review validated.

Documentation completion: this review is complete once the source plan status
columns and `docs/requirements/NAV.md` point to this findings report.
