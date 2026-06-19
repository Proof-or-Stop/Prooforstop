# Plan: B-02a6 Make INIT-phase story metadata clean-proof at story_create

Chosen approach (decision.json): **A — commit the INIT metadata to main HEAD at story_create (the "safe-init commit")**, inside the main-write-lock story_create already holds, so a tracked file is immune to a concurrent `git clean -fd`. Reuse the existing reverse half `purgeSafeInitCommit` (resets main `HEAD~1`). Keep the protection-predicate extension + reproduction smoke as defense-in-depth.

Execution order: **CHK-001 first** (lock the bug with a failing smoke), then **CHK-002** (the fix — makes the smoke pass), then **CHK-003** (defense-in-depth predicate). CHK-003 is independent of CHK-002 and may run in parallel once CHK-001 lands.

## CHK-001: Reproduce the INIT-window data-loss in a regression smoke

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/tasks/init-window-data-loss-smoke.ts
- Modify: the validate task battery wiring so the smoke runs under `lattice validate` (follow an existing smoke's registration, e.g. how review-pass-discard-smoke.ts is wired)
**Verify**:
- `lattice validate` runs the smoke. On the CURRENT main (before CHK-002) the reproduction assertion shows the metadata is wiped (smoke is RED), proving the bug.
- The smoke uses a throwaway temp git repo fixture carrying the real `.gitignore` allowlist (`.lattice/story/*` + `!.lattice/story/actives/**`).
**DoneWhen**:
- Smoke creates a story metadata dir in INIT state (untracked on the fixture's main), runs a simulated concurrent `git clean -fd` on the shared checkout, and asserts the actual file bytes are gone on current behavior.
- Edge: covers both an allowlisted-not-ignored leaf and an ignored leaf (clean -fd vs clean -fdx).
- Adversarial: asserts presence/absence by reading file bytes, not by exit code, so a no-op fix cannot fake a pass.
- The smoke is written so that AFTER CHK-002 it flips GREEN (metadata survives) — same test, opposite assertion gated on the fix being present.

## CHK-002: Create the safe-init-commit at story_create

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/story-create.ts (commit the new story metadata to main HEAD at the END of the create body, inside the existing `withReentrantMainWriteLock` block)
- Modify: packages/main/src/handlers/worktree.ts (make the INIT_CHECK bootstrap idempotent when main already carries the metadata — branch from main as-is, skip the redundant add-f/commit; keep `purgeSafeInitCommit` working; add tombstone fallback when the init commit is no longer HEAD)
- Reference (do NOT duplicate logic): packages/main/src/core/auto-commit-metadata.ts (its `!branch.startsWith('story/')` early-return is WHY main never commits today — the new path is a deliberate, scoped main-HEAD commit, not a relaxation of that helper)
**Verify**:
- `lattice validate` — CHK-001 smoke now GREEN (metadata survives the concurrent clean).
- Manual transcript: `lattice story_create ...` then `git -C <repo> log -1 --pretty=%s` shows `lattice: story B-xxxx init`; `git ls-files -- .lattice/story/actives/B-xxxx/index.json` lists the leaf.
- `lattice story_advance INIT_CHECK` produces NO duplicate init commit; `lattice story_discard --purge` cleanly reverses (existing review-pass-discard-smoke `assertPurgeDropsSafeInitCommit` still passes).
**DoneWhen**:
- Metadata is committed/tracked on main immediately after story_create, under the main-write-lock.
- Bootstrap idempotent (no double commit, no hard-fail); discard reverses (HEAD~1 when HEAD, tombstone otherwise).
- The concurrent-wipe smoke and the existing purge/discard smokes all pass.

## CHK-003: Extend the B-854c protection predicate + doctor surface

**Owner**: lattice-implementer
**DependsOn**: CHK-001 (independent of CHK-002; may run in parallel after CHK-001)
**Files**:
- Modify: packages/main/src/core/story-metadata-protection.ts (broaden `unsafe` to also flag `!ignored && !tracked` — i.e. any untracked leaf is unsafe; keep `wouldBeCleaned` field semantics documented)
- Modify: packages/main/src/handlers/doctor.ts (scan + warning text surfaces the new allowlisted-but-uncommitted case)
- Modify/Create: the protection predicate's unit test (tests for `story-metadata-protection`) — add the `!ignored && !tracked` case
**Verify**:
- `lattice validate` — predicate unit tests green, including the new `!ignored && !tracked → unsafe=true` case and the preserved `tracked → safe` / `ignored && !tracked → unsafe` cases.
- `lattice doctor` on a fixture with an uncommitted INIT leaf prints the DATA-LOSS RISK warning.
**DoneWhen**:
- `evaluateStoryMetadataProtection` returns `unsafe=true` for any `!tracked` leaf regardless of ignore state; tracked leaf stays `unsafe=false`.
- Blank/whitespace leaf still throws (no consumer can classify empty as safe).
- doctor surfaces the new case without false-positiving a correctly committed leaf.
