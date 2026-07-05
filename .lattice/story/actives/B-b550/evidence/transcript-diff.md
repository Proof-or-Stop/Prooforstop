# B-b550 real-machine transcript & diff (TEST-phase user acceptance)

Rhythm: expected (PLAN / findings-report claim) → run on real machine → actual → diff.
Story is document-review-only; "user value" = a reader can reproduce the review's
load-bearing claims and the deliverables are internally consistent. All checks were
re-run live in the worktree `/Users/jek/Documents/Work/proofbound/.worktrees/B-b550`.

## V0. Engineering validation

- Expected: `lattice validate` passes (build via `tsc`, `milestone-status.test.mjs`, 9 smokes).
- Actual: `✓ Project validation commands passed` (11/11 commands green); `test-evidence.json` result = **PASS**, materialHash `b44f56d4dfdadd46…`.
- Diff: none.

## V1. milestone_status is a read-only observer (findings M1)

- Expected: output header `Mode: read-only`.
- Command: `lattice milestone_status --storyId=B-b550`
- Actual: `Mode: read-only`.
- Diff: none.

## V2. Reviewed source version (findings M0 correction)

- Expected: worktree source `0.3.159` (not the installed binary's `0.3.160`).
- Command: read `package.json` + `packages/main/package.json`.
- Actual: `root=0.3.159 main=0.3.159`.
- Diff: none — M0 correction reproduces.

## V3. Withdrawn duplicate-row coverage claim (findings M5 correction)

- Expected: 0 hits for `duplicat*` in the intent-hardening smoke.
- Command: `grep -ic 'duplicat' packages/main/src/tasks/proofstory-intent-hardening-smoke.ts`
- Actual: `0`.
- Diff: none — the fabricated coverage claim is correctly withdrawn.

## V4. Strict-DONE gated on doneGateMode=enforce (findings M3 correction)

- Expected: `blocking = mode === 'enforce' && gaps.length > 0` (not unconditional).
- Command: `grep -n "blocking = mode === 'enforce'" packages/main/src/core/proofstory.ts`
- Actual: matches at lines 1387 and 1442.
- Diff: none — M3 correction reproduces.

## V5. Plan Status columns fully updated (findings M7 / deliverable)

- Expected: zero `| planned |` Status cells remaining in the plan doc.
- Command: `grep -c '| planned |' docs/requirements/decisions/milestone-ledger-status-review-and-hardening-plan.md`
- Actual: `0`.
- Diff: none.

## Acceptance self-check

1. Does it do what the story promised? Yes — the M0–M7 review is executed, corrected by an independent takeover audit, and the plan/NAV deliverables are landed.
2. Would a reader be misled? No — every reproduced claim matches; the fabricated/overstated claims from the first draft were corrected, not shipped.
3. Real-machine run vs expected? Ran; actual == expected on all of V0–V5.
4. Any silent gap? The 6 design-hardening gaps are explicitly recorded as a proposed follow-up in M7, not hidden.
5. Scope honored? Docs-only; `packages/main/src/**` and `packages/main/tests/**` untouched (scope-contract enforce).
