# B-be27 User-Visible Acceptance Transcript

## Expected

- `scope_contract_show` displays a configured story scope contract.
- `scope_contract_check --json` reports `pass`, `warn`, or `fail` with changed files and violations.
- REVIEW/TEST/DONE transitions print the scope gate result before phase mutation.
- Allowed files pass, protected/excluded files fail in enforce mode, and acknowledged expansions remain visible as warnings.
- Regression commands prove the behavior mechanically.

## Actual

- `node packages/main/dist/cli.js scope_contract_check '{"storyId":"B-be27","json":true}'`
  returned `status: "pass"` in enforce mode with `28 changed file(s)` and `0 unacknowledged violations`.
- `node packages/main/dist/cli.js story_advance '{"storyId":"B-be27","phase":"REVIEW","forceTakeover":true}'`
  printed `Scope gate: pass (28 changed file(s), 0 unacknowledged violations)` before entering REVIEW.
- `node packages/main/dist/cli.js story_advance '{"storyId":"B-be27","phase":"TEST","forceTakeover":true}'`
  ran REVIEW preflight, validate, and printed the same scope gate pass transcript before entering TEST.
- `npm --prefix packages/main run test:scope-contract-smoke` passed, covering allowed, blocked, shadow, acknowledged, no-contract, unsafe path, invalid mode, protected file, and partial-update preservation cases.
- `node packages/main/dist/cli.js validate '{"story":"B-be27","json":true}'` passed with verification coverage `15/15`.

## Difference

No user-visible gap remains. During review, a partial-update defect was found: omitted optional arrays could be cleared by `scope_contract_set`. It was fixed, covered by smoke test assertions, revalidated, and re-reviewed in a fresh REVIEW round.
