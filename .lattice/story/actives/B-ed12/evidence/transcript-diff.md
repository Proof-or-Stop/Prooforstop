# B-ed12 transcript-diff (real-machine TEST evidence)

Story: Stabilize the ~13 stale smoke tests that rotted while the suite was ungated.
Approach: per-smoke, confirm CURRENT correct production behavior + the story that changed it, THEN update the test assertion. Zero production change. Never weaken an assertion.

## 1. Expected vs Actual (PLAN outcome vs real run)

**Expected (PLAN outcome):** each fixed smoke runs standalone green (exit 0) with safety intent intact; `npm run test:all` goes from main's 140/162 to ~153/162 (~13 fewer failures); remaining failures = only the deferred P5 timeout/env family. Zero production (non-test) files changed.

**Actual:** all 15 in-scope smokes pass standalone (exit 0). `lattice validate --story=B-ed12`: status pass, allPass true, verification coverage 15/15, missingRequired 0. `npm run test:all` in the worktree = **155–156/162** (two runs: 156/162 and 155/162; the 1-test wobble is the P5 timeout family hitting the 60s boundary). That is **+15–16 vs main's 140/162** — meeting or exceeding the predicted ~13. Remaining failures are the deferred P5/env family (see §4). **Zero production files changed** (§3).

## 2. Per-smoke standalone runs (before -> after)

Run: `npm --prefix packages/main run build && node packages/main/dist/tasks/<name>-smoke.js; echo EXIT=$?`

| smoke | BEFORE (on main) | AFTER (this story) | STALE root cause + behavior-change story (production CONFIRMED correct) |
|---|---|---|---|
| init-check-fallback | FAIL (asserted `/missing_init_check/`, got `[missing_scope_boundary]`) | PASS exit0 | Production checks scope-boundary.json BEFORE init-check at INIT_CHECK (core/machine.ts). Test now seeds scope_boundary_set+execution_boundary_set+scope_freeze_check before advancing, mirroring the real flow; fallback/`missing_init_check` intent intact. |
| init-check-required-agents | FAIL (`/missing_init_check_agent/` vs `[missing_scope_boundary]`) | PASS exit0 | Same scope-boundary precedence. Seeds scope-boundary + re-freezes after story_update; required-agents/product-reviewer/init_check_tampered assertions intact. |
| done-preflight | FAIL (generic "Cannot enter DONE" vs merge-failure path) | PASS exit0 | B-72df scoped the dirty-main DONE clean-check to merge-affected paths (handlers/done-effects.ts ~371). Test now asserts B-72df scoped semantics AND was STRENGTHENED: NO BYPASS (main store phase stays TEST, main HEAD unchanged, branch+worktree survive/recoverable). |
| worktree-repair | FAIL (asserted `'relinked'`, got `'skipped'`) | PASS exit0 | B-097f host-neutral single-source agent prompts (project-local link repair is a no-op; canonical-only resolver). Test asserts post-B-097f `'skipped'` + STRENGTHENED: canonical untouched, unmanaged legacy symlink NOT relinked. |
| story-dedup | FAIL (`'Japanese-task'` vs `'japanese-task'`) | PASS exit0 | normalizeName lowercases all output incl. Unicode (story-dedup.ts). Test expects normalized lowercased slug (consistent with existing café-story case). |
| convergence-discarded | FAIL (expected true, got undefined) | PASS exit0 | checkConvergence check name renamed zh->en `All Stories completed` + detail `No parked backlog` (gap-analyze.ts:349, commit 6fff2110f). Test asserts current name/detail. |
| cli-argument-ergonomics | FAIL (`/Parameter validation failed/`) | PASS exit0 | Message changed to "Argument validation failed" (cli-engine.ts:2595/2598). Regex updated to exact current text (not broadened). |
| lattice-only-absence | FAIL (expected 'fail', got 'pass') | PASS exit0 | NOT a bug: B-097f runtime-owned manifest (`.lattice-codex/lattice.json` no longer required; legacy koala.json ignored). Asserts manifest pass AND keeps rejection proof: codex.ok===false + local-wrapper fail. |
| lattice-cli-migration | FAIL (`/Primary entrypoint/`, alias true) | PASS exit0 | koala->lattice rename done: help "Primary entrypoint:"->"Entrypoint:" (cli-engine.ts:2605); B-decb removed the legacy koala bin alias so legacyKoalaAliasPreserved is now a deliberate `false`. Both updated to migrated state. |
| review-loop | FAIL (3/38: `opts.store.storyDirPath is not a function`) | PASS exit0 (38/38) | B-c55d added store.storyDirPath to the review_loop_start path. Test's store MOCK gained storyDirPath + storyId; the other 35 sub-assertions byte-for-byte unchanged. |
| usage-ledger-estimate | PASS (already) -> PASS | PASS exit0 (55 checks) | Already passing functionally. CHK-004 is a content fix: replaced the Japanese-text estimator INPUT with a non-CJK multibyte string (`naive cafe` w/ accents); STRENGTHENED assertion from `>0` to exact `==3`. |
| english-open-source-surface | FAIL (CJK flagged in 5->6 files) | PASS exit0 (565 files scanned) | Working as intended. In-scope CJK removed from usage-ledger smoke; 4 functional-CJK test fixtures (docs-drift-path-drift, prompt-token-cost, done-preflight) allowlisted to ALLOWLIST_TEST_GLOBS + 2 production files (agent-prompt.ts, validate-docs-drift.ts) to ALLOWLIST_PENDING_SOURCE_MIGRATION per OQ-1. CHECK logic UNCHANGED; zero production file touched. |
| gap-log | FAIL (`/identical gap already exists/`) | PASS exit0 | Dedup message reworded to "Same gap already exists (fingerprint hit), reusing canonical finding" (gap-log.ts:223). Dedup BEHAVIOR confirmed correct (collapses to ONE finding). Also fixed 2 sibling wording drifts; rejection-throws intact. |
| story-create-concurrency | FAIL (`/suspected duplicate story/`) | PASS exit0 | Duplicate message gained "❌ Suspected duplicate of story ... (keyword fully overlaps: ...)" prefix (story-create.ts:445). Hard-block (non-zero exit) intact; updated several sibling wording drifts to exact current strings. |
| review-pass-discard | FAIL (`residue checked/cleaned`) | PASS exit0 | Wording "residue"->"residuals" (worktree.ts:1380). Residue cleanup proven (worktree/branch removed before message); fail-closed test intact (ok=false, phase stays INIT_CHECK, branch survives). |

## 3. Zero production change (whole-story invariant)

`git diff main...HEAD --name-only | grep -v '^.lattice/'` returns EXACTLY 15 files, all `packages/main/src/tasks/*-smoke.ts`. No `../core/*`, `../handlers/*`, `cli-engine.ts`, or any non-test file changed. Verified at REVIEW (quality + test-coverage reviewers) and TEST.

## 4. test:all delta + remaining failures

- main baseline (per story triage): **140/162** (22 failing).
- worktree after B-ed12: **155–156/162** (~+15–16; ≥ the predicted ~13).

Remaining failures (all out of scope = the deferred P5 timeout/env family):
- authority-job-loop-live (FAIL) — P5 authority
- autopilot-authority (FAIL) — P5 autopilot
- cli-json-stdout-contract (TIMEOUT) — P5 env
- dispatch-run (TIMEOUT) — P5
- lattice-baseline (TIMEOUT) — P5 baseline
- planner-unattended (TIMEOUT) — P5
- story-owner-lease (FAIL in full-suite run only) — NOT in my diff; an env/ordering artifact of running the full suite INSIDE an active-lease story worktree (this story used forceTakeover twice). It PASSES standalone in the worktree (exit 0) AND PASSES on main HEAD. Not a B-ed12 regression.

## 5. Real-bug escalations

NONE. Every one of the 14 failing smokes was confirmed STALE (a changed-but-intended expectation), not a masked production regression. No assertion was weakened or deleted; several were strengthened (done-preflight no-bypass, worktree-repair, usage-ledger). Zero production code changed.
