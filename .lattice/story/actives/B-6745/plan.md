# Plan: B-6745 Stabilize the 8 deferred P5 authority/baseline smokes

Test/config-only. 0 production change. NEVER weaken an assertion. Chosen approach: A-fileReader-hermetic.

Ground truth (verified on a fresh build):
- `authority-job-loop-live` passes standalone exit 0 (stale-dist artifact) — NO edit.
- `autopilot-authority` + `multi-host-authority` are NON-HERMETIC: they read the dev on-disk `authority_trust.env` via `fileReader` from cwd. Reproduce the failure by running from a cwd containing an `authority_trust.env` with `LATTICE_AUTHORITY_LIVE_URL=...` (autopilot: `shadow.status` pass!=warn; multi-host: mode server!=local). They pass from a clean cwd only because the file is absent.
- Production is correct: `authority-mode.ts:446-452` applies the localhost default URL ONLY to enforce mode; shadow keeps no-URL behavior → `shadow.status===warn` is the intended assertion.
- `authority-client.ts` `readAuthorityTrustEnvConfig` (~1541-1551) reads via `options.fileReader ?? defaultAuthorityFileReader`; passing `fileReader: () => undefined` makes the disk read return nothing. `buildAuthorityStatus`/`buildAuthorityEnforceRunnerPlan` accept this via `AuthorityStatusRuntime extends AuthorityConfigLoadOptions`. fileReader is an EXISTING production parameter — threading it from the smoke is 0 production change.
- The 5 slow smokes already have finite raised timeouts in `smoke-manifest.json`.

## CHK-001: Stale + hermetic test fixes (authority-job-loop-live rebuild-verify; autopilot-authority + multi-host-authority hermetic fileReader)

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/tasks/autopilot-authority-smoke.ts
- Modify: packages/main/src/tasks/multi-host-authority-smoke.ts
- (authority-job-loop-live-smoke.ts: rebuild-verify ONLY — do NOT edit unless it genuinely fails on a fresh build)
- Test: the smokes are themselves the tests (run their dist .js)

**Verify**:
- `npm --prefix packages/main run build` succeeds
- `node packages/main/dist/tasks/authority-job-loop-live-smoke.js` → exit 0 (no edit)
- For autopilot + multi-host, prove hermeticity: `TMPD=$(mktemp -d); printf 'export LATTICE_AUTHORITY_LIVE_URL="https://planted.example.test"\n' > "$TMPD/authority_trust.env"; (cd "$TMPD" && node <abs path>/packages/main/dist/tasks/autopilot-authority-smoke.js; echo EXIT=$?)` → exit 0 AND same from /tmp clean cwd → exit 0
- Same planted-cwd run for multi-host-authority-smoke.js → exit 0
- `git diff main...HEAD --stat` shows only the 2 smoke .ts files (+ dist rebuild) changed

**DoneWhen**:
- autopilot-authority + multi-host-authority pass standalone from BOTH a clean cwd AND a cwd with a planted authority_trust.env
- authority-job-loop-live passes on rebuild with no source edit
- Every existing assertion KEPT: shadow.status===warn, readinessWarnings.length>0, localWorkflowUsable===true, authorityRequired===false (autopilot); E2 mode===local (multi-host)
- 0 production source files changed; only the smoke .ts files

## CHK-002: Re-verify the 5 already-bumped finite timeouts in smoke-manifest.json

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Inspect/possibly-modify: packages/main/smoke-manifest.json

**Verify**:
- Confirm current values: dispatch-run=180000, lattice-baseline=240000, cli-json-stdout-contract=180000, planner-unattended=180000, experience-layer-playbook=180000 (all finite)
- `npm run test:all` → the 5 complete within their timeouts (no TIMEOUT) and suite reaches ~162/162
- Bump ONLY if a measured standalone time + margin exceeds the current value; keep finite

**DoneWhen**:
- test:all shows none of the 5 TIMEOUT
- All timeoutMs finite (no Infinity/0); no smoke logic changed
