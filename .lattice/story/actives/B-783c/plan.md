# Plan: B-783c Make Codex verify heartbeat activity logging work in global-thin managed projects

## CHK-001: Recognize managed global-thin projects as activity-log writable roots

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/config.ts, packages/main/src/cli-engine.ts, packages/main/src/core/codex-adapter-checks.ts
- Create: none
- Test: packages/main/src/tasks/thin-init-assets-smoke.ts

**Verify**:
- `npm --prefix packages/main run build` succeeds.
- Focused smoke proves a managed global-thin root with only `.lattice/lattice.json` and `assetMode: global-thin` writes a `session_brief` row to `.lattice/activity.jsonl`.
- Code inspection confirms `loadConfig()` and `PROJECT_CONFIG_FILENAMES` remain canonical `lattice.config.json` only.

**DoneWhen**:
- A clear runtime activity-root helper accepts canonical `lattice.config.json` roots and managed global-thin `.lattice/lattice.json` roots.
- `cli-engine.ts` writeLog uses the runtime activity-root helper for activity logging eligibility and keeps the durable main-root fallback order.
- Codex adapter global-thin detection reuses the same manifest check instead of duplicating broader logic.

## CHK-002: Cover canonical and global-thin activity logging behavior with regression tests

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: none
- Create: none
- Test: packages/main/src/tasks/thin-init-assets-smoke.ts

**Verify**:
- `npm --prefix packages/main run build` succeeds.
- The focused global-thin smoke runs without assertion failures.
- The smoke asserts canonical activity logging still works, managed global-thin activity logging works, and malformed or wrong-assetMode manifests do not create `.lattice/activity.jsonl`.

**DoneWhen**:
- Regression coverage would fail if the helper only accepted `lattice.config.json`.
- Regression coverage would fail if `.lattice/lattice.json` were treated as canonical config or accepted without `assetMode: global-thin`.
- Regression coverage would fail if unrelated directories started receiving stray activity logs.

## CHK-003: Verify the solver-visible global-thin Codex adapter smoke passes

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: none
- Create: none
- Test: packages/main/src/tasks/thin-init-assets-smoke.ts

**Verify**:
- `npm --prefix packages/main run build` succeeds so the global `lattice` symlink reaches the fixed dist output.
- From `/Users/jek/Documents/Work/deepswe-pos-codex-gpt55-run/solver-visible`, run `lattice codex verify`.
- Inspect the output for a passing Global fallback heartbeat and the absence of `no activity heartbeat for session`.

**DoneWhen**:
- The solver-visible command exits successfully.
- The output no longer contains the prior hard failure signature `Global fallback heartbeat: no activity heartbeat for session ...`.
- The heartbeat evidence is attributed to `source=codex` and `entrypoint=global-fallback`, proving the real user-facing path is fixed.
