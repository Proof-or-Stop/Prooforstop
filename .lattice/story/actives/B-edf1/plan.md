# Plan — Surface the storyFilesHash drift advisory on the DONE Review-escalation pass path

A Codex host-2 review of merged B-5a9a found that the mandatory whole-tree-drift
re-attestation advisory (recorded when a host verdict is downgrade-accepted
because storyFilesHash matches despite materialHash drift) is dropped on the DONE
success path. Surface it; keep the row a PASS. Only `done-oracle.ts` (the render)
changes, plus one smoke. Do NOT touch the downgrade-accept logic.

## CHK-001

Surface `escalation.advisories` on the DONE Review-escalation PASS path in
`packages/main/src/core/done-oracle.ts` (the `doneCheckRow({ id: 'review-escalation' })`,
~706-713).

- When `escalation.ok === true` AND `escalation.advisories?.length`, append the
  advisories to the row **detail** (NOT the hint). `renderDoneChecklist` (~868)
  only expands the hint for `warn`-status rows and the user-value-summary row, so a
  PASS row prints only `detail` — the advisory must live in `detail` to be visible.
- Keep `status` (`escalation.ok ? 'pass' : 'fail'`) and `blocking` unchanged — the
  downgrade-accepted verdict is valid by design; this is visible-advisory, not a
  block.
- Append only when advisories are non-empty (no advisory text on a clean DONE).
- Verify `renderDoneChecklist` actually prints the appended detail on the pass row.
  Confirm `machine.ts` (~882) needs no change for operator visibility (it returns a
  failure reason only on `!ok`; the operator-visible surface is the rendered DONE
  checklist). If a genuinely operator-visible pass-path surface exists there, surface
  it too; otherwise leave machine.ts unchanged.

User sees: a downgrade-accepted DONE shows the Review-escalation row as PASS with the
re-attestation advisory in its detail; a no-drift DONE shows the row PASS with no
advisory text.

## CHK-002

Add a smoke at `packages/main/src/tasks/done-escalation-drift-advisory-smoke.ts`
(auto-discovered) + npm wiring:

- **Advisory-visible case:** build the DONE checklist (drive the real `done-oracle`
  render) for a story whose escalation report has a downgrade-accepted host verdict
  (materialHash drift + matching storyFilesHash) → assert the rendered Review-escalation
  row is PASS AND its printed text CONTAINS the re-attestation advisory.
- **Control:** no drift → the row is PASS AND contains NO advisory text.

Prefer driving the real `renderDoneChecklist` output (not just the row object) so the
test proves operator visibility.

User sees: `node packages/main/dist/tasks/done-escalation-drift-advisory-smoke.js`
prints its checks and exits 0; full `npm test` exits 0 with the new smoke in the chain.

## Verification approach

One DEV commit (the render change + the smoke); build tsc-clean; run the new smoke;
full `npm test` green; ONE review round (claude 3 lanes + codex host-2); high-risk
(DONE-gate) review-assurance floor via genuine full-3x2; `recover_evidence`; TEST →
DONE (the DONE merge auto-bumps the version + auto-rebuilds dist — do NOT do those
manually).
