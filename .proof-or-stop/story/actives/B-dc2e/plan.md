# Plan: B-dc2e Make four checks that look green actually bite

All Proof-or-Stop commands run from the worktree `.worktrees/B-dc2e` with the worktree's own build: `node packages/main/dist/cli.js`. Rebuild with `npm --prefix packages/main run build` after every source change before running a smoke or any evidence command. Commit messages are English only, carry no AI-host names or attribution trailers, and use the subject forms the CHK-003 guard enforces: `RED(CHK-nnn): ...` / `GREEN(CHK-nnn): ...` for checklist items and `RED(F-nnn): ...` / `GREEN(F-nnn): ...` for finding fixes, with the documented no-RED marker in the body when a fix legitimately has no failing fixture. Every smoke's default output stays under 11000 characters.

The four items write to four disjoint files and have no dependencies on each other, so they are dispatched to four fresh implementers in parallel. Each item ships its mutation committed failing (RED) before the fix (GREEN).

## CHK-001: Fix the orphan validation-protocol smoke and register it in all three canonical inventories or delete it deliberately

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/tasks/validation-protocol-smoke.ts, package.json, packages/main/src/tasks/full-suite-runner.ts, proof-or-stop.config.json
- Test: packages/main/src/tasks/validation-protocol-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/validation-protocol-smoke.js` ends with its PASS line
- `grep -n validation-protocol package.json packages/main/src/tasks/full-suite-runner.ts proof-or-stop.config.json` shows the suite in test:serial-reference, RESOURCE_POLICY and validate.commands

**DoneWhen**:
- RED commit: a case (or the existing assertion) demonstrably fails on this checkout (`CASE_MISMATCH` expected, `undefined` actual) and a case asserts that no inventory references the smoke
- The root cause is decided and stated in the GREEN commit body: either runManagedAssetCheck does not detect a case-only filename mismatch on a case-insensitive filesystem (fix the detection) or the assertion is wrong (fix the assertion); the fix is filesystem-aware or skips with an explicit printed reason
- The smoke is registered in the three inventories (copy the shape of a sibling entry such as validation-tier-planner-smoke)
- A sweep case lists every `packages/main/src/tasks/*.ts` file with no reference in package.json scripts, RESOURCE_POLICY or validate.commands and asserts each is classified: registered, deleted (with the deletion recorded in the commit body), or kept-unregistered with a printed reason; observability-snapshot-smoke.ts (fails on main: its rendered-text regex expects `proofOrStop.observability_snapshot.v1` while the renderer prints `lattice.observability_snapshot.v1`) must be classified, and if kept it must be fixed or deleted, never left failing and orphaned

## CHK-002: Give the full-suite membership smoke a real-data case that fails on genuine chain-versus-policy drift

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/tasks/full-suite-runner-smoke.ts
- Test: packages/main/src/tasks/full-suite-runner-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/full-suite-runner-smoke.js` prints the two real-inventory `[PASS]` lines named in the item's userSees and ends with its PASS line

**DoneWhen**:
- RED commit: a case reads the REAL package.json `test:serial-reference` and `test:serial-reference-prefix` chains and the REAL RESOURCE_POLICY (import from full-suite-runner.ts, do not copy), evaluates membership, then removes one real RESOURCE_POLICY row on a scratch copy and asserts membership FAILS naming the row; it is committed failing because the current smoke has no such case (or the mutation passes)
- GREEN: the case passes on the real tree (both chains evaluated so prefix members are not stalePolicy) and fails on the scratch mutation
- The synthetic `test:a` / `test:b` cases are unchanged and still pass

## CHK-003: Extend the RED-before-GREEN guard to finding-fix commits with a marker for legitimate no-RED fixes

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/red-green-commit-guard.ts
- Modify: packages/main/src/tasks/validation-tier-planner-smoke.ts
- Test: packages/main/src/tasks/validation-tier-planner-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/validation-tier-planner-smoke.js` prints the guard `[PASS]` line named in the item's userSees and ends with its PASS line
- On a scratch branch (temp clone) where a `RED(F-nnn):` commit is squashed into its `GREEN(F-nnn):`, the helper reports a failure naming the id

**DoneWhen**:
- `core/red-green-commit-guard.ts` exports a pure function over a list of commit subjects and bodies (no git I/O inside) that derives CHK-nnn and F-nnn ids from subjects of the forms `RED(CHK-nnn):`, `GREEN(CHK-nnn):`, `RED(F-nnn):`, `GREEN(F-nnn):`, requires a RED before each GREEN for the same id, and accepts a GREEN without RED only when the body carries the documented marker `No-RED: <reason>` with a reason of at least 30 characters; the marker name and format are documented in the helper's header comment
- validation-tier-planner-smoke.ts calls the helper for main..HEAD (git I/O stays in the smoke) and keeps its existing CHK behaviour for checklist items
- RED commit: fixture subject lists covering (a) GREEN(F-nnn) without RED, (b) squashed RED into GREEN, (c) marker without reason, (d) marker with reason, committed failing before the helper exists
- The story's own commits follow the enforced formats so the guard passes on this branch

## CHK-004: Persist host B's parsed findings from cross_host_review as structured evidence

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/cross-host-review.ts
- Test: packages/main/src/tasks/cross-host-review-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/cross-host-review-smoke.js` prints the `[PASS] host B findings persisted ...` line named in the item's userSees and ends with its PASS line

**DoneWhen**:
- RED commit: a smoke case drives cross_host_review with a stubbed host B that returns a FAIL verdict with two findings and asserts their title, severity, file and description appear in the persisted verdict JSON; committed failing because today only stdoutDigest and findingCount are written
- GREEN: writeCrossHostVerdictPair persists a bounded `findings` array (each field capped to a documented length; count capped) for both hosts; a PASS verdict persists an empty array; the CLI `--json` output exposes the same array
- Raw provider stdout is never persisted: the smoke plants a sentinel string in the stubbed host output and asserts it is absent from the verdict JSON and from every file under the story directory after the run
- Whether findings are ALSO registered through finding_add with the host as agent is decided in the GREEN commit body; if yes, the smoke asserts the finding ids; if no, the body says why (for example: the verdict artifact is the durable record and finding_add would double-count in review gates)
