# B-90d6 User-Value Transcript Diff

Date: 2026-07-08
Story: B-90d6
Phase at capture: TEST

## Expected Outcome

Agents and developers should see the next correct lifecycle action without guessing:

- INIT guidance should route through `lattice init_preflight --storyId=<id>` before `story_advance --phase=INIT_CHECK`.
- INIT_CHECK failures should point to `init_preflight` as the prerequisite aggregator, without bypassing evidence or reviewer gates.
- Story-level scope-plan reviewer dispatch should work in PLAN and refuse/redirect outside PLAN instead of advertising a guaranteed-failing `scope_check_save` command.
- `checklist_add` on a ledger-backed story should warn that the milestone ledger may need sync, but must not mutate milestone rows.
- Ledger-backed developer UX should surface a visible `Milestone Status - <storyId>` block automatically for covered commands, while JSON output stays machine-clean.

## Actual Transcript

Commands run from `/Users/jek/Documents/Work/proofbound/.worktrees/B-90d6`:

1. `lattice validate`
   - Result: pass.
   - Actual output summary: all 43 configured validation commands passed, including `npm --prefix packages/main run build`, `node packages/main/tests/milestone-status.test.mjs`, `node packages/main/dist/tasks/init-preflight-smoke.js`, and the lifecycle/delivery freshness smokes.

2. `lattice milestone_status --storyId=B-90d6`
   - Result: pass.
   - Actual user-visible output starts with `Milestone Status - B-90d6`, `Mode: read-only`, `Phase: TEST`, and a confirmed ledger hash.
   - The rendered table shows completed rows for M0, M1, M4-min, and M1-ledger-hint; Current and Remaining are `none`.

3. `node packages/main/dist/cli.js --help`
   - Result: pass.
   - Actual user-visible development flow includes `lattice init_preflight --storyId=B-xxx` before `story_advance --storyId=B-xxx --phase=INIT_CHECK`, with the wording `After preflight READY`.

4. `node packages/main/tests/b90d6-init-dispatch-guidance.test.mjs`
   - Result: pass.
   - Actual output ends with `b90d6-init-dispatch-guidance: ALL PASS`.

5. `npm --prefix packages/main run test:milestone-status`
   - Result: pass.
   - Actual output ends with `ok milestone-status`.

## Outcome Diff

No user-value gap found. Actual output matches the expected outcome:

- INIT guidance is visible before INIT_CHECK.
- Scope-plan dispatch no longer advertises a PLAN-only write in non-PLAN phases.
- Milestone status is visible as read-only UX, not lifecycle DONE, Authority proof, production readiness, or ledger mutation.
- The checklist/milestone sync behavior is advisory only and test-covered.

## Acceptance Verdict

accepted
