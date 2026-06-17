# Plan — B-6efb: B1 in-house runner skeleton + manifest + test:all

## Goal
Build the in-house parallel smoke runner per A0 decision doc (B-35aa). Adds `test:all` alongside the
262 existing `test:*` scripts without touching any of them or any smoke file.

## CHK-001 — Runner: packages/main/src/tasks/run-all-smokes.ts
- Scan `packages/main/src/tasks/*-smoke.ts` to discover smokes (smoke = file basename without `-smoke.ts`).
- Read optional manifest at `packages/main/smoke-manifest.json` (schema: `{ smokes: [{name, tags?, timeoutMs?, skip?}] }`).
- For each non-skipped smoke, spawn `node packages/main/dist/tasks/<name>-smoke.js` as a child process via a worker pool (default size = `os.cpus().length`, overridable via `--jobs N`).
- Per-smoke timeout from manifest (default 60_000 ms).
- Filters: `--tag <tag>` (manifest tag match), `--select <substring>` (smoke name contains substring).
- Aggregate exit codes: fail if any smoke fails or times out.
- Output per-smoke `PASS smoke-name (Ns)` / `FAIL smoke-name (Ns) [reason]` + final `<n>/<m> passed in <duration>s`.

## CHK-002 — Manifest + test:all entry
- Create `packages/main/smoke-manifest.json` with initial entries for the runner self-smoke + 2-3 fast known smokes (gitroot-cwd-contract-smoke, field-regression-cli-smoke, gap-log-smoke). Leave others discoverable via directory scan.
- Add `"test:all": "node packages/main/dist/tasks/run-all-smokes.js"` to root `package.json`. (Use `-- --tag X` from CLI to forward flags through npm.)

## CHK-003 — Self-smoke
- `packages/main/src/tasks/run-all-smokes-smoke.ts`: write 2 fixture smokes to a tmpdir (one PASS, one FAIL) + a fixture manifest, invoke the runner with `--select` pointed at the fixtures, assert: PASS fixture reports PASS; FAIL fixture reports FAIL; `--tag missing-tag` returns 0 smokes; `--jobs 1` and `--jobs 4` both pass for the PASS fixture; runner exits non-zero when any fixture fails.
- Standalone-runnable: `node packages/main/dist/tasks/run-all-smokes-smoke.js`. Add `"test:run-all-smokes-smoke": "node dist/tasks/run-all-smokes-smoke.js"` to `packages/main/package.json`.

## Out of scope
B2 (collapse 262 test:* scripts), B3 (c8 coverage), B4 (UX polish). No edits to existing smokes or decision docs.
