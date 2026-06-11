# B-69bf Plan

## Goal
Prevent Koala runtime artifacts from polluting material freshness, dirty-risk reporting, init ignore rules, and doctor repair guidance by adding one hard-coded runtime artifact registry and wiring consumers to it.

## CHK-001 Create a runtime artifact registry
- Add `packages/main/src/core/runtime-artifact-registry.ts`.
- Represent each runtime artifact with path/pattern semantics, ignore pattern, material-hash exclusion, and tracked repair metadata.
- Include current activity log, legacy activity log, runtime/cache dirs, traces, serve info, debug/browser logs, and tmp files.
- Export helpers for path normalization, runtime matching, material exclusion, volatile classification, required gitignore entries, and repairable tracked artifacts.

## CHK-002 Wire freshness and dirty-risk checks to the registry
- Update `evidence-freshness.ts` so `currentMaterialHash` and changed file freshness exclude runtime artifacts through the registry while keeping source/config/requirements material.
- Update `baseline-risk.ts` to classify volatile runtime artifacts through the registry.
- Update any existing hard-coded activity-log clean checks, especially `story_sync_main`, to consume the same helper.

## CHK-003 Make init and doctor repair runtime artifact drift
- Change `cli-init.ts` so existing `.gitignore` files get missing Koala runtime ignore entries appended under a managed block without overwriting user content.
- Extend `doctor` to scan `git ls-files` for tracked repairable runtime artifacts.
- Make default doctor report the exact `git rm --cached ...` command and `doctor --repair` run only those registry-approved untrack operations.

## CHK-004 Add hard-coded regression coverage
- Update `verification-freshness-smoke` so `.koala/activity.jsonl` and legacy activity logs are runtime metadata, not material.
- Add a tracked-runtime-artifact case that proves materialHash-backed evidence stays covered after runtime log changes.
- Add entrypoint/init coverage for `.gitignore` merge behavior in existing projects.
- Run build, focused smoke tests, entrypoint tests, full npm test, and koala validate before DONE.

## Risks and mitigations
- Over-exclusion risk: keep registry explicit, do not exclude all `.koala/*`; `.koala/story` remains process metadata and source/config/docs stay material.
- Repair risk: doctor only mutates on `--repair`, and only for registry entries marked repairable.
- Drift risk: tests must assert exported registry behavior and consumer outcomes, not command success alone.
