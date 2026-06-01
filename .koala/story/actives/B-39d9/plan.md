# B-39d9 Plan - runtimeMode check/doctor UX

## Goal

Make Koala core answer the JavaScript footprint question directly in both machine-readable and human-readable check/doctor paths. The authoritative contract is local-runtime diagnostic output; MCP/host integrations remain optional consumers, not the source of truth.

## CHK-001

Add a shared runtimeMode helper in `packages/main/src/core/runtime-environment-checks.ts`.

- Define exported types for `RuntimeModeName`, `RuntimeModeSource`, and `RuntimeModeDiagnostic`.
- Derive runtimeMode from the existing runtime fact report without moving runtime facts into the process-fact registry.
- Classification rules stay conservative: project-local-package only when the project local bin is present and matches the active entrypoint; external/self development engines and wrapper fallback chains classify as compatibility-launcher; missing/conflicting evidence degrades to diagnostic-only.
- Include top-level runtimeMode in `check --json` and `doctor --format=json` through the same helper.

Verification: validation protocol smoke asserts both JSON surfaces expose fields and exact enum membership, plus edge/adversarial classification cases through dependency-injected runtime reports.

## CHK-002

Render a first-screen runtime footprint block before deeper diagnostics.

- Add `renderRuntimeModeSummary(runtimeMode, nextAction)` in the runtime diagnostics layer.
- In `check`, run runtime diagnostics beside managed asset check, prepend the summary, and preserve thrown drift output.
- In `doctor`, prepend the summary before health/worktree/runtime scan sections.
- Compute next action from managed asset drift for check and from doctor health/runtime-artifact/worktree state for doctor.

Verification: smoke asserts the first visible lines contain `Runtime mode:`, `Project-local JavaScript runtime required:`, and `Next action:` for both plain check and plain doctor.

## CHK-003

Preserve safe sync boundaries and prove unsafe statuses remain manual.

- Keep apply/upgrade mutation limited to MISSING and STALE_SAFE.
- Add an exported managed-asset next-action helper so UI text cannot imply unsafe drift is repairable.
- Extend smoke coverage with synthetic managed asset results covering STALE_LOCAL_EDIT, CASE_MISMATCH, and INCOMPATIBLE manual guidance, plus apply-safe behavior from existing `applyDefinition` boundary.

Verification: smoke asserts manual action text for unsafe statuses and that `Applied:` only reflects safe repaired assets.

## CHK-004

Build and hand off Koala Mac wrapper proof requirements.

- Run `npm --prefix packages/main run build`.
- Run the focused smoke test that covers runtimeMode/check/doctor/managed asset guidance.
- Record evidence on the story with command output summaries.
- Handoff to Koala Mac B-3e9a with exact consumer commands: `node bin/koala.js check --json`, `node bin/koala.js doctor --format=json`, `node bin/koala.js check`, and `node bin/koala.js doctor`.

Verification: B-39d9 only claims core readiness; B-3e9a records wrapper proof in the Koala Mac worktree.
