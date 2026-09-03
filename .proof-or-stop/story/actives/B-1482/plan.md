# Plan: B-1482 Narrowing-only re-pin of a verification selector, with the selector persisted on every receipt

All Proof-or-Stop commands run from the worktree `.worktrees/B-1482` with that worktree's own build: `node packages/main/dist/cli.js`. Rebuild with `npm --prefix packages/main run build` after every source change before running the smoke or any evidence command. Commit subjects use `RED(CHK-nnn): ...` / `GREEN(CHK-nnn): ...` and `RED(F-nnn): ...` / `GREEN(F-nnn): ...`; a fix that legitimately has no failing fixture carries a `No-RED: <reason of at least thirty characters>` body line. Everything is English and carries no host names or attribution trailers.

This story edits an evidence gate that DONE consumes, so every change fails closed: where the narrowing proof cannot be made from recorded receipts, the re-pin is refused. One smoke file, `packages/main/src/tasks/narrowing-repin-smoke.ts`, holds all cases and prints one line per case, ending `narrowing-repin-smoke: PASS` or `narrowing-repin-smoke: FAIL` with a non-zero exit. Its default output stays under 11000 characters, because the verification executor truncates a command's output at 12000 characters before matching a selector.

## CHK-001: Persist the selector text on every verification receipt and expose it in checklist_get

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/types.ts, packages/main/src/handlers/checklist.ts
- Create: packages/main/src/tasks/narrowing-repin-smoke.ts
- Test: packages/main/src/tasks/narrowing-repin-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/narrowing-repin-smoke.js` ends `narrowing-repin-smoke: PASS`
- `checklist_get --storyId=B-1482 --json` shows the selector text on a receipt written after the change

**DoneWhen**:
- `VerificationExecutionReceipt` (core/types.ts, currently at line 974) gains the selector text the run was judged against, documented like its siblings, and handlers/checklist.ts stamps it where it stamps `selectorMatched` (currently line 816)
- The field lives inside the tool-owned receipt block, which every caller-facing schema strips; a case passes a forged selector through `verification_evidence_add` and asserts the stored value is the one actually executed against
- A receipt written before this change (no selector field) still loads and renders; a case constructs one and asserts no consumer assumes the field
- RED commit: the cases above committed failing against the current shape

## CHK-002: Add a narrowing-only re-pin proved from recorded receipts, bounded to one per recorded-receipt set

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/checklist.ts, packages/main/src/core/verification.ts
- Test: packages/main/src/tasks/narrowing-repin-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/narrowing-repin-smoke.js` ends `narrowing-repin-smoke: PASS`
- The accepted case prints both pins, the reason and the cited receipt ids; each refusal case prints its own reason

**DoneWhen**:
- A re-pin is accepted only when, using ONLY receipts the tool recorded for the same pinned command: the new selector is absent from the outputTail of at least one recorded receipt that the old selector matched while that run was failing, and the new selector matches every recorded passing receipt. The acceptance message states that absence was asserted within the retained outputTail
- The old pin, the new pin, the receipts on both sides, a caller-supplied reason and the ids of the receipts the proof used are all retained and visible
- A set of recorded receipts admits at most one narrowing; a second narrowing against unchanged receipts is refused naming the bound
- Refusals, each with its own message and its own case: a loosening selector; no recorded failing render; a selector absent from a recorded passing receipt; a second narrowing against an unchanged set
- No caller-supplied transcript or output is an input; a case passes one and asserts it is rejected rather than considered
- A case replays the B-a745 CHK-005:happy:0 shape end to end: a selector printed on every branch, a recorded failing receipt whose tail lacks the status discriminator, and a re-pin to that discriminator accepted
- RED commit: every case above committed failing before the implementation

## CHK-003: Record the decision and document the rule, then register the suite

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-002
**Files**:
- Modify: CLAUDE.md, package.json, packages/main/src/tasks/full-suite-runner.ts, proof-or-stop.config.json
- Create: docs/requirements/decisions/narrowing-only-evidence-repin.md
- Test: packages/main/src/tasks/narrowing-repin-smoke.ts

**Verify**:
- `npm run test:narrowing-repin` ends `narrowing-repin-smoke: PASS`
- `grep -n narrowing-repin package.json packages/main/src/tasks/full-suite-runner.ts proof-or-stop.config.json` shows all three registrations

**DoneWhen**:
- CLAUDE.md's Verification Intent / Evidence section states: the narrowing-only rule, that the proof reads only tool-recorded receipts, the one-narrowing-per-recorded-receipt-set bound, every refusal case, and the engineered-failing-run limitation as either a named bound or an accepted limitation
- No documentation text claims the engineered-failing-run case is mechanically excluded; a case greps for that overclaiming phrasing and asserts its absence
- The decision (already recorded at PLAN) carries at least four pre-mortems including the engineered-failing-run gap
- A decision document `docs/requirements/decisions/narrowing-only-evidence-repin.md` states the invariant and its one exception. The PLAN scope review found that the B-ec67 evidence-pin immutability invariant this story changes is stated nowhere in `docs/requirements/decisions/`, only in code comments and CLAUDE.md, so the change would otherwise land with no decision record. The document states: what immutability protects and why loosening stays refused; the narrowing-only exception and its inputs; the one-narrowing-per-recorded-receipt-set bound; every refusal case; and the engineered-failing-run limitation named as a bound or accepted
- The suite is registered in `test:serial-reference`, the full-suite runner's RESOURCE_POLICY and `proof-or-stop.config.json` validate.commands, copying the shape of a sibling entry, and a case reads those real files to assert it
