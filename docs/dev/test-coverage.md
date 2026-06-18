# Test coverage (c8)

`npm run test:coverage` runs the full smoke battery under c8 and emits a
coverage report. This is on-demand instrumentation, not part of CI or the
default `npm test` chain.

## Command

```sh
npm run test:coverage
```

This wraps the in-house parallel smoke runner (`packages/main/dist/tasks/run-all-smokes.js`)
with c8 in single-process mode (`--jobs 1`), so c8 captures coverage from every
smoke child process via the inherited `NODE_V8_COVERAGE` env var.

## Output

After a successful run, both reports land under `packages/main/coverage/`:

- `packages/main/coverage/index.html` — browsable HTML report. Open it in any
  browser for file-by-file line/branch coverage of `packages/main/src/`.
- `packages/main/coverage/lcov.info` — standard LCOV format for tooling
  integration (Codecov, SonarQube, IDE plugins).

The `packages/main/coverage/` directory is `.gitignore`'d.

## Configuration

c8 is configured via `.c8rc.json` at the repo root:

- `reporter`: `text` (stdout summary) + `html` + `lcov`.
- `reports-dir`: `packages/main/coverage`.
- `include`: `packages/main/src/**/*.ts`.
- `exclude`: `dist/`, `node_modules/`, `*-smoke.ts` fixtures, the runner itself.
- `all: true` — counts files that were never required as 0% covered, so
  unexercised modules show up in the report.

## Limitations (v1)

- **Wall-clock**: single-process mode runs all 139 smokes serially. Expect
  ~10-20 minutes on a typical laptop. The parallel `npm run test:all` remains
  the right command for quick feedback; use `test:coverage` only when you need
  the report.
- **Not in CI**: per the A0 test-runner-consolidation decision, CI integration
  is deferred. Run locally as needed.
- **No threshold gates**: the script does not fail on low coverage. Add
  `--lines`, `--branches`, etc. flags or `.c8rc.json` entries if a follow-up
  story wants enforced thresholds.

## Two-pass retry for `npm run test:all` (B-2941)

`npm run test:all` (the parallel smoke battery, separate from `test:coverage`)
runs in two passes:

1. **Pass 1** — high-concurrency worker pool (default `--jobs <cpuCount>`).
   Per-smoke `PASS/FAIL/TIMEOUT` lines stream as today.
2. **Pass 2** — if any smoke times out in pass 1, the runner re-invokes the
   timeout subset with `--jobs 1` (forced serial). Output lines are prefixed
   `Pass 2:`. The closing line becomes `Final: X/N passed in T s` when retry
   actually fires.

Because every smoke individually passes in single-process mode (verified by
B-24c3 + B-be91 data), pass 2 reliably resolves parallel-load race timeouts.
This makes `test:all` deterministic enough to use as a CI gate.

### CI strict mode

To disable pass 2 (for example in a fail-fast CI step that doesn't want the
retry pass), use `--no-retry`:

```sh
npm run test:all -- --no-retry
```

With `--no-retry` the output and exit semantics are byte-identical to the
pre-B-2941 single-pass behavior.

### Per-smoke escape hatch

`packages/main/smoke-manifest.json` supports an optional
`noRetry: boolean` field per entry. A smoke with `noRetry: true` is **not**
retried in pass 2 even if it timed out — reserved for cases where retry would
mask a real regression. Zero entries use it on initial landing.


## Retry policy (parallel test:all)

`npm run test:all` runs two passes: pass 1 at full concurrency, pass 2 retries (serially, --jobs 1) any smoke that **timed out** in pass 1 -- single-process resolves the parallel-load race. A FAIL (exit 1) is **terminal** and NOT retried by default, so a genuine regression always surfaces. A small documented allowlist of known load-flake smokes (serial-stable but occasionally FAIL under heavy parallel load) opt in to FAIL-retry via the manifest flag `retryOnAnyFailure: true` (currently: field-regression-cli, verification-freshness, worktree-repair, review-pass-discard). This is a stopgap; the shared-state root cause is a deferred follow-up. Use `npm run test:all -- --no-retry` to disable pass 2 entirely (CI strict mode).
