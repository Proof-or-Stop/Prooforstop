# Plan: Restore experience-layer-playbook-smoke to 31/31

## Overview
`experience-layer-playbook-smoke` is silently red at 27/31 on the main baseline; it is excluded from the curated `lattice validate` list, so the four failures never surfaced. There are TWO INDEPENDENT causes, both fixed with test-maintenance only (plus one comment) and NO shipping/runtime behavior change.

Acceptance: `node packages/main/dist/tasks/experience-layer-playbook-smoke.js` from a fresh build prints `TOTAL 31 | PASS 31 | FAIL 0` and `smoke passed`.

## CHK-001 — Widen the playbook.ts import-fence allowlist
### Files
- modify: packages/main/src/tasks/experience-layer-playbook-smoke.ts (the two `allowed` Set literals)
- modify: packages/main/src/handlers/playbook.ts (load-bearing guardrail import comment, lines ~25-28; comment only)

### Change
Add `../core/source-lineage-audit.js` and `../core/playbook-seed.js` to BOTH `allowed` sets: the direct fence check ("handlers/playbook.ts imports only ...") and the non-vacuous planted-import check. Refresh the guardrail comment so it truthfully lists the actual allowed imports (it already omitted `main-write-lock.js`).

### Why widen, not move
`learning-store.ts` has a stricter fence (only `./digest.js` + `./experience-layer-types.js`) and cannot absorb the helpers (`source-lineage-audit` imports `dev-memory.js`; `playbook-seed` imports `playbook-runtime-memory.js`). A barrel indirection would hide the real dependency to satisfy a grep. Both helpers are legitimate experience-layer/learning members and neither is a finding-writer, advisory, or gate.

### Verification
- happy (CHK-001:happy:0): the two import-fence checks print PASS and the suite reaches 31/31.
- adversarial (CHK-001:adversarial:0): the non-vacuous check still flags a planted `./finding.js` (foreign===['./finding.js']); the negative assertion `!/finding.js$|advisory|gate/` still holds.

## CHK-002 — Fix the stale decision_doc_save authorityBoundary assertion
### Files
- modify: packages/main/src/tasks/decision-doc-promotion-smoke.ts (process-event assertion, line ~385)

### Change
Update the expected substring from `not remote receipt completion` (retired by commit 8892270bf, "Align process fact contract with local assurance") to the current committed `not local proof-admissibility, receipt-bundle, quorum, or release readiness`. This clears the `decision-doc-promotion` and `experience-layer-digest-extract` no-regression sub-smokes that the playbook suite runs.

### Verification
- happy (CHK-002:happy:0): decision-doc-promotion smoke prints "decision doc promotion smoke passed" and experience-layer-digest-extract prints "smoke passed"; both no-regression sub-smokes PASS.
- edge (CHK-002:edge:0): the decision_doc_save process-event authorityBoundary contains the current committed substring.

## Out of scope
- No shipping/runtime behavior change; helpers are not moved/refactored; learning-store's fence is untouched.
- The smoke is not added to the curated `lattice validate` list.
- The unrelated tier-c WIP docs on main are not touched.
