# Plan: B-edca validate/test-evidence stale loop

## CHK-001 Reproduce and localize the stale advisory loop

Investigate the two freshness surfaces that disagreed during B-1148:

- session/stale hint rendering in `packages/main/src/core/evidence-stale-hint.ts` and `packages/main/src/handlers/session.ts`
- verification evidence refresh in `packages/main/src/handlers/checklist.ts`
- material hash calculation in `packages/main/src/core/evidence-freshness.ts` and runtime artifact classification in `packages/main/src/core/runtime-artifact-registry.ts`

Expected output: a short evidence note explaining the root cause and identifying whether `test-evidence.json` is included in the material hash path.

## CHK-002 Define the artifact freshness policy for test-evidence.json

Record the policy in the implementation and, only if the current decision docs are missing the distinction, add a small doc note:

- `test-evidence.json` remains gate-consumed validation evidence: PASS/FAIL, timestamp, command output and coverage are still read by gates.
- `test-evidence.json` self-updates should not be treated as material source drift that makes verificationEvidence stale.
- Real source/evidence files must still drift materialHash and produce stale warnings.

Expected output: code comments or docs make this boundary explicit.

## CHK-003 Implement minimal fix in validate/session freshness handling

Implement the chosen option: classify validate-generated `test-evidence.json` as generated validation metadata for material-hash freshness, without removing it from gate consumption.

Likely implementation path:

- update `runtime-artifact-registry.ts` or the material hash exclusion classifier if `test-evidence.json` is currently included in material hash;
- keep `done-oracle.ts` freshness checks reading `test-evidence.json` result and its materialHash;
- avoid UI-only suppression in `session.ts` unless the stale hint is using a separate path.

Expected output: after validate writes `test-evidence.json`, a clean commit of that metadata does not make session_brief display EVIDENCE STALE solely from that file.

## CHK-004 Add regression coverage

Add tests around `packages/main/src/tasks/verification-freshness-smoke.ts` or the nearest existing fixture:

- self-churn case: generated story `test-evidence.json` changed/committed after validate should not make verification evidence stale by itself;
- real drift case: modifying a material source/evidence file still makes stale detection fire;
- failure preservation: FAIL test evidence or missing required evidence still blocks via existing gate tests.

Expected output: a targeted regression fails without the classification fix and passes with it.

## CHK-005 Run lifecycle validation and record evidence

Run and record:

- `npm --prefix packages/main run build`
- targeted freshness smoke/regression test
- `npm run test:process-fact-contract`
- `koala validate --story=B-edca --json`
- a `session_brief` transcript proving the stale-loop advisory is absent for self-churn and still present for real drift, if covered by the regression transcript.

Write concise evidence under `.koala/story/actives/B-edca/evidence/` and attach verificationEvidence to all checklist intents.
