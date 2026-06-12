# B-9092 Execution Plan

## Scope

Execute the existing F-009 Layer 2 Engineering proof gap closure plan. The story may produce local proof artifacts, negative-control artifacts, host verdict notes, and a final F-009 status decision. It must not broaden into Layer 3, Production Safety, global capability claims, or Authority Server redesign.

## CHK-001 Freeze F-009 target proof scope

Goal: establish a single target and artifact root before any proof attempt.

Steps:

1. Record current HEAD and materialHash from the B-9092 worktree.
2. Select one clean artifact root under `.lattice/artifacts/baseline/`.
3. Select one suiteRunId for all generated/inspected Layer 2 proof artifacts.
4. Capture the current F-009 finding snapshot from `B-META-framework-audit`.
5. Write `.lattice/story/actives/B-9092/evidence/f009-scope-freeze.json`.

Verification:

- The evidence file names HEAD, materialHash, suiteRunId, artifact root, and F-009 snapshot.
- The artifact root is under `.lattice` and does not use `.omx`.
- The evidence explicitly says local host output is not Authority receipt proof.

Stop condition:

- If the working tree or artifact root is mixed with stale proof, stop and pick a clean root.

## CHK-002 Run formal Layer 2 proof and negative controls

Goal: determine whether current implementation plus fresh artifacts can legitimately unlock Layer 2, or whether F-009 remains a verified gap.

Steps:

1. Repair requirements NAV hygiene if its file count/link set is mechanically stale.
2. Run formal Layer 2 proof commands only against the frozen clean root.
3. Check lower-layer Development proof state.
4. Check all nine ENG baseline final-report requirements.
5. Run `baseline_suite_report --layer=engineering` for the selected root.
6. Run `capability_claim_formal_evaluate --target=engineering` for the selected root.
7. Run negative controls for local-only, stale, forged, wrong-target, wrong-suiteRunId, and Authority-overclaim artifacts.
8. Write `.lattice/story/actives/B-9092/evidence/f009-formal-proof-audit.md`.

Verification:

- If proof is incomplete, the result must be LOCKED/BLOCKED with explicit reasons.
- If proof passes, the result must unlock only Layer 2 Engineering and keep Layer 3, Production Safety, global claim, receiptVerified, productionDone, and fullAuthorityDone locked/false.
- NAV count must match the actual decision markdown count after hygiene repair.

Stop condition:

- Any negative control that returns PASS is a correctness issue and must be fixed or recorded as a verified blocker.

## CHK-003 Collect two-host verdicts and close or retain F-009

Goal: make the final F-009 status honest and auditable.

Steps:

1. Send the frozen artifact root, suiteRunId, HEAD, materialHash, F-009 snapshot, proof audit, and negative-control results to Claude CLI host review.
2. Send the same anchors to Codex CLI host review.
3. Record both verdicts in `.lattice/story/actives/B-9092/evidence/f009-host-verdicts.md`.
4. If evidence proves F-009 resolved or disproven, use `lattice finding_resolve` with source/test/artifact refs.
5. If evidence is insufficient, leave F-009 open or verified and write exact missing proof in `.lattice/story/actives/B-9092/evidence/f009-final-status.md`.

Verification:

- Both host verdicts review the same anchors.
- Host verdicts are localNonAuthorityAudit only.
- Final status does not claim Authority receipt verification, Production Safety, fullAuthorityDone, Layer 3, or global capability.

Stop condition:

- If host verdicts disagree on a high correctness issue, keep F-009 open and record the blocker instead of resolving it.
