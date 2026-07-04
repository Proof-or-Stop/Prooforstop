# B-bfba Execution Plan

## Objective

Add a stable DONE milestone closeout snapshot and read-only reporting surface. Keep `milestone_status` as the live freshness diagnostic. The closeout snapshot represents the accepted closure state and must not fabricate success from incomplete or risk-bearing milestone rows.

## CHK-001 Define DONE milestone closeout snapshot schema and read semantics

- Add core types for `proofbound.milestone_closeout.v1`.
- Add a pure helper that converts a completed `MilestoneStatusReport` into a closeout snapshot.
- Include `milestoneId`, `status`, `solvedProblem`, `acceptance`, `evidence`, `risks`, `nextAction`, source report digest, and binding hashes.
- Refuse snapshot creation when milestones are not all completed or when report risks are present.
- Add focused tests for happy, later-live-stale preservation, and risk-bearing refusal.

## CHK-002 Capture closeout snapshot during DONE advancement

- Locate the DONE advancement path that already has access to story store and current evidence binding.
- Generate the closeout snapshot before DONE metadata/merge/version effects can stale the live report.
- Write `.lattice/story/actives/<storyId>/milestone-closeout.json` only when a milestone ledger exists and the report is complete/risk-free.
- If no milestone ledger exists, do not block DONE; leave a clear non-applicable reason for the reporting command.
- Add tests around write/skip/refuse semantics without rewriting the full lifecycle.

## CHK-003 Expose stable closeout reporting to users and hosts

- Add a read-only `milestone_closeout` command with text and JSON output.
- Text output must include columns: Milestone, Status, Solved Problem, Acceptance, Evidence, Risks, Next Action.
- Missing snapshot returns a clear diagnostic and next action.
- Reject mutation-like flags before reading story facts.
- Document the distinction between live `milestone_status` and historical `milestone_closeout` in `docs/CLI.md`.

## Verification

- `npm --prefix packages/main run build`
- `node packages/main/tests/milestone-status.test.mjs`
- CLI smoke for text/JSON closeout output and negative unknown/mutation-like flags.

## Non-goals

- Do not change live `milestone_status` freshness semantics.
- Do not edit `README.md`.
- Do not claim Authority, fullAuthorityDone, or production readiness.
