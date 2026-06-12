# B-cd1e Plan: DONE Closure Runbook Assistant

## CHK-001 Expose DONE closure runbook from existing DONE pre-check data

Implement a focused read-only CLI surface named `done_closure`.

The handler should live near session/lifecycle observability code and must call the existing `buildDoneChecklist(storyId, store, root)` from `core/done-oracle.ts`. It should not reimplement branch sync, delivery-check, summary, validation, bug, freshness, declared artifact, or related-doc rules.

Expected output:
- text mode: a concise runbook that states whether local DONE can be attempted, then lists failed/warn/pass rows and next commands.
- json mode: a stable object with storyId, phase, canAttemptDone, blockers, localNonAuthorityAudit, and authorityServerPath.

`canAttemptDone` is true only when all blocking DONE rows pass. Warnings such as relatedDocs advisory remain visible but non-blocking.

## CHK-002 Separate localNonAuthorityAudit from authorityServerPath in output

Add explicit output sections:

- `localNonAuthorityAudit`: local lifecycle/audit projection only.
- `authorityServerPath`: receipt-backed Authority status projection only.

For this story, the implementation should not verify new receipts or submit evidence. The default Authority projection should be conservative: required false unless existing Authority refs/config demand otherwise, receiptVerified false, receiptRefs empty, mayClaimAuthorityDone false.

The text output must say local DONE readiness is not Authority DONE readiness. It must not use `receiptVerified`, `authorityDone`, `productionDone`, or `fullAuthorityDone` as local success claims.

## CHK-003 Register process-fact and command contracts consistently

Wire the command through:

- CLI schema in `cli-engine.ts` with `--storyId`, `--json`, and `--format` support consistent with existing commands.
- Handler registry in `registry.ts`.
- Command policy as read-only lifecycle observability, not gate evidence.
- Process fact registry/levels as L0 read-only lifecycle observability.
- `scripts/verify-process-fact-contract.mjs` if needed by registry semantics.

Do not change `delivery_check_set`, `summary_set`, or `story_advance DONE` ownership semantics.

## CHK-004 Add regression coverage for TEST PASS not equal DONE

Add focused smoke coverage proving:

1. A TEST story with passing validation evidence but missing delivery-check and summary is reported by `done_closure` as not DONE-ready.
2. The output includes delivery-check and summary blockers from the same DONE oracle rows.
3. localNonAuthorityAudit does not claim Authority completion.
4. authorityServerPath cannot claim receipt-backed Authority completion without verified receipt refs.
5. The command is read-only: it does not create delivery-check.json, summary.json, test evidence, review evidence, or phase transitions.

Minimum verification:

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:flow-stability-smoke
node packages/main/dist/tasks/done-preflight-smoke.js
npm --prefix packages/main run test:field-regression-cli-smoke
node scripts/verify-process-fact-contract.mjs
```

Authority smoke commands are required only if Authority receipt fields or command surfaces are changed.
