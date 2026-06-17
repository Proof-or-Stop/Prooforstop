# Plan: B-ed12 Stabilize the ~13 stale smoke tests that rotted while the suite was ungated

## Shared guardrail (applies to every CHK)

For EACH smoke: (1) read the failing assertion AND run it standalone to capture actual-vs-expected; (2) read the production code it exercises + the story/behavior change that moved it; (3) CONFIRM production is intended/correct; (4) THEN update the TEST to assert that current behavior. NEVER weaken or delete an assertion just to make it pass. If a "stale" smoke on close inspection reveals a genuine PRODUCTION bug (not just a changed expectation), STOP and report it — do not paper it over. Each fixed smoke must pass STANDALONE after the fix with its safety intent intact.

Run a single smoke: `npm --prefix packages/main run build && node packages/main/dist/tasks/<name>-smoke.js; echo EXIT=$?` (expect EXIT=0). The gate battery does NOT run these smokes, so standalone verification is the only real evidence. Change ONLY test files; allowedPaths = the 15 *-smoke.ts files. Any edit to a production (non-test) file means it is a real bug to ESCALATE.

Pre-survey (already done by main agent) classified all 14 failures as STALE with 0 production bugs; usage-ledger-estimate ALREADY passes. Implementers must still re-confirm per smoke.

## CHK-001: Fix gate-semantics-drift smokes: init-check-fallback, init-check-required-agents, done-preflight

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/tasks/init-check-fallback-smoke.ts
- Modify: packages/main/src/tasks/init-check-required-agents-smoke.ts
- Modify: packages/main/src/tasks/done-preflight-smoke.ts

**Root causes (confirmed by survey)**:
- init-check-fallback / init-check-required-agents: production now checks scope-boundary.json BEFORE init-check at INIT_CHECK (machine.ts ~113/593), so they hit `[missing_scope_boundary]` not the old `[missing_init_check]` / `[missing_init_check_agent]`. Fix: make each smoke set up scope-boundary.json (and execution-boundary / scope-freeze as the current INIT_CHECK flow requires) before advancing INIT_CHECK, mirroring the real flow, so they reach and assert the init-check tags they intend to test.
- done-preflight assertDoneRejectsWhenMainIsDirty: B-72df made the dirty-main DONE clean-check scoped to merge-affected paths (done-effects.ts ~371). A dirty main with files OUTSIDE the merge-affected paths is now TOLERATED; a real merge-affecting conflict still blocks. The test now sees a merge-strategy failure path rather than the old generic "Cannot enter DONE" message. Fix: update to B-72df semantics; CONFIRM the story is NOT advanced to DONE in the dirty/conflict case (no bypass) and assert the current message.

**Verify**:
- `node packages/main/dist/tasks/init-check-fallback-smoke.js; echo EXIT=$?` -> EXIT=0
- `node packages/main/dist/tasks/init-check-required-agents-smoke.js; echo EXIT=$?` -> EXIT=0
- `node packages/main/dist/tasks/done-preflight-smoke.js; echo EXIT=$?` -> EXIT=0

**DoneWhen**:
- All three pass standalone asserting CURRENT gate semantics (scope-boundary required at INIT_CHECK; B-72df scoped dirty-main DONE check that still blocks a real conflict and never bypasses to DONE)
- done-preflight still asserts story remains in TEST (not advanced to DONE) on a real merge-affecting conflict
- No safety assertion weakened; zero production change

## CHK-002: Fix behavior/model-drift smokes: worktree-repair (B-097f), story-dedup (slug casing), convergence-discarded (message)

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/tasks/worktree-repair-smoke.ts
- Modify: packages/main/src/tasks/story-dedup-smoke.ts
- Modify: packages/main/src/tasks/convergence-discarded-smoke.ts

**Root causes (confirmed by survey)**:
- worktree-repair assertMixedCanonicalLegacyGlobalLinksAreRepaired returns 'skipped' instead of 'relinked'. B-097f made agent prompts host-neutral single-source (project-local link repair is now a no-op). CONFIRM 'skipped' is the correct post-B-097f behavior (see worktree.ts ~175 repairGlobalLatticeLinkBeforeWorktreeDelete + the B-097f section in CLAUDE.md), then update the assertion to expect it.
- story-dedup expects 'Japanese-task' but gets 'japanese-task'. normalizeName now lowercases all output. CONFIRM the lowercasing is intended, update the expectation to the normalized slug.
- convergence-discarded: the 'All stories complete' convergence check/message drifted (expected true, got undefined). Find the current convergence message/behavior (core/convergence.ts checkConvergence) and update.

**Verify**:
- `node packages/main/dist/tasks/worktree-repair-smoke.js; echo EXIT=$?` -> EXIT=0
- `node packages/main/dist/tasks/story-dedup-smoke.js; echo EXIT=$?` -> EXIT=0
- `node packages/main/dist/tasks/convergence-discarded-smoke.js; echo EXIT=$?` -> EXIT=0

**DoneWhen**:
- Each passes standalone asserting current correct behavior (post-B-097f skip; normalized slug; current convergence message)
- Production correctness confirmed per smoke before edit; if any reveals a real bug it is escalated not weakened
- Zero production change

## CHK-003: Fix message/CLI/rename-drift smokes: cli-argument-ergonomics, lattice-only-absence, lattice-cli-migration, review-loop

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/tasks/cli-argument-ergonomics-smoke.ts
- Modify: packages/main/src/tasks/lattice-only-absence-smoke.ts
- Modify: packages/main/src/tasks/lattice-cli-migration-smoke.ts
- Modify: packages/main/src/tasks/review-loop-smoke.ts

**Root causes (confirmed by survey)**:
- cli-argument-ergonomics: the validation error message changed from "Parameter validation failed" to "Argument validation failed". Update the regex to the current text.
- lattice-only-absence: assertion drift (expected 'fail' got 'pass' for a legacy-only manifest). CONFIRM current behavior + update.
- lattice-cli-migration: drift from the koala->lattice rename completion; help text changed (e.g. "Primary entrypoint: lattice" -> "Entrypoint: lattice"). Update to the current migrated state.
- review-loop: 3 of 38 sub-assertions fail with `opts.store.storyDirPath is not a function` (store mock interface drift: review_loop_status JSON active/latest fields; reject duplicate explicit loopId; reject placeholder rollbackRef hashes). Fix ONLY the 3 (update the test's store mock to the current interface), keep the other 35 untouched.

**Verify**:
- `node packages/main/dist/tasks/cli-argument-ergonomics-smoke.js; echo EXIT=$?` -> EXIT=0
- `node packages/main/dist/tasks/lattice-only-absence-smoke.js; echo EXIT=$?` -> EXIT=0
- `node packages/main/dist/tasks/lattice-cli-migration-smoke.js; echo EXIT=$?` -> EXIT=0
- `node packages/main/dist/tasks/review-loop-smoke.js; echo EXIT=$?` -> EXIT=0

**DoneWhen**:
- Each passes standalone with assertions updated to the current correct messages/behavior
- review-loop: the 35 previously-passing sub-assertions remain unchanged; no regex broadened to accept wrong output
- Zero production change

## CHK-004: Content fix: remove the CJK that english-open-source-surface flags in usage-ledger-estimate-smoke.ts

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/tasks/usage-ledger-estimate-smoke.ts (remove/replace CJK at line ~229)
- Modify (only if scope-plan OQ resolution allows): packages/main/src/tasks/english-open-source-surface-smoke.ts (add allowlist entries for the out-of-scope functional-CJK test fixtures + pending-source-migration production files)

**Root causes (confirmed by survey + main-agent investigation)**:
- english-open-source-surface is NOT an assertion drift; it correctly flags CJK content. usage-ledger-estimate-smoke.ts:229 has a Japanese-text literal as a byte/char estimator test input. The estimator counts bytes/chars of any UTF-8 string; the actual CJK CONTENT is irrelevant to what's verified. Fix: replace the CJK input with an English/ASCII (or a non-CJK multibyte) string, keeping the byte-estimation assertion meaningful.
- IMPORTANT scope boundary: english-open-source-surface also flags 4 OTHER files that are OUT OF SCOPE: (a) packages/main/src/handlers/agent-prompt.ts and (b) packages/main/src/handlers/validate-docs-drift.ts are PRODUCTION code (do NOT touch); (c) packages/main/src/tasks/docs-drift-path-drift-smoke.ts and (d) packages/main/src/tasks/prompt-token-cost-smoke.ts have FUNCTIONAL CJK fixtures (testing Chinese-prose parsing / Chinese caveat matching) — removing that CJK would break their purpose. The smoke has a documented allowlist mechanism (ALLOWLIST_TEST_GLOBS for test files that deliberately assert legacy Chinese output; ALLOWLIST_PENDING_SOURCE_MIGRATION for production files pending translation). The proper in-scope resolution for these 4 is to add allowlist entries (NOT to gut the check, NOT to touch production). This is tracked as a scope-plan Open Question and will be resolved in writing before DEV; the implementer must follow the resolution exactly.

**Verify**:
- `node packages/main/dist/tasks/english-open-source-surface-smoke.js; echo EXIT=$?` -> EXIT=0
- `node packages/main/dist/tasks/usage-ledger-estimate-smoke.js; echo EXIT=$?` -> EXIT=0 (still 55 checks pass)

**DoneWhen**:
- english-open-source-surface passes standalone (no CJK flagged after in-scope fix + allowlisting per OQ resolution)
- usage-ledger-estimate.ts is English-only at the changed line and still passes its own assertions
- The english-open-source-surface CHECK logic itself is unchanged (only its allowlist data per OQ resolution); zero production file touched

## CHK-005: Triage + fix (or escalate) the remaining lifecycle smokes: gap-log, story-create-concurrency, review-pass-discard

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/tasks/gap-log-smoke.ts
- Modify: packages/main/src/tasks/story-create-concurrency-smoke.ts
- Modify: packages/main/src/tasks/review-pass-discard-smoke.ts

**Root causes (survey: likely STALE, implementer MUST confirm)**:
- gap-log: dedup message regex drift — expected `/identical gap already exists/`, actual "Gap deduped: ... reusing canonical finding..." (handlers/gap-log.ts dedup message). Confirm + update regex to current.
- story-create-concurrency: duplicate-detection message gained a "❌" emoji prefix — expected `/suspected duplicate story/`, actual "❌ Suspected duplicate of story ... (keyword fully overlaps: ...)". Confirm + update.
- review-pass-discard: wording changed "residue" -> "residuals" — expected `/Already DISCARDED; residue checked\/cleaned/`, actual "...is already DISCARDED; residuals checked/cleaned". Confirm + update.
- For EACH: run standalone, read the assertion failure + the production code, classify STALE (update test to current correct behavior) vs REAL-REGRESSION (STOP, report as a real finding, do NOT weaken). Do not assume stale — confirm.

**Verify**:
- `node packages/main/dist/tasks/gap-log-smoke.js; echo EXIT=$?` -> EXIT=0
- `node packages/main/dist/tasks/story-create-concurrency-smoke.js; echo EXIT=$?` -> EXIT=0
- `node packages/main/dist/tasks/review-pass-discard-smoke.js; echo EXIT=$?` -> EXIT=0

**DoneWhen**:
- Each either passes standalone (stale-fixed to current behavior) or is escalated as a confirmed real production bug with repro evidence — none silently weakened
- Zero production change for the stale-fixed ones
