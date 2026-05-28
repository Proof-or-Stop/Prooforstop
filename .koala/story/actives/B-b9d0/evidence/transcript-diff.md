# B-b9d0 User Acceptance Transcript Diff

## Expected

- Koala accepts story-scoped lifecycle artifacts such as `delivery-check.json` and `summary.json` without requiring broad TEST-phase scope expansion.
- Unrelated product source files and arbitrary `.koala/*.json` files still fail scope when unacknowledged.
- `convergence_check` returns JSON instead of crashing on derived `.build` or symlink-loop fixtures.
- `session_brief` refuses DONE while scope is blocking, but recommends `delivery_check_set` and `summary_set` when those are the only remaining DONE pre-check failures.

## Actual

- `node scripts/verify-process-fact-contract.mjs` passed and verified the lifecycle artifact classifier, product-source scope protection, and delivery/summary artifact handling.
- `node scripts/verify-gap-convergence.mjs` passed and verified derived directory skipping, symlink-loop safety, and real docs/story visibility.
- `node scripts/verify-session-brief-command-center.mjs` passed in REVIEW and TEST states after repair commit `70aa074f`, including the `delivery_check_set` / `summary_set` next-step path.
- `koala validate --story=B-b9d0 --json` passed with 15/15 verification intents covered.
- `koala check` passed with all managed assets OK.
- `koala convergence_check` returned JSON without ELOOP; `converged=false` only because B-b9d0 was still active at the time of the run.

## Diff

Expected and actual match. The only mid-flight discrepancy was reviewer finding `B-b9d0:F-001`, where the session brief regression script did not accept REVIEW/TEST lifecycle next-step tokens. Claude implementer repaired that in `528cc1e9` and later narrowed the TEST delivery/summary assertion in `70aa074f`; both repairs were revalidated and re-reviewed.

## Limitations

None for the scoped behavior. This story does not claim to remove all future scope policy mistakes; it locks the specific lifecycle artifact, convergence scanner, and session_brief regressions with tests and reviewer evidence.
