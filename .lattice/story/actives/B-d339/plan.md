# Plan: B-d339 Lifecycle gate V0/V1 hardening and registry foundation

## CHK-001: 修复当前 managed asset drift 并明确健康路径

Goal: make the current `koala check` output actionable without overwriting repository-specific AGENTS.md / CLAUDE.md guidance.

Steps:
- Rename the tracked root Koala guide to the exact managed path expected by the check (`KOALA.md`).
- Preserve the long local AGENTS.md / CLAUDE.md guidance and avoid `koala check --apply` on STALE_LOCAL_EDIT content.
- If needed, adjust managed asset ownership/check classification so valid local managed sections can be recognized without hiding real drift.

Verification:
- Run `koala check` and capture output.
- Confirm true managed drift remains visible when intentionally represented by an existing failing case or focused logic check.

## CHK-002: 将 REVIEW/TEST validate 与 preflight 异常改为 fail-closed

Goal: lifecycle gate infrastructure exceptions must block TEST entry instead of being logged as warnings.

Steps:
- Update `story_advance` REVIEW->TEST preflight catch so unexpected preflight errors throw `Cannot enter TEST` with remediation.
- Update TEST validate catch so verifier import/runtime/JSON parse failures throw and do not advance phase.
- Preserve structured validate results: an explicit warn/skip result from `koala validate` should still be handled by existing `allPass` semantics rather than classified as infrastructure exception.

Verification:
- Add focused smoke coverage for preflight/validate exception paths.
- Run flow stability smoke and validate relevant CLI behavior.

## CHK-003: 新增 lifecycle-registry.ts 只读登记生命周期事实

Goal: create a typed, inspectable registry that records the lifecycle facts maintainers currently have to chase across multiple files.

Steps:
- Add `packages/main/src/core/lifecycle-registry.ts`.
- Register active phase order, terminal phases, legacy phase aliases, transitions, rollback edges, phase event mapping, cwd-gated phases, gate ids, effect ids, and oracle row ids.
- Keep it read-only in this story, with compatibility helpers usable by existing phase-flow/context code.

Verification:
- TypeScript build.
- Registry assertions in smoke/contract tests confirm the registry describes existing behavior.

## CHK-004: 用 registry contract 覆盖 phase-flow、event mapping 与 command policy 一致性

Goal: prevent future lifecycle drift by breaking focused tests when the registry and existing consumers disagree.

Steps:
- Extend flow stability smoke or add a nearby lifecycle-registry smoke.
- Check phase-flow order/transition helpers against registry.
- Check `PHASE_TO_EVENT` and cwd-gated phases against registry.
- Check command policy has no phase outside registry active phases and that command allowlist expectations remain phase-aware.

Verification:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:flow-stability-smoke`
- `npm run test:process-fact-contract` if process-fact-facing files change.
