# B-be27 Plan — Story Scope Contract and Changed-File Gate

## Goal
Add a provider-neutral scope contract that lets Koala decide whether a story's diff stayed within the agreed file boundary. The contract must be current policy, not lifecycle history, and lifecycle gates must render concrete pass/warn/fail output.

## Chosen Approach
Use `contract-plus-post-diff-gate`: build a ScopeContract core model, CLI commands, lifecycle integration, explicit acknowledgement for scope expansion, and focused smoke tests. Claude Code hook blocking and protected regression packs will be separate later stories that consume this contract.

## CHK-001
Define `ScopeContract` and persistence helpers. Include `mode` with `local|shadow|enforce`, path arrays for allowed/protected/excluded files, and acknowledgement records. Validate path shape and default missing arrays to empty arrays.

Verify:
- logic test proves round-trip persistence preserves fields.
- invalid mode/malformed paths are rejected.
- empty optional arrays do not crash read/show/check flows.

## CHK-002
Add CLI commands for setting/showing/checking the contract. Preferred names are `scope_contract_set`, `scope_contract_show`, `scope_contract_check`, and if needed `scope_contract_acknowledge`. The check output must include status, changed files, violations, warnings, mode, and acknowledgement summary.

Verify:
- CLI smoke passes for clean and in-scope diffs.
- out-of-scope files produce structured violations.
- JSON output is stable enough for hooks and future runners.

## CHK-003
Integrate the check into lifecycle gates for REVIEW/TEST/DONE. Missing contracts stay compatible by default; strict/enforce mode can block. Shadow mode warns without blocking. The user-visible transcript must include `Scope gate: pass|warn|fail`.

Verify:
- enforce mode blocks protected/excluded paths.
- shadow mode warns but does not block.
- legacy/no-contract stories do not regress.

## CHK-004
Add explicit scope change acknowledgement. Expansion must require a reason and actor metadata, preserve timestamp and paths, and render in reviewer-visible output. It must not hide the changed files from checks.

Verify:
- valid acknowledgement is recorded and visible.
- too-short/empty reasons are rejected.
- acknowledged expansion still appears in scope check output.

## CHK-005
Add focused regression tests and package script. The test should cover allowed, blocked, shadow, no-contract compatibility, and acknowledged change cases. Run package build and story validation as final evidence.

Verify:
- `npm --prefix packages/main run test:scope-contract-smoke`
- `npm --prefix packages/main run build`
- `koala validate --story=B-be27 --json`
