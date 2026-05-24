# B-6bfd Plan

## Order
1. CHK-001 extends scope contract schema and validation while preserving v1 contracts.
2. CHK-002 adds diff pack generation and CLI visibility.
3. CHK-003 consumes the diff pack in semantic gate checks and lifecycle output.
4. CHK-004 adds guard session status as an owner-lease projection.
5. CHK-005 binds review evidence to scope/diff/hunk hashes only for scope-protected stories.
6. CHK-006 productizes session_brief, init-from-plan, and integrated smoke coverage.

## CHK-001
Implement v2 fields on ScopeContractData: fileRules, protectedAnchors, and hunk acknowledgements. Keep allowedModify/allowedCreate/allowedTest/protectedFiles/explicitExcludes behavior unchanged for v1 contracts. Validate anchors as non-empty safe strings and reject unsafe paths before persistence. Update scope_contract_set/show/check to round-trip and display v2 fields without clearing omitted fields.

## CHK-002
Create a mechanical diff pack builder that reads changed files and git hunks. Include diffPackHash, changedFiles, hunks, nearest TS/JS anchor when heuristically available, package/json key changes, and parseFallback for unsupported files. Expose scope_diff_pack as CLI command and register it in command policy/config/process fact levels.

## CHK-003
Add semantic gate logic that combines ScopeContractData v2 and DiffContextPack. Allowed file plus allowed anchor passes; denied/protected anchor fails; unknown anchor produces warning or fail according to mode; acknowledged hunk is visible as warn. Wire this into existing runScopeTransitionGate so REVIEW/TEST/DONE output includes semantic gate details.

## CHK-004
Add guard_session_start/status/check. Store guard-session metadata as a scope protection projection, not as write ownership authority. Record provider, guardMode, scopeContractHash, status, startedAt, and violations. session_brief may render guard state, but existing owner lease remains authoritative for writes.

## CHK-005
Extend reviewer evidence binding for scope-protected stories. review_run_start or review_pass_set should capture/validate scopeContractHash, diffPackHash, reviewedChangedFiles, reviewedIntentRefs, and reviewedHunkDigests. REVIEW->TEST preflight rejects missing or stale binding only when scope protection is active; legacy stories remain compatible.

## CHK-006
Add scope_contract_init_from_plan to seed a contract from checklist files and intents. Add an integrated semantic-scope-guard smoke test covering v2 contracts, diff packs, semantic gate, guard-session status, review hash binding, and natural-language-only review bypass failure. Enhance session_brief with one aggregate Scope protection summary.

## Tests
Run at minimum: npm --prefix packages/main run build; npm --prefix packages/main run test:semantic-scope-guard-smoke; npm --prefix packages/main run test:lifecycle-registry-contract; npm --prefix packages/main run test:command-ownership-contract; koala validate --story=B-6bfd --json.

## Risk Controls
Do not make v2 semantic fields mandatory for old stories. Do not duplicate owner lease state; guard status is projection only. Do not rely on reviewer prose; hash binding and diff pack must be mechanical. Unknown or unsupported files must render parseFallback rather than disappear.
