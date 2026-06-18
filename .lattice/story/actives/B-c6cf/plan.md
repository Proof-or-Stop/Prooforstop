# Execution plan: B-c6cf (B3 c8 coverage)

## Order
1. **CHK-001** — Add c8 devDependency to root package.json + create `.c8rc.json` config + update root `.gitignore` for `packages/main/coverage/`.
2. **CHK-002** — Wire root `test:coverage` script invoking `c8 ... node packages/main/dist/tasks/run-all-smokes.js --jobs 1`. Verify exit 0 + non-empty HTML + LCOV.
3. **CHK-004** — Create `docs/dev/test-coverage.md` user-facing usage doc (Document the coverage report in docs/ — separate docs/ artifact, not CHANGELOG). Covers command, output paths, v1 single-process note, on-demand-not-CI caveat.
4. **CHK-003** — CHANGELOG Unreleased entry + decision-doc `B3 DONE B-c6cf` marker.

## Dependencies
- CHK-001 must come before CHK-002 (c8 must be installed to run test:coverage).
- CHK-002 must come before CHK-004 (running test:coverage once during DEV validates the docs commands).
- CHK-003 last (records the others as done in CHANGELOG + DECISION doc).

## Verify
- `npm install` after CHK-001
- `npm run test:coverage` after CHK-002 — wall-clock recorded as known limitation
- `npm test` (root chain unchanged)
- `npm run test:all` (parallel battery unchanged)

## Out of scope (explicit)
- packages/main/src/tasks/run-all-smokes.ts (B-6efb frozen)
- packages/main/smoke-manifest.json (B-d7c3 frozen)
- CI integration (A0 defers)
- Multi-process NODE_V8_COVERAGE (deferred to follow-up)
