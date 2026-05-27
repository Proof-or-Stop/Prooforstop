## CHK-001 Surface manual fallback warnings in recovery views

Add recovery-view rendering for fallback init checks. `story_get` should keep the structured `initCheckAttestation=fallback` / `initCheckFallback` fields and add a human-readable continuation warning. `session_brief` should render an `INIT fallback warning` both when running on the fallback story branch/worktree and when main lists an active fallback story with a resume hint.

Expected wording must include:
- `manual fallback attestation, not independent reviewer approval`
- later `PLAN/DEV/REVIEW/TEST` gates remain required
- implementation/continuation needs explicit user/project authorization when this is not the requested project

## CHK-002 Make init_check_repair output close with a continuation boundary

Append a boundary line to successful `init_check_repair` output. The line should explain that fallback only repairs INIT_CHECK, does not authorize implementation, and does not replace later reviewers/gates. Keep refusal behavior unchanged: missing acknowledge or short reason still writes nothing and should not imply continuation is allowed. High/critical fallback issue output should still make blocking explicit and include the same boundary.

## CHK-003 Add smoke coverage for the fallback continuation guard

Extend `packages/main/src/tasks/init-check-fallback-smoke.ts` after the existing fallback repair path. Assertions should cover:
- `story_get` exposes `initCheckAttestation=fallback` and a warning string.
- independent reviewer story_get does not carry the fallback warning field.
- `session_brief` for a fallback active story includes `INIT fallback warning`, the manual fallback phrase, the later-gates phrase, and the explicit authorization boundary.
- successful `init_check_repair` output contains the boundary line.

Verification commands:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:init-check-fallback-smoke`
- `koala validate --story=B-6894 --json`
