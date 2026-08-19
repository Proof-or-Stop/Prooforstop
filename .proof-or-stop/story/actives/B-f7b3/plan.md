# Plan: Harden ProofStory milestone status/ledger observability boundary (B-b550 M7 follow-up)

Source: docs/requirements/decisions/milestone-ledger-status-review-findings.md section M7 (the six follow-up hardening items).

## Chosen approach: additive-first-conservative

Close the six audit findings with additive changes + tests, tighten the boundary locally, and RECORD (not blindly flip) the behavior-change decisions. Do NOT weaken the read-only or PLAN-only milestone contract. Key decisions:

- Disclaimer: one shared MILESTONE_OBSERVABILITY_DISCLAIMER constant rendered as a new line after each 'Mode:' line (status + closeout + missing reports). Render-only; no schema/JSON change.
- not_applicable justification: add an optional structured notApplicableDecision field (reason + decidedBy) + a policy check; migration-safe (does not invalidate legacy confirmed ledgers).
- Gate-mode default: OBSERVE stays the default (recorded rationale). Do NOT flip observe->enforce (wide blast radius across all milestone-triggered stories).
- Stale-evidence reconciliation: make milestone_status freshness and the designed DONE gate (evaluateDoneIntentEquivalence) agree, and stop captureMilestoneCloseoutSnapshotFromStore from being a divergent second gate; strictness lives in the designed gate, backed by negative-control tests.

Non-goals: no production/deploy/infra; no contract rewrite; no enforce flip; no mandatory-field migration of legacy ledgers.

## CHK-001 Add explicit non-DONE/non-Authority/non-production disclaimer strings to milestone_status and milestone_closeout rendered output

packages/main/src/core/milestone-status.ts renderMilestoneStatusReport (~L1146-1187), the missing-ledger report, and the closeout report currently emit only 'Mode: read-only'. Add an explicit disclaimer line stating milestone progress is not lifecycle DONE, not Authority, not production readiness. Closes findings M6 (report lines re: M1.f/M6). Update packages/main/tests/milestone-status.test.mjs to assert the disclaimer string is present.

User sees: After running `lattice milestone_status --storyId=<id>` (or the milestone_closeout report), the operator sees a new explicit disclaimer line directly under the existing `Mode: read-only` header of every rendered report. Concretely:

- `milestone_status` (populated ledger) header block now reads:
  `Milestone Status - <id>`
  `Mode: read-only`
  `Disclaimer: Milestone progress is not lifecycle DONE, not Authority-signed, and not production readiness.`
  `Phase: <phase>` ...

- `milestone_status` with a MISSING ledger prints the same `Disclaimer:` line under `Mode: read-only` (progress cannot be inferred, and the report still must not imply DONE/Authority/production).

- `milestone_closeout` snapshot report header now reads:
  `Milestone Closeout - <id>`
  `Mode: read-only historical snapshot`
  `Disclaimer: This is a historical milestone snapshot, not lifecycle DONE, not Authority-signed, and not production readiness.`

- `milestone_closeout` missing-snapshot report prints the same `Disclaimer:` line under `Mode: read-only historical snapshot`.

The disclaimer text is a stable literal that mentions all three negatives (not lifecycle DONE, not Authority, not production readiness). No table columns, ordering, or other lines change; it is purely an added advisory line, consistent with the read-only/no-write posture of these commands.
Files — modify: packages/main/src/core/milestone-status.ts, packages/main/tests/milestone-status.test.mjs; test: packages/main/tests/milestone-status.test.mjs

## CHK-002 Add 'Authority' to the milestone_status command-policy reason string to match milestone_closeout

packages/main/src/core/command-policy.ts: the milestone_status reason (~L237) omits Authority while milestone_closeout (~L238) includes it. Add the Authority-silence fix so both read-only commands disclaim Authority uniformly. Closes findings M6 Authority-silence note.

User sees: After the fix, an operator inspecting the command-policy reason for milestone_status (via `lattice help milestone_status`, `getCommandPolicy('milestone_status').reason`, or any surface that renders the policy reason) sees the disclaimer end with an explicit Authority disclaimer matching milestone_closeout. Concretely the milestone_status reason tail changes from "…advances no phase, and never claims automatic DONE or production readiness." to "…advances no phase, and never claims automatic DONE, production, or remote Authority readiness." Both read-only milestone commands (milestone_status and milestone_closeout) now literally contain the word "Authority" in their reason string, so a grep for the token no longer shows a gap. No behavior, phase-gating, ownershipClass, destructiveRisk, or allowedPhases changes — only the human-readable reason string gains the uniform Authority-silence disclaimer, closing the M6 Authority-silence note.
Files — modify: packages/main/src/core/command-policy.ts; test: packages/main/tests/milestone-status.test.mjs

## CHK-003 Add negative-control test: duplicate ledger rows are de-duplicated or rejected by the ledger builder

packages/main/src/tasks/proofstory-intent-hardening-smoke.ts has zero duplicat* coverage (grep = 0 hits, the withdrawn M5 claim). Add an assertion that milestone_ledger_set/buildMilestoneLedger with two rows sharing an id is rejected or de-duplicated. Closes findings M5 test-gap #1.

User sees: Running `node dist/tasks/proofstory-intent-hardening-smoke.js` (or the wired `npm test` entry that includes it) prints `ProofStory intent hardening smoke passed` and exits 0, now with new negative-control assertions exercised. If the ledger builder ever stops de-duplicating, the run instead fails with an assertion like `AssertionError [ERR_ASSERTION]: milestone_ledger_set with two rows sharing an id M1 is rejected` and a nonzero exit. Concretely, invoking `lattice milestone_ledger_set '{"storyId":"B-proofstory","milestones":[{"id":"M1",...},{"id":"M1",...}]}'` (two rows sharing id M1) exits nonzero and prints `duplicate milestone id: M1`; the same duplicate id fed to `milestone_ledger_add` (adding an id already present) exits nonzero and prints `duplicate milestone id: M1`, and neither call writes a corrupted milestone-ledger.json.
Files — modify: packages/main/src/tasks/proofstory-intent-hardening-smoke.ts; test: packages/main/src/tasks/proofstory-intent-hardening-smoke.ts

## CHK-004 Add negative-control test: empty / all-not_applicable confirmed ledger is not treated as vacuously complete

core/proofstory.ts uncovered-required-milestone loop (~L1357-1364) iterates only ledger.milestones; a confirmed ledger with an empty or all-not_applicable milestone set yields zero uncovered rows. Add a test proving a confirmed-but-vacuous ledger does NOT satisfy the milestone DONE requirement. Closes findings M5 test-gap #2 and M4 caveat.

User sees: Running the milestone DONE-equivalence suite (`npm --prefix packages/main run build && node packages/main/tests/milestone-status.test.mjs`) prints a new passing assertion block such as `ok - negative control: confirmed empty ledger is NOT vacuously milestone-complete` and `ok - negative control: confirmed all-not_applicable ledger is NOT vacuously milestone-complete`. Concretely, when `evaluateDoneIntentEquivalence` is called in `enforce` mode with a `state: 'confirmed'` ledger whose `milestones` array is empty (and again with a ledger whose every row is `status: 'not_applicable'`), on the strict-milestone path (forced by a structural multi-deliverable story signal / slicePlan), the returned report has `status: 'fail'` and `blocking: true`, and `report.gaps` contains a gap whose `code` flags the vacuous/empty required-milestone set (e.g. `vacuous_milestone_ledger` / `uncovered_required_milestones`) with severity `fail` — instead of the pre-fix behavior where `uncoveredRequiredMilestoneIds` is `[]` and the report silently returns `status: 'pass'`. An operator who reaches DONE with such a ledger sees the DONE gate refuse to close the story, citing that a confirmed milestone ledger with no applicable required milestones does not satisfy strict intent equivalence.
Files — modify: packages/main/tests/milestone-status.test.mjs; test: packages/main/tests/milestone-status.test.mjs

## CHK-005 Add negative-control test: a stale-only status report is rejected by buildMilestoneCloseoutSnapshot

packages/main/tests/milestone-status.test.mjs stale-evidence block (~L749-870, stale ledger built ~L823) only asserts milestone_status demotes the row; no test feeds a stale-only report into buildMilestoneCloseoutSnapshot to assert it throws. Add that closeout negative control. Closes findings M5 test-gap #3.

User sees: Running `npm --prefix packages/main run build && node packages/main/tests/milestone-status.test.mjs` completes with a `# stale-only closeout negative control passed` style success (process exit 0, no `AssertionError`). The newly added assertion block inside the stale-evidence section (~L806-868) proves that the same stale-only `report` which `milestone_status` demotes to the `Current` group also causes `buildMilestoneCloseoutSnapshot({ report })` to THROW. The operator sees the run reach the end of the suite ("all milestone-status assertions passed") only because the closeout guard rejected the stale report with a message matching `incomplete milestone rows: M-stale=current`. If someone regresses the guard so a stale-only report is silently frozen into a closeout snapshot, this run instead fails with `AssertionError [ERR_ASSERTION]: Missing expected exception` (the `assert.throws` firing), naming this negative control.
Files — test: packages/main/tests/milestone-status.test.mjs

## CHK-006 Wire packages/main/tests/milestone-status.test.mjs into an aggregate suite runner so it is not silently skipped

run-all-smokes.ts discoverSmokes globs dist/tasks/*-smoke.js; the .mjs test under packages/main/tests/ is named by no test:* npm script and its header documents manual invocation. Add a test:* script and/or run-all-smokes inclusion so it runs in the aggregate suite. Closes findings M5 suite-wiring gap.

User sees: Running `npm run test:milestone-status` from the repo root prints the milestone-status regression's terminal output ending in `ok milestone-status` and exits 0. Running the aggregate suite `npm test` from the repo root now includes a `> proofbound@... test:milestone-status` step in its &&-chain whose output shows `ok milestone-status`; if that .mjs regression fails, `npm test` aborts with a non-zero exit at that step (the milestone-status test is no longer silently skipped by the aggregate suite). `npm run` lists a `test:milestone-status` entry, so the test is named by a discoverable script. The head comment of packages/main/tests/milestone-status.test.mjs no longer documents only manual invocation — it names the `npm run test:milestone-status` / `npm test` wiring.
Files — modify: package.json, packages/main/tests/milestone-status.test.mjs; test: packages/main/tests/milestone-status.test.mjs

## CHK-007 Gate not_applicable milestone rows behind an explicit justification so they cannot be a zero-evidence self-exemption

core/proofstory.ts normalizeMilestone (~L301-316) validates not_applicable against VALID_MILESTONE_STATUSES only, with no rule that the row is genuinely inapplicable; it then short-circuits the uncovered-required check and renders in the completed group. Add a required justification/reason field (or policy) for not_applicable, without weakening the PLAN-only, hash-bound, intent-collision-confirmed write contract. Design-decision item; record the decision. Closes findings M4 caveat.

User sees: When an operator runs `milestone_ledger_add` (or `buildMilestoneLedger`) with `status=not_applicable` but no justification, the CLI now fails instead of silently accepting the row. Terminal shows a shape error like:

  Error: milestones[2].notApplicableDecision is required when status is not_applicable (needs reason, decidedBy, decidedAt)

When the justification is supplied (e.g. `--not-applicable-reason "REQ-014 covered by parent story P-9; no runtime behavior here" --decided-by info@retiave.com`), the add succeeds and `milestone_ledger_get --json` shows the row carrying `"notApplicableDecision": { "reason": "...", "decidedBy": "...", "decidedAt": "2026-07-05T..." }`. That justification is folded into `ledgerHash`, so editing the reason on a previously `confirmed` ledger drops its state back to `candidate` (visible as `State: candidate` on the next add and loss of `acceptedIntentBinding`). The DONE-intent-equivalence gate still skips the row from `uncoveredRequiredMilestoneIds`, but only because the row now carries a validated, hash-bound, human-attributed reason — an unjustified `not_applicable` row can no longer reach a confirmed ledger and therefore can no longer self-exempt from the uncovered-required check. The decision is recorded at docs/requirements/decisions/milestone-not-applicable-justification.md.
Files — modify: packages/main/src/core/proofstory.ts, packages/main/src/core/types.ts; create: docs/requirements/decisions/milestone-not-applicable-justification.md; test: packages/main/tests/milestone-not-applicable-justification.test.mjs

## CHK-008 Re-assert confirmedLedgerHash === ledgerHash inside confirmMilestoneLedger at confirm time

core/proofstory.ts confirmMilestoneLedger (~L382-402) mints state=confirmed from an accepted intent collision without re-checking collision.confirmedLedgerHash === ledger.ledgerHash; today safety is emergent (any later row change routes through set/add which reset to candidate). Add an explicit confirm-time hash re-check so the invariant is local. Closes findings M2 hardening note.

User sees: Running the milestone-ledger confirm flow, the operator sees confirmation minted only when the accepted intent-collision was decided against the exact current ledger. Concretely: `node dist/tasks/proofstory-intent-hardening-smoke.js` prints `proofstory-intent-hardening-smoke: PASS` including the new assertion `confirmMilestoneLedger re-checks collision.confirmedLedgerHash === ledgerHash at confirm time`. In the CLI, `intent_collision_set --decision pass` against an unchanged ledger still returns `confirmedLedger.state = "confirmed"` (unchanged happy path), and `proofstory_gate_check` still reports `ledgerState: "confirmed"`. But if the ledger rows drifted after the collision was accepted (its `confirmedLedgerHash` no longer equals the current `ledgerHash`), `confirmMilestoneLedger` now returns the ledger still in `state: "candidate"` instead of falsely minting `confirmed` — the invariant is enforced locally at confirm time rather than relying on downstream set/add resets.
Files — modify: packages/main/src/core/proofstory.ts, packages/main/src/tasks/proofstory-intent-hardening-smoke.ts; test: packages/main/src/tasks/proofstory-intent-hardening-smoke.ts

## CHK-009 Record an explicit decision on the milestone-triggered gate-mode default (observe vs enforce)

packages/main/src/handlers/phase-gates.ts resolves doneGateMode (type declared in packages/main/src/core/config.ts:60 as 'observe'|'warn'|'enforce', default observe); strict-DONE blocking only fires under 'enforce' (proofstory.ts blocking = mode === 'enforce' && gaps.length > 0, ~L1387/1442). Decide (with a recorded rationale/decision-doc) whether milestone-triggered stories should default to enforce; observe->enforce is a behavior change with wide blast radius, so this is a decision item, not a blind flip. Closes findings M3/M7 gate-mode default question.

User sees: A committed decision doc at docs/requirements/decisions/milestone-triggered-gate-mode-default-decision.md that renders with an explicit "Decision:" line stating the recorded verdict (e.g. "Decision: KEEP default `observe`; do NOT auto-default milestone-triggered stories to `enforce` in this story"), a "Status: Accepted" header, a dated rationale, and a "Blast radius" section. The doc explicitly: (1) states the current default is `observe` (config.ts:60, resolved at phase-gates.ts:129 `loadConfig(ctx.root).proofStory?.[key] ?? 'observe'`), (2) explains that strict-DONE blocking only fires under `enforce` (proofstory.ts `blocking = mode === 'enforce' && gaps.length > 0`, evaluateDoneIntentEquivalence ~L1387 and evaluateReviewCompleteness ~L1442), (3) records that no per-story / milestone-triggered gate-mode override mechanism exists today (only global config keys devGateMode/reviewGateMode/doneGateMode), so a milestone-triggered `enforce` default would be a wide-blast-radius behavior change requiring its own dev story, and (4) names the follow-up condition/story that would revisit an opt-in `enforce`. The doc closes findings M3 and M7 by cross-referencing them by id. Operator running `grep -n "Decision:" docs/requirements/decisions/milestone-triggered-gate-mode-default-decision.md` sees the verdict line, and `grep -n "?? 'observe'" packages/main/src/handlers/phase-gates.ts` still returns line 129 (default unchanged — no blind flip).
Files — create: docs/requirements/decisions/milestone-triggered-gate-mode-default-decision.md

## CHK-010 Reconcile the milestone_status vs DONE-gate stale-evidence disagreement and the closeout second-gate divergence

B-b550 M7 follow-up item 4 (the completeness-critic's two MAJOR holes). (1) milestone_status demotes stale milestone evidence (row -> groups.current, statusDetail=stale), but evaluateDoneIntentEquivalence (packages/main/src/handlers/phase-gates.ts; milestone coverage resolved via evidenceCoversIntent) can still pass the SAME stale ledger — the two surfaces give contradictory verdicts on identical stale evidence. (2) captureMilestoneCloseoutSnapshotFromStore (packages/main/src/handlers/milestone-status.ts, invoked from the DONE transition in transition-orchestrator.ts, phase==='DONE') acts as an undesigned second DONE gate with divergent throw semantics vs the designed evaluateDoneIntentEquivalence gate: a legitimately shrunk / non-applicable-but-risky confirmed ledger makes the designed gate pass while the closeout builder throws, blocking DONE. Reconcile so (a) milestone_status freshness and the DONE gate agree on stale milestone evidence, and (b) closeout capture is not a divergent second gate — with a recorded decision + tests. Design-decision + code; closes findings M7 follow-up item 4.

User sees: Two concrete, observable changes plus a recorded decision doc.

(a) Stale-evidence agreement. With a milestone-triggered story whose confirmed ledger's required verificationIntentRef has a PASS evidence row bound to an OLD headHash/materialHash (git HEAD has since advanced), the operator now sees BOTH surfaces agree:
- `lattice milestone_status --storyId=B-<id>` still demotes the row out of Completed into Current with `statusDetail` containing `evidence=stale` and a risk like `Verification intent <ref> has stale passing ... evidence ...`.
- `lattice story_advance --storyId=B-<id> --phase=DONE` under `doneGateMode: enforce` now ALSO fails the DONE intent-equivalence gate with:
  `Cannot enter DONE: ProofStory intent equivalence gate did not pass` and a gap line `uncovered_required_milestones ... Required milestone(s) lack passing verification evidence ...` listing that milestone id (previously this gate PASSED on the same stale ledger — the contradiction is gone). Re-running the evidence against the current binding clears both.

(b) Closeout no longer a divergent second DONE gate. For a confirmed ledger that legitimately passes the designed gate but whose milestone_status report is incomplete/risky (e.g. a row removed by a user-confirmed scope_shrinkage_decision, or a risky `not_applicable` row), the operator now sees DONE COMPLETE:
- `✓ milestone closeout snapshot captured for B-<id>` (or a non-blocking `ℹ milestone closeout captured with caveats: <reason>` line) instead of the transition aborting.
- The transition no longer throws `Cannot create milestone closeout snapshot for B-<id>: ... incomplete milestone rows` / `... milestone report has risks:` AFTER the designed gate already passed. The single DONE verdict is owned by `evaluateDoneIntentEquivalence`; the closeout step is a recorder that never blocks DONE.

A decision doc at docs/requirements/decisions/milestone-status-done-gate-reconciliation.md records: which surface is authoritative on stale milestone evidence (the shared freshness predicate, made freshness-aware on the gate side to match milestone_status), and that milestone closeout capture is a non-gating recorder subordinate to the designed DONE gate.
Files — modify: packages/main/src/core/proofstory.ts, packages/main/src/handlers/phase-gates.ts, packages/main/src/handlers/milestone-status.ts, packages/main/src/handlers/transition-orchestrator.ts, packages/main/tests/milestone-status.test.mjs; create: docs/requirements/decisions/milestone-status-done-gate-reconciliation.md, packages/main/src/tasks/milestone-done-gate-reconciliation-smoke.ts; test: packages/main/src/tasks/milestone-done-gate-reconciliation-smoke.ts, packages/main/tests/milestone-status.test.mjs
