# B-e11b Plan

## CHK-001 - Validation Protocol Types

Create a small core validation protocol module that exports `ValidationCommand`,
`ValidationPlan`, `ValidationCommandResult`, and `ValidationResult`. Keep the
fields compatible with the current verifier output: `provider`, `status`,
`allPass`, `summary`, `details`, `warnings`, `timestamp`, and `headSha`.

Acceptance:
- Existing validate consumers can still read `status`, `allPass`, `summary`,
  and `details`.
- New command-based validation results expose a `commands` array with command
  label, executable, args, exit code, and output summary.

## CHK-002 - Shell Executor

Move command execution semantics into a reusable executor. It should run a
serial command plan, capture stdout and stderr, record exit codes, support
`optional`, and return a protocol-shaped result. Preserve the old `runCommand`
behavior through a wrapper or compatibility function while migrating verifier
call sites.

Acceptance:
- Required command failure makes the result fail.
- Optional command failure records a warning while keeping the overall result
  non-failing.
- Command output remains visible enough for diagnosis.

## CHK-003 - Verifier Integration

Refactor the verifier handler so it builds a validation plan, executes it, and
persists story evidence through the same protocol. Keep this priority order:
configured `validate.commands`, project `validate.ts/js/mts`, then discovered
commands. Keep story verification coverage decoration and evidence freshness
unchanged from the caller's perspective.

Acceptance:
- Projects with `validate.ts` continue to work.
- Projects with only `validate.commands` produce a protocol result and write
  `test-evidence.json`.
- Projects with no validator produce a clear warn/skip result.

## CHK-004 - Regression Coverage

Add focused smoke coverage around protocol and executor behavior. Use temporary
projects where possible so tests do not depend on host language toolchains.

Acceptance:
- Pass, fail, warn, optional failure, no-entry warn, and story evidence writing
  are covered.
- `npm run build`, `npm run test:e2e`, and targeted smoke checks pass before
  advancing out of DEV.
