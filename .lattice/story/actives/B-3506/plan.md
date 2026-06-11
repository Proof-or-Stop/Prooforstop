# Plan: B-3506 Auto-commit Koala metadata writes so dirty gates stay clean

## CHK-001: Auto-commit Koala metadata writes after CLI mutations

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/auto-commit-metadata.ts (extracted helper: `autoCommitStoryMetadata(projectRoot, storyId, reason): string`)
- Modify: packages/main/src/handlers/story-advance.ts (replace internal copy with import from new core/auto-commit-metadata.ts; pass current phase as reason)
- Modify: packages/main/src/handlers/finding.ts (call helper after each ctx.store.writeFindings / writeReviewPasses; reason="finding_add" / "finding_resolve" / "review_pass_set")
- Modify: packages/main/src/handlers/checklist.ts (call helper after writeChecklist; reason="checklist_update" / "verification_evidence_add" / "verification_evidence_refresh_stale" depending on caller)
- Modify: packages/main/src/handlers/init-check.ts (call helper after writeInitCheck; reason="init_check_set")
- Modify: packages/main/src/handlers/scope-check.ts (call helper after writeScopeCheck; reason="scope_check_set")
- Modify: packages/main/src/handlers/delivery-check.ts (call helper after writeDeliveryCheck; reason="delivery_check_set" / "delivery_waiver_add")
- Modify: packages/main/src/handlers/summary.ts (call helper after writeSummary; reason="summary_set")

**Verify**:
- After each above handler invoked in a story/* branch with dirty metadata, output contains `✓ koala metadata 已自动提交: koala: record <storyId> <reason> metadata (<sha7>)`
- `git log -1` shows the auto-committed commit

**DoneWhen**:
- packages/main/src/core/auto-commit-metadata.ts exists and exports `autoCommitStoryMetadata(projectRoot, storyId, reason)` returning the user-visible hint string (empty when no-op)
- story-advance.ts imports from new core (no duplicated copy)
- All 6 handlers above call the helper after their main store.write*; reason string is the operation name
- On non-story/* branch helper returns empty silently

## CHK-002: Skip auto-commit when non-metadata dirt coexists (safety guarantee)

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/auto-commit-metadata.ts (extend helper to optionally append "(coexisting non-metadata dirt left untouched: <counts>)" tail-note using B-6326 classifyDirtyWorktree)

**Verify**:
- When worktree has both metadata write + a material/fixture/unexpected file dirty, output tail-note contains `untouched` and the per-category counts
- `git status` after auto-commit shows material/fixture/unexpected paths still M
- Path scope is checked: helper asserts canonical `.koala/story/actives/<id>/` prefix (preMortem #1)

**DoneWhen**:
- Helper computes coexisting non-metadata dirt via `classifyDirtyWorktree` and appends count tail-note when any non-metadata category has paths
- Helper asserts canonical path prefix; non-canonical input throws
- When no non-metadata dirt coexists, tail-note is OMITTED (not "(none)" or empty parens)

## CHK-003: Surface auto-commit activity in user-visible output

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/handlers/finding.ts (append helper return value to handler stdout response; omit if empty)
- Modify: packages/main/src/handlers/checklist.ts (same)
- Modify: packages/main/src/handlers/init-check.ts (same)
- Modify: packages/main/src/handlers/scope-check.ts (same)
- Modify: packages/main/src/handlers/delivery-check.ts (same)
- Modify: packages/main/src/handlers/summary.ts (same)

**Verify**:
- Each handler stdout includes the `✓ koala metadata 已自动提交:` line when commit fired
- When helper returned empty, no extra line in stdout (no "(no commit)" filler)
- story_advance retains its existing hint format (no double-print, no behavior change)

**DoneWhen**:
- All 6 extended handlers concatenate helper output into their response string
- Smoke asserts the literal Chinese prefix is identical across handlers and story_advance

## CHK-004: Regression-prove safety + idempotency + path-scope

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: packages/main/src/tasks/flow-stability-smoke.ts (add `assertAutoCommitMetadataAcrossHandlers` block)

**Verify**:
- `npm --prefix packages/main run build` clean
- `npm --prefix packages/main run test:flow-stability-smoke` prints `✓ flow stability smoke passed`

**DoneWhen**:
- Smoke covers: (a) helper fires on story/* and produces auto-commit line for 3+ handlers; (b) helper silent on main; (c) idempotent re-call no-op; (d) path-broadening throws; (e) coexisting non-metadata dirt → tail-note + non-metadata path still M
- Smoke uses B-6326 `classifyDirtyWorktree` directly for assertion vocabulary (no duplicate string matching)
- All assertions concrete (exact substring matches), no "looks reasonable" prose

## Validation

After evidence is recorded:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:flow-stability-smoke`
- `npm --prefix packages/main run test:verification-freshness-smoke` (regression — should still pass; story_advance auto-commit unchanged)
- `koala validate --story=B-3506 --json`

## Rollback

If extending auto-commit to a particular handler causes regression, the per-handler call sites are independent — remove the helper invocation from the offending handler and the rest continues working. The helper itself is a pure extraction of existing logic (story-advance.ts already proves it works), so the core/auto-commit-metadata.ts file is safe to keep regardless.
