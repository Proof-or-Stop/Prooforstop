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
