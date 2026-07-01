# Unattended Develop Mode No-False-DONE 10x15 Milestone Baseline

Date: 2026-07-01
Status: full local deterministic baseline implemented; G01-G10 plus aggregate smoke are covered
Related docs:

- `docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md`
- `docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md`
- `docs/requirements/decisions/proofstory-intent-collision-execution-plan.md`
- `docs/requirements/decisions/unlock-layer3-loop-engineering-suite.md`
- `docs/requirements/decisions/lattice-unattended-completion-plan.md`

## Purpose

This document defines a deterministic **10 groups x 15 milestones** baseline for
Loop Engineering and Unattended Develop Mode (UDM). Its purpose is to prove that
Proofbound cannot falsely report DONE for a large multi-milestone request when
the milestone ledger is incomplete, stale, prose-only, migration-only, or
overclaimed.

This baseline is the UDM **no-false-DONE regression test**:

```text
An unattended loop may keep working, repairing, reviewing, and retrying, but it
must not claim DONE unless every required milestone row is covered by fresh,
machine-admissible evidence and the parent-roadmap rollup permits the claim.
```

The baseline exists because a real UDM task can contain dozens or hundreds of
user intent commitments. The system must prove totality mechanically instead of
trusting an agent's memory, checklist wording, or summary prose.

## Product Risk Covered

The baseline protects against these UDM failure modes:

| Failure mode | What can go wrong without this baseline |
|---|---|
| Checklist shrinkage | A narrow child checklist is marked done while the original user request had more milestones. |
| Prose-only closure | A document says a row is done, but no verifier, smoke, command, or evidence proves it. |
| Stale evidence | A row was proven before a material change, merge, or evidence mutation invalidated the proof. |
| Migration confusion | Historical sample or migration rows are mistaken for real completed roadmap rows. |
| Overclaim | Local smoke evidence is reported as production, Authority, fullAuthority, or independent-host completion. |
| Partial ledger rollup | A parent roadmap closes even though at least one required milestone is open, deferred, invalid, or stale. |
| Large-ledger omission | A 100+ item task silently drops rows because the story is too broad for manual review. |
| Loop fatigue | An unattended loop stops at "tests passed" without checking user-value delivery and parent intent equivalence. |

## Baseline Shape

The baseline contains 10 independent synthetic parent ledgers. Each ledger
contains exactly 15 required milestone rows, for a total of 150 rows.

```text
10 parent ledgers x 15 required milestones = 150 milestone rows
```

The rows are intent-coverage rows, not execution slices. A future implementation
must not create 150 real stories. The test should use synthetic ledgers and
rollup fixtures so it can run quickly and deterministically.

Milestone IDs are deterministic:

```text
G01-M01 ... G01-M15
G02-M01 ... G02-M15
...
G10-M01 ... G10-M15
```

Each group must instantiate all 15 milestone rows. The rollup must explicitly
report row count, closed rows, open rows, stale rows, invalid rows, deferred
rows, migration rows, and claim boundary status.

## Implementation Progress

Current implemented slice: **G01-G10 plus aggregate**. The full local
deterministic 10x15 baseline is implemented.

Runnable command after building `packages/main`:

```bash
node packages/main/dist/tasks/parent-roadmap-large-ledger-g01-baseline-smoke.js
node packages/main/dist/tasks/parent-roadmap-large-ledger-g02-baseline-smoke.js
node packages/main/dist/tasks/parent-roadmap-large-ledger-g03-baseline-smoke.js
node packages/main/dist/tasks/parent-roadmap-large-ledger-g04-baseline-smoke.js
node packages/main/dist/tasks/parent-roadmap-large-ledger-g05-baseline-smoke.js
node packages/main/dist/tasks/parent-roadmap-large-ledger-g06-baseline-smoke.js
node packages/main/dist/tasks/parent-roadmap-large-ledger-g07-baseline-smoke.js
node packages/main/dist/tasks/parent-roadmap-large-ledger-g08-baseline-smoke.js
node packages/main/dist/tasks/parent-roadmap-large-ledger-g09-baseline-smoke.js
node packages/main/dist/tasks/parent-roadmap-large-ledger-g10-baseline-smoke.js
node packages/main/dist/tasks/parent-roadmap-large-ledger-baseline-smoke.js
```

The G01 smoke lives at
`packages/main/src/tasks/parent-roadmap-large-ledger-g01-baseline-smoke.ts`.
It generates exactly 15 `G01-M01` ... `G01-M15` rows, evaluates them with the
existing parent-roadmap rollup API, asserts the positive-control
`full_roadmap_complete` result, rejects a 14-generated-row negative control, and
guards that local proof does not become Authority, fullAuthority, production, or
independent two-host completion evidence.

The G02 smoke lives at
`packages/main/src/tasks/parent-roadmap-large-ledger-g02-baseline-smoke.ts`.
It is the missing-row negative-control smoke: the required inventory is exactly
15 row ids, the generated ledger contains exactly 14 fresh closed rows, and
`G02-M15` is deliberately omitted. The rollup must surface `G02-M15` as the only
open and invalid row with `missing_required_row`, return
`no-full-roadmap-claim`, and block full completion wording.

The G03 smoke lives at
`packages/main/src/tasks/parent-roadmap-large-ledger-g03-baseline-smoke.ts`.
It is the prose-only negative-control smoke: the required inventory and generated
ledger both contain exactly 15 `G03-M01` ... `G03-M15` rows, and each row contains
written closure/completion prose while carrying no machine closure evidence. The
rollup must keep all 15 rows open with missing evidence, return
`no-full-roadmap-claim`, and block full completion wording even when a
caller-supplied prose rollup says all rows are complete.

The G04 smoke lives at
`packages/main/src/tasks/parent-roadmap-large-ledger-g04-baseline-smoke.ts`.
It is the stale-evidence negative-control smoke: all 15 rows carry closure
evidence, but the row-level head/material/story-file bindings are stale against
the current evaluation context. The rollup must report
`staleEvidenceRows=15`, close zero rows, return `no-full-roadmap-claim`, and
block full completion wording.

The G05 smoke lives at
`packages/main/src/tasks/parent-roadmap-large-ledger-g05-baseline-smoke.ts`.
It is the deferred-row negative-control smoke: 12 rows have fresh closure
evidence while 3 rows have valid human-approved deferrals. The rollup must keep
the 3 deferrals visible in `deferredRows`, must not count them as runtime
closure, must return `no-full-roadmap-claim`, and must block full completion
wording. The focused `parent-roadmap-totality-smoke` also covers this evaluator
behavior so valid deferrals cannot silently become full-roadmap completion.

The G06 smoke lives at
`packages/main/src/tasks/parent-roadmap-large-ledger-g06-baseline-smoke.ts`.
It is the migration/sample negative-control smoke: all 15 rows are historical
or sample migration rows. The rollup must return `migration_needed`, report all
15 rows in `migrationRows`, and block full completion wording.

The G07 smoke lives at
`packages/main/src/tasks/parent-roadmap-large-ledger-g07-baseline-smoke.ts`.
It is the overclaim-boundary smoke: all 15 local rows close with fresh evidence,
and safe local boundary wording remains allowed for the local deterministic
baseline. Full-roadmap wording and deliberately elevated guard text that claims
Authority, fullAuthority, production, or independent-host completion must be
rejected by the boundary guard and must not appear in accepted row
`claimBoundary` values.

The G08 smoke lives at
`packages/main/src/tasks/parent-roadmap-large-ledger-g08-baseline-smoke.ts`.
It is the malformed/duplicate-row negative-control smoke: 15 generated entries
cannot satisfy all 15 required row commitments when a generated row is invalid
or a duplicate leaves a required row uncovered. The rollup must surface
`invalidRows>0`, return `no-full-roadmap-claim`, and block full completion
wording.

The G09 smoke lives at
`packages/main/src/tasks/parent-roadmap-large-ledger-g09-baseline-smoke.ts`.
It is the child-assignment negative-control smoke: every row has an active
`childStoryId`, but assignment is not delivery. The rollup must keep all 15 rows
open/incomplete and block full completion wording until closure evidence exists.

The G10 smoke lives at
`packages/main/src/tasks/parent-roadmap-large-ledger-g10-baseline-smoke.ts`.
It is the stale-then-refreshed recovery smoke: the before state has 15 stale rows
and blocks full completion wording; the refreshed state has the same 15 rows
bound to fresh evidence and permits full roadmap completion only after refresh.

The aggregate smoke lives at
`packages/main/src/tasks/parent-roadmap-large-ledger-baseline-smoke.ts`.
It evaluates the 10 groups x 15 required rows = 150-row local matrix, asserts
the group rollup counts, checks the G10 before/after recovery, and verifies that
elevated G07 wording is rejected while safe local boundary wording remains
allowed.

The project validation config is not changed by this B-d278 slice. Run the
commands above directly for the local deterministic baseline. This baseline
does not assert Authority, fullAuthority, production rollout, remote execution,
or independent-host completion.

| Group | Implementation status |
|---|---|
| G01 | Implemented as the positive-control 15-row baseline smoke. |
| G02 | Implemented as the missing-row negative-control 14-of-15 baseline smoke. |
| G03 | Implemented as the prose-only negative-control 15-of-15 baseline smoke. |
| G04 | Implemented as the stale-evidence 15-of-15 baseline smoke. |
| G05 | Implemented as the 12-closed / 3-deferred baseline smoke. |
| G06 | Implemented as the migration/sample 15-row baseline smoke. |
| G07 | Implemented as the local-boundary / elevated-overclaim smoke. |
| G08 | Implemented as the malformed/duplicate-row invalid baseline smoke. |
| G09 | Implemented as the child-assignment-without-delivery baseline smoke. |
| G10 | Implemented as the stale-then-refreshed recovery baseline smoke. |

## Common Milestone Template

Every group uses the same row schema shape so failures are comparable.

| Row field | Requirement |
|---|---|
| `rowId` | Stable `Gxx-Myy` identifier. |
| `intentText` | User-visible commitment that must not be narrowed by implementation. |
| `status` | One of `closed-by-existing-evidence`, `child-story-needed`, `deferred`, `invalid`, `migration-only`, or equivalent current enum. |
| `closureEvidence` | Required for closed rows; must name command, artifact ref, result, observed time, and stale state. |
| `materialRefs` | Required for material rows; empty only for migration/sample rows where no closure claim is allowed. |
| `claimBoundary` | Required for every closed row; must prevent broader production or Authority overclaim. |
| `stale` | Explicit boolean or derived evidence state consumed by the rollup. |

## The 15 Milestone Rows

Each group uses these 15 row meanings. The row meanings are generic on purpose:
they model a realistic multi-deliverable UDM task without coupling the baseline
to a single feature area.

| Row | Meaning | Required closure signal |
|---|---|---|
| M01 | Original intent snapshot preserved | Snapshot exists and is bound to the parent ledger. |
| M02 | Milestone ledger complete | All 15 required row IDs are present. |
| M03 | Intent coverage check | Parent requirements map to milestone rows. |
| M04 | Scope shrinkage guard | No unconfirmed narrowing of the original request. |
| M05 | Child/story slicing boundary | Large ledger is not treated as one giant unchecked checklist. |
| M06 | Acceptance contract binding | Rows bind to acceptance claims or verification intent. |
| M07 | Machine evidence present | Closed rows carry command-backed evidence, not prose only. |
| M08 | Evidence freshness | Evidence material/story-file binding is current. |
| M09 | Negative control | Migration/sample/legacy rows cannot satisfy the real parent claim. |
| M10 | Review assurance | Required review or degraded fallback state is explicit and bounded. |
| M11 | Delivery check | User-value delivery is checked separately from engineering logs. |
| M12 | Claim boundary | Local evidence does not become production, Authority, fullAuthority, or two-host proof. |
| M13 | DONE intent equivalence | Actual delivery is equivalent to the frozen original intent. |
| M14 | Rollup status | Parent rollup computes complete/open/stale/invalid/deferred rows correctly. |
| M15 | Handoff summary | Final summary exposes limitations, pitfalls, and next action if not complete. |

## Ten Baseline Groups

The baseline must include the following 10 groups. Each group contains all 15
milestone rows above and differs only in row status/evidence shape.

| Group | Scenario | Required rollup result | Why it exists |
|---|---|---|---|
| G01 | All 15 rows closed with fresh machine evidence | `full_roadmap_complete` | Positive control: proves the baseline can complete when all proof is valid. |
| G02 | 14 rows closed, 1 required row missing | `no-full-roadmap-claim`, `openRows=1`, `invalidRows=1` | Prevents one missing milestone from being hidden by an otherwise large pass set. |
| G03 | 15 rows have prose closure but no machine evidence | `no-full-roadmap-claim`, evidence missing | Prevents documentation text from satisfying DONE. |
| G04 | 15 rows have stale evidence | `no-full-roadmap-claim`, `staleEvidenceRows=15` | Proves stale material or story-file bindings block completion. |
| G05 | 12 rows closed, 3 rows deferred | `no-full-roadmap-claim`, `deferredRows=3` | Ensures deliberate deferral is visible and not counted as complete. |
| G06 | Migration/sample ledger only | `migration_needed`, `migrationRows=15` | Prevents historical sample data from becoming real completion evidence. |
| G07 | 15 local rows closed but overclaim Authority/production completion | blocked or invalid claim boundary | Prevents local proof from being reported as production, Authority, fullAuthority, or independent-host completion. |
| G08 | Duplicate or malformed row IDs | invalid ledger, `invalidRows>0` | Prevents duplicate milestone IDs from covering multiple user commitments. |
| G09 | Child story assigned but child evidence incomplete | `no-full-roadmap-claim`, open/incomplete rows | Prevents "assigned to a story" from counting as delivered. |
| G10 | 15 rows initially stale, then refreshed to fresh | first blocked, then `full_roadmap_complete` | Proves the loop can recover safely without bypassing stale evidence checks. |

## Expected Group Matrix

This matrix is normative for the future smoke test. The implementation may use
helpers to generate the 150 rows, but the observed rollup must match this table.

| Group | Total rows | Closed rows | Open rows | Stale rows | Deferred rows | Invalid rows | Migration rows | Full claim allowed |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| G01 | 15 | 15 | 0 | 0 | 0 | 0 | 0 | yes |
| G02 | 15 | 14 | 1 | 0 | 0 | 1 | 0 | no |
| G03 | 15 | 0 | 15 | 0 | 0 | 0 | 0 | no |
| G04 | 15 | 0 | 15 | 15 | 0 | 0 | 0 | no |
| G05 | 15 | 12 | 3 | 0 | 3 | 0 | 0 | no |
| G06 | 15 | 0 | 15 | 0 | 0 | 0 | 15 | no |
| G07 | 15 | 15 | 0 | 0 | 0 | 0 | 0 | safe local boundary yes; full/elevated overclaim blocked |
| G08 | 15 | 14 | 1 | 0 | 0 | >0 | 0 | no |
| G09 | 15 | <15 | >0 | 0 | 0 | 0 | 0 | no |
| G10 | 15 | 15 after refresh | 0 after refresh | 15 before refresh | 0 | 0 | 0 | yes after refresh only |

## Full Smoke Test Contract

The full 10x15 implementation includes this aggregate smoke:

```text
node packages/main/dist/tasks/parent-roadmap-large-ledger-baseline-smoke.js
```

Source file for the full baseline:

```text
packages/main/src/tasks/parent-roadmap-large-ledger-baseline-smoke.ts
```

The full smoke test:

1. Generates the 10 synthetic parent ledgers.
2. Evaluates exactly 150 required milestone rows.
3. Evaluates each parent rollup.
4. Asserts the group matrix above.
5. Asserts that G01 and the refreshed state of G10 permit full roadmap completion.
6. Asserts that G03 cannot pass with prose-only evidence.
7. Asserts that G04 cannot pass with stale evidence.
8. Asserts that G06 returns migration/sample semantics, not real completion.
9. Asserts that G07 rejects Authority, fullAuthority, production, and independent-host completion wording while allowing safe local wording.
10. Asserts that malformed or ambiguous groups fail closed instead of returning `full_roadmap_complete`.

The test should fail closed. If a group is malformed or ambiguous, the result
must be `no-full-roadmap-claim` rather than `full_roadmap_complete`.

## Acceptance Criteria

The baseline is complete only when all of these are true:

| Acceptance criterion | Required result |
|---|---|
| Row count | Exactly 150 rows generated and evaluated. |
| Positive control | G01 permits full completion. |
| Recovery control | G10 permits full completion only after evidence refresh. |
| Negative controls | G02-G06 and G08-G09 do not permit a full completion claim; G07 permits only safe local wording and blocks elevated overclaims. |
| Prose-only guard | G03 fails even if every row contains completion wording. |
| Freshness guard | G04 fails while stale and names stale rows. |
| Migration guard | G06 reports migration/sample semantics and no full roadmap claim. |
| Overclaim guard | G07 cannot set Authority, fullAuthority, production, or independent-host completion claims; safe local boundaries remain allowed. |
| Duplicate guard | G08 reports invalid row IDs or invalid rows. |
| Child assignment guard | G09 proves assignment is not delivery. |
| Operator guidance | Every failed group exposes actionable next steps. |

## Relationship To Unattended Develop Mode

UDM can continue unattended only when every loop iteration respects proof-stop
semantics:

```text
if proof is missing, stale, invalid, migration-only, or overclaimed:
  stop the DONE claim
  keep or resume the loop
  repair evidence or ask for human confirmation
```

This baseline is therefore not a performance benchmark. It is a correctness
benchmark for unattended completion:

- It proves that a large milestone ledger is not reduced to a small checklist.
- It proves that a parent DONE claim is not allowed when any required row is
  missing, stale, deferred, invalid, or migration-only.
- It proves that local evidence remains local evidence.
- It gives UDM a stable regression suite for "do not fake DONE" behavior.

## Non-Goals

Story B-b596 implemented the G01 positive-control smoke. Story B-e891
implemented the G02 missing-row negative-control smoke. Story B-727b implemented
the G03 prose-only negative-control smoke. Story B-d278 completes the remaining
local deterministic baseline by adding G04-G10 plus the aggregate 10x15 smoke.

This baseline also does not require or claim 150 real Lattice stories, remote
hosts, elevated rollout status, Authority receipts, fullAuthority receipts,
production execution, or independent two-host evidence. It should use synthetic
local fixtures unless a future unlock story explicitly requires live execution.

## Summary

The 10x15 milestone baseline makes "no false DONE" a repeatable, machine-tested
property of Loop Engineering. A UDM loop may be long-running and unattended, but
it must remain proof-bound: every milestone row must be represented, evidenced,
fresh, claim-bounded, and included in the final parent rollup before DONE can be
claimed.
