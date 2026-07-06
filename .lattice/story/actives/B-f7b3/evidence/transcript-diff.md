# B-f7b3 real-machine transcript & diff (TEST-phase user acceptance)

Rhythm: expected (PLAN outcome) → run on real machine → actual → diff. All re-run live in
the worktree `/Users/jek/Documents/Work/proofbound/.worktrees/B-f7b3` against the built dist.

## V0. Engineering validation
- Expected: `lattice validate` passes; the milestone-status suite + smokes green.
- Actual: build (tsc) clean; `node packages/main/tests/milestone-status.test.mjs` → `ok milestone-status`; `proofstory-intent-hardening-smoke` → passed; `milestone-done-gate-reconciliation-smoke` → OK.
- Diff: none.

## V1. Observability disclaimer renders (CHK-001)
- Expected: milestone_status/closeout output shows an explicit observability-only disclaimer after `Mode: read-only`.
- Command: `node packages/main/dist/cli.js milestone_status --root <fixture> --storyId B-f7b3`
- Actual: `Scope: observability only - reports milestone progress from the ProofStory ledger. This is NOT a lifecycle DONE, NOT an Authority verdict, and NOT a production-readiness gate.`
- Diff: none. (Note: the delivered line uses the `Scope:` prefix, not `Disclaimer:`; the verification intents were corrected during the story to assert the actual delivered wording.)

## V2. Authority in milestone_status command-policy reason (CHK-002)
- Expected: `milestone_status` reason discloses Authority like `milestone_closeout`.
- Command: `node -e "…getCommandPolicy('milestone_status').reason…/Authority/"`
- Actual: `present` (reason now ends "…never claims automatic DONE, production, or remote Authority readiness.").
- Diff: none.

## V3. Ledger-hash backward compatibility (CHK-007/008 hash-safety)
- Expected: B-f7b3's confirmed milestone ledger hash is UNCHANGED by the new optional `notApplicableDecision` field (legacy no-field rows keep the same hash).
- Command: `lattice milestone_ledger_get --storyId=B-f7b3 --json`
- Actual: `sha256:68173e86…` (matches the pre-registered value).
- Diff: none.

## V4. Self-referential DONE-gate safety (CHK-010)
- Expected: B-f7b3's own DONE gate stays non-blocking under the default `observe` mode (the new stale/vacuous diagnostics must not newly block).
- Command: `lattice done_intent_equivalence_check --storyId=B-f7b3`
- Actual: `Blocking: no`.
- Diff: none.

## V5. Gate-mode default pinned to observe (CHK-009 regression test)
- Expected: the committed reconciliation smoke's "(c) gate-mode DEFAULT pins to 'observe'" block passes against the real `configuredProofStoryMode` resolver, and would fail if the `?? 'observe'` fallback were flipped to `enforce`.
- Command: `node packages/main/dist/tasks/milestone-done-gate-reconciliation-smoke.js`
- Actual: `milestone-done-gate-reconciliation-smoke: OK` (un-gameability independently reproduced by two review lanes: flipping to `enforce` makes it fail).
- Diff: none.

## Acceptance self-check
1. Does it do what the story promised? Yes — all six M7 hardening items delivered (disclaimer, Authority string, 3 negative-control tests, suite wiring, not_applicable justification field+policy, confirm-time hash re-check, gate-mode-default decision, stale-evidence/closeout reconciliation).
2. Would a reader be misled? No — the read-only + PLAN-only contract is intact; disclaimers explicitly disclaim DONE/Authority/production; the gate-mode decision is recorded not silently flipped.
3. Real-machine run vs expected? Ran; actual == expected on V0–V5.
4. Any silent gap? No — a real vacuous-confirmed-ledger gap (CHK-004) was found and guarded (`empty_confirmed_milestone_ledger`); the auto-drafted verification-intent drift was corrected to truthfully verify the delivered behavior.
5. Scope honored? Diff limited to packages/main + 3 decision docs; no production/deploy/infra; the read-only/PLAN-only contract preserved.
