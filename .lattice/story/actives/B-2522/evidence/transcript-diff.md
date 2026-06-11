# B-2522 Transcript Diff

Story: B-2522
Phase: TEST
Recorded by: Codex PM/verifier
Recorded at: 2026-06-02

## Expected

The user-visible validation transcript should show:

- `npm run test:authority-enforce-matrix` prints local/off PASS, shadow warning PASS, enforce fake-server receipt PASS, enforce no-server runner fail-closed PASS, and `parallel_report productionDone=false PASS`.
- `npm run test:authority-live-python` exits successfully and self-skips unless `KOALA_AUTHORITY_LIVE_URL` and `KOALA_AUTHORITY_LIVE_PUBLIC_KEY` are configured.
- Existing authority and Parallel Wave regression smokes still pass.
- `lattice validate --story=B-2522 --json` reports all verification intents covered, with no missing required evidence.

## Actual

Commands run by Codex verifier:

```text
npm --prefix packages/main run build
npm run test:authority-enforce-matrix
npm run test:authority-live-python
npm run test:authority-status-smoke
npm run test:authority-enforce-runner
npm run test:authority-runner-events
npm --prefix packages/main run test:lattice-parallel-wave-smoke
npm run test:authority-evidence-flow
npm run test:authority-runner-contracts
npm run test:authority-boundary-smoke
npm run test:authority-receipt-classification
lattice validate --story=B-2522 --json --forceTakeover
```

Observed user-visible lines:

```text
authority enforce matrix smoke passed: local/off PASS; shadow warning PASS; enforce fake-server receipt PASS; enforce no-server runner fail-closed PASS; parallel_report productionDone=false PASS
authority live Python smoke skipped: set KOALA_AUTHORITY_LIVE_URL and KOALA_AUTHORITY_LIVE_PUBLIC_KEY to run
✓ authority status readiness smoke passed
✓ authority enforce runner smoke passed: dry-run planned register/heartbeat/claim without provider execution
✓ authority runner events smoke passed: stdout/completed/failed events are signed and transcript-bound
✓ lattice parallel wave smoke passed
authority evidence flow smoke passed (CHK-001 scaffolding + CHK-002 Blockers 1+2 + CHK-003 shadow Blocker 3 + CHK-004 enforce Blocker 4)
✓ authority runner contracts smoke passed: deterministic canonicalization, sign/verify, and L2+ boundary preserved
✓ authority boundary smoke passed: CLI evidence is local/shadow/thin-client, not receipt-backed L2+ authority
✓ authority receipt classification smoke passed: receiptVerified=true klass=receipt-backed-l2-plus only after signed receipt verification
Verification intent coverage: 6/6 covered (0 required missing)
```

## Diff

No material difference from the expected outcome.

One expected environment-dependent behavior occurred: the live Python smoke self-skipped because the live authority URL and public key environment variables were not configured in this local test environment. That is the intended local fallback behavior for B-2522 CHK-002.

## Notes

The first `lattice validate` run before CHK-002 evidence recording failed with 3 missing CHK-002 verification intents. That was corrected by recording the three CHK-002 verificationEvidence entries and refreshing stale CHK-001 evidence after commit `f099fe5eb85150d9dd28d810a2ac2421d41a4dd8`; the final validation passed with 6/6 coverage.
