# B-d6a0 — Porcelain whole-output-trim audit: plan

## Problem

B-b264 fixed a porcelain-parsing bug class in two places. The class: a git helper that
`.trim()`s the FULL `git status --porcelain=v1` output strips the first row's leading
status column, so the first modified-tracked row (`" M .lattice/x"`) becomes
`"M .lattice/x"` and fixed-offset parsing (`line.slice(3)`) yields a corrupted path
(`".lattice/x"` → `"lattice/x"`). Every prefix-based classification downstream
(`isMaterialExcludedPath`, `.lattice/` material filters, `isVolatileRuntimeArtifactPath`)
then misfires. Untracked `??` rows never start with a space, so untracked-only fixtures
cannot catch the class. The B-b264 quality reviewer (run B-b264:RR-008) asked for a
dedicated audit of every remaining porcelain consumer.

## Audit method

`grep -rn "porcelain" packages/main/src` (2026-07-10, post-2895bbb5e). Each
`git status --porcelain` call site judged on TWO axes:

1. **Read pattern** — full-output `.trim()` (bug precondition) vs per-line `trimEnd()`
   vs untrimmed raw.
2. **Usage** — does the row reach path/status classification (bug expressed) or only
   count/emptiness checks (bug latent but inert)?

`git worktree list --porcelain` rows (`worktree <path>` / `HEAD <sha>` / `branch <ref>`)
never start with a space, so a full-output trim is a no-op for them: immune by format.

## Audit verdict table

### FIX — corrupted first row reaches classification or user-visible rows (this story)

| Site | Read | Downstream | Impact |
|---|---|---|---|
| `core/evidence-freshness.ts` `readMaterialDirtyFiles` (~153) | full trim | `slice(3)` → `isMaterialExcludedPath` | first-row `.lattice` metadata change pollutes `materialDirty` in evidence hash snapshots | CHK-001 |
| `handlers/cross-host-review.ts` `assertMaterialCleanForReview` (~74) | full trim | `slice(3)` → `.lattice/` prefix filter | first-row `.lattice` row misreads as material → false-blocks cross-host review preflight (fail-closed, still wrong) | CHK-002 |
| `handlers/story-query.ts` `gitPorcelainPaths` (226, via `gitOutput`) | full trim | `slice(3)` → `isVolatileRuntimeArtifactPath` at 945 (`story_sync_main` preflight) | first-row volatile path misreads as material → false "Cannot sync main" with corrupted path | CHK-003 |
| `handlers/story-query.ts` DONE-residue probe (~1017) | full trim | `safe` boolean is format-immune (`??` rows unaffected); stored `status` display corrupts | display-only | CHK-003 |
| `core/partial-done-recovery.ts` `assertMainWorktreeClean` (179, via `git()` at 23) | full trim | `statusLinePath` `slice(3)` → `isVolatileRuntimeArtifactPath` | first-row volatile artifact counts as material → `done_recover` falsely refuses | CHK-004 |
| `handlers/session.ts` `readGitStatus` (150) | full trim | rows displayed in session brief | first displayed row loses its status column | CHK-004 |

### SAFE by read pattern (no full-output trim; no change)

`core/dirty-worktree-gate.ts` `readGitStatusLines` (per-line trimEnd; also the status
source for `core/done-oracle.ts:434`); `core/validation-executor.ts` `readGitStatus`
(per-line trimEnd + `parseGitPorcelainRow`); `core/lattice-dispatch.ts` `gitStatusPaths`
(per-line trimEnd); `core/auto-commit-metadata.ts` `snapshotDirtyClassification`
(per-line trimEnd); `handlers/recover-evidence.ts` `readGitStatusLines` (per-line
trimEnd); `core/baseline-risk.ts` `collectBaselineRisk` (`replace(/\n+$/,'')` strips
trailing newlines only); `handlers/done-prepare.ts` `gitStatusRows` (B-b264 fix);
`core/done-prepare-generated-metadata.ts` `gitStatusRowsForDonePrepareGeneratedMetadata`
(B-b264 fix); `handlers/done-effects.ts` (B-72df, explicit no-trim comment);
`core/worktree-policy.ts` `parsePorcelain`/`captureGitStatus` (parses untrimmed
`res.stdout`; current callers are smoke-injected runners only);
`core/declared-artifact-commit-check.ts` `runGit` (returns untrimmed stdout; dirty =
any non-blank line).

### SAFE by usage (full or per-line trim present, but rows never parsed for paths)

`core/auto-commit-metadata.ts:193` (bounded `-- <storyRel>` emptiness);
`cli-engine.ts:631` (bounded emptiness); `cli/init-check-metadata-sync.ts:147` (bounded
emptiness); `core/safe-init-commit.ts:121` (bounded emptiness);
`core/verification-context-pack.ts:455` (`.length > 0` only); `handlers/release.ts:50`
(emptiness; dirty rows echoed in an error message — first-row cosmetic accepted);
`handlers/worktree.ts:656/662/1024/1093/1229` (bounded/emptiness; error-message echo
cosmetic accepted); `core/auxiliary-worktree-cleanup.ts:299` (emptiness; `statusOutput`
echo cosmetic accepted); `dashboard.ts:130` (count-only); `core/rollout-check.ts:239`
(`gitLines` per-line full trim; count-only); `core/managed-assets.ts:350` (count +
whitespace-collapsed sample display).

### Shift-tolerant (works today; documented, not modified)

`handlers/worktree.ts:617` `purgeSafeInitCommit` — parses via
`line[2] === ' ' ? line.slice(3) : line.slice(2)`, which recovers the 1-char shift the
full-trim `git()` helper introduces, and only compares status against `??`. Correct by
accident; left untouched under the minimal-diff principle, recorded here so a future
refactor knows the tolerance is load-bearing.

### Immune by format (`git worktree list --porcelain`; no change)

`core/partial-done-recovery.ts:56`, `core/lattice-dispatch.ts:1385`,
`core/worktree-runtime.ts:90`, `core/learning-store.ts:140`,
`core/managed-assets.ts:362`, `core/runtime-environment-checks.ts:756`,
`handlers/doctor.ts:624`, `handlers/worktree.ts:508`, `handlers/done-effects.ts:118`,
`handlers/session.ts:292`, `cli/runtime-root.ts:20`, `dashboard.ts:74`.

### Out of scope

`packages/main/src/tasks/*` smoke harnesses' local git helpers drive fixtures only; the
production helpers they exercise are covered above. CHK-005 adds the new regression
smoke to this set.

## CHK-001 — evidence-freshness.ts readMaterialDirtyFiles

Drop the full-output `.trim()`; read raw, then `split('\n').map(trimEnd).filter(Boolean)`
and keep the existing `line.length < 4` guard and rename handling. Empty-tree decision
moves from `if (!raw)` to `rows.length === 0`. A one-line comment states the constraint
(full-output trim eats the first row's status column), matching the B-b264 comments.
Verified via `captureEvidenceHashSnapshot` in the regression smoke.

## CHK-002 — cross-host-review.ts assertMaterialCleanForReview

Same raw-read conversion inside `assertMaterialCleanForReview`; the `.lattice/` material
exclusion then sees the true first-row path. Export the function (comment: exported for
the porcelain first-row regression smoke) so the smoke can call it directly; no CLI
surface change.

## CHK-003 — story-query.ts gitPorcelainPaths + DONE-residue status

`gitPorcelainPaths` stops routing through `gitOutput()` (which full-trims and serves
many non-porcelain callers — left unchanged) and does its own raw read + per-line
trimEnd; export it for the smoke. The DONE-residue probe (~1017) replaces `.trim()`
with per-line trimEnd rows; the `safe` boolean logic (`startsWith('?? ')`) is unchanged
(already format-immune), only the stored/displayed `status` text stops corrupting.

## CHK-004 — partial-done-recovery.ts assertMainWorktreeClean + session.ts brief rows

`assertMainWorktreeClean` reads via a new local `gitStatusRaw()` (execFileSync, no trim)
feeding `materialStatusLines` unchanged; the shared `git()` helper keeps its trim for
its many non-porcelain callers. `assertStoryWorktreeClean` (emptiness-only) is
unchanged. `handlers/session.ts` `readGitStatus` switches to per-line trimEnd rows
(same slice(0,20) cap); exported for the smoke.

## CHK-005 — regression smoke + audit record

New smoke `packages/main/src/tasks/porcelain-first-row-audit-smoke.ts` (details in
"Test plan" below) + `test:porcelain-first-row-audit` script; this plan.md section IS
the recorded audit verdict (table above). Run RED before the fixes land (repro-first),
GREEN after; full `run-all-smokes` stays green.

## Fix pattern (uniform, per-site)

The B-b264 pattern (`gitStatusRows` in `handlers/done-prepare.ts`, `gitRaw` +
`gitStatusRowsForDonePrepareGeneratedMetadata` in
`core/done-prepare-generated-metadata.ts`):

```ts
const raw = execFileSync('git', ['status', '--porcelain=v1', ...], { ... }); // NO .trim()
const rows = raw.split('\n').map(line => line.trimEnd()).filter(Boolean);
```

Emptiness decisions move from raw-string truthiness to `rows.length === 0` so a
clean-tree `''` and a whitespace-only output behave identically. Shared helpers that
also serve non-porcelain callers (`gitOutput` in story-query, `git()` in
partial-done-recovery) are NOT changed; the porcelain call sites stop routing through
them instead.

## Test plan (CHK-005, repro-first)

New smoke `packages/main/src/tasks/porcelain-first-row-audit-smoke.ts` (+
`test:porcelain-first-row-audit` script in `packages/main/package.json`; picked up by
`run-all-smokes` via the `dist/tasks/*-smoke.js` convention). Written and run RED
against the unfixed code first (bug story: repro precedes fix), then GREEN after the
per-site fixes.

Fixture: temp-dir git repo; tracked `.lattice/...` metadata file sorting before a
tracked material file; modify both so porcelain row 0 is `" M .lattice/..."` — every
scenario asserts row 0 matches `/^ M /` before asserting classification (guards against
fixture drift making the regression vacuous).

Assertions per fixed site (exact-path pattern:
`assertModifiedTrackedPathExactness` in `tasks/done-prepare-merge-rerun-smoke.ts`):

1. `captureEvidenceHashSnapshot` (`core/evidence-freshness.ts`): `dirty.files` contains
   the exact material path, no corrupted `lattice/...` entry, and respects
   `isMaterialExcludedPath` for the first-row metadata path.
2. `assertMaterialCleanForReview` (`handlers/cross-host-review.ts`, exported for the
   smoke): `.lattice`-only dirty tree with a first-row ` M` row does NOT throw;
   adversarial: a material ` M` row still throws naming the exact path.
3. `gitPorcelainPaths` (`handlers/story-query.ts`, exported for the smoke): first entry
   is the exact `.lattice/...` path with its leading dot.
4. `assertMainWorktreeClean` (`core/partial-done-recovery.ts`): volatile-only first-row
   ` M` dirt does not refuse; material dirt refuses naming the exact path.
5. `readGitStatus` (`handlers/session.ts`, exported for the smoke): `porcelain[0]`
   matches `/^ M /`.

Full suite `node packages/main/dist/tasks/run-all-smokes.js` must stay green
(pre-mortem: new exports must not break `cli-surface-smoke` / `command-catalog-smoke`).

## Rollout

Single story branch; per-CHK commits; REVIEW per assurance floor (material gate-adjacent
code → expect quorum); DONE merge auto-bumps + rebuilds dist per B-aa8a.
