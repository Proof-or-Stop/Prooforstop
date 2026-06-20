# B-bd45 Real-Machine Transcript Diff

## Expected

`lifecycle_check` provides a read-only proof-or-stop readiness report for REVIEW, TEST, and DONE. It should:

- produce a `StoryReadinessReport` without mutating story metadata;
- reject `runCommands:true` and `writeEvidence:true`;
- classify missing, stale, blocking, manual, and external proof without claiming Authority completion;
- print exact next actions for host-owned blockers;
- remain registered in the CLI/process-fact contract as read-only L0, not gate evidence.

## Actual

Commands run from `/Users/jek/Documents/Work/Orchestrate/.worktrees/B-bd45` on 2026-06-20:

- `node packages/main/dist/cli.js lifecycle_check --storyId=B-bd45 --target=DONE`
  - PASS as a read-only command.
  - Reported `mode: read-only`.
  - Reported `authorityDone: false`, `fullAuthorityDone: false`, `productionDone: false`.
  - Reported accurate remaining blockers before final closure: stale DONE-required validation, missing delivery check, missing summary, and missing done_prepare report.
  - After review escalation host verdicts, reported review escalation and review assurance floor as PASS with `full-3x2`.
- `npm --prefix packages/main run test:lifecycle-check-smoke`
  - PASS.
  - Covered JSON/text shape, `json:true` vs `format:"json"`, no-mutation behavior, blocker rows, localReady predicate, and fail-closed execution/write flags.
- `npm run test:process-fact-contract`
  - PASS.
  - Confirmed `lifecycle_check` is registered in the process-fact registry and the contract scans `packages/main/src/cli/command-catalog.ts`.
- `lattice validate --story=B-bd45 --json`
  - PASS.
  - Ran 17 configured validation commands.
  - Verification coverage: 9/9 covered, 0 required missing.
- `lattice done_required_validate --storyId=B-bd45 --json`
  - PASS after process-fact contract correction.
  - Included `packages/main build` and root `npm test`.
- Round 3 reviewer lanes:
  - `lattice-review-concept`: PASS (`B-bd45:RR-009`, `B-bd45:RP-004`).
  - `lattice-review-quality`: PASS (`B-bd45:RR-010`, `B-bd45:RP-005`).
  - `lattice-review-test-coverage`: PASS (`B-bd45:RR-011`, `B-bd45:RP-006`).
- Review escalation:
  - PASS with three local rounds and two independent host verdicts per round.
  - `review_escalation_status` reported `assuranceLevel: full-3x2`.

## Diff

No product-behavior difference from expected. The V1 command remains read-only and proof-or-stop, and the additional process-fact contract fix prevents the command from drifting outside the registry/CLI schema contract.

Known boundary: V1 intentionally does not run commands, write evidence, advance phases, or claim Authority/production completion. It reports Authority as external wait only.
