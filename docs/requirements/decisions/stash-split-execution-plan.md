# Stash Split Execution Plan

## Purpose

Safely process `stash@{0}` without applying the whole stash. The stash was
created on main as `park unrelated lattice path cleanup and layer4 doc before
B-b5b2 DONE` and contains multiple unrelated buckets. Each bucket must become a
separate future Lattice story with its own tests and evidence.

## Non-Negotiable Rules

1. Do not run `git stash pop stash@{0}`.
2. Do not run whole-stash `git stash apply stash@{0}`.
3. Do not restore the whole stash tree or checkout `stash@{0}` over `.`.
4. Do not drop `stash@{0}` until every accepted bucket has landed or been
   explicitly rejected, and record the stash object hash before any final drop.
5. Inspect untracked files with `--include-untracked` or the third stash parent.
   A normal stash diff omits them.
6. Restore untracked files only from the captured stash object's third parent
   (`${STASH_OBJECT}^3`) and only by explicit path.
7. Keep `.lattice/dev-memory/experience.jsonl` excluded by default by not
   restoring, staging, or committing it. It is local runtime data, not a normal
   source artifact.
8. Defer the `packages/main/src/core/planner.ts` hash hunk unless a failing
   repro or focused test proves that planner hash behavior is currently wrong.

## Current Stash Inventory

Mechanical inventory command:

```bash
EXPECTED_STASH_OBJECT=c4dcc3aff95fd999712d7f19dcf856f791cf0d05
STASH_OBJECT=$(git rev-parse 'stash@{0}')
test "$STASH_OBJECT" = "$EXPECTED_STASH_OBJECT"
git log -1 --format=%s "$STASH_OBJECT" | grep -Fx 'On main: park unrelated lattice path cleanup and layer4 doc before B-b5b2 DONE'
git stash show --name-status --include-untracked "$STASH_OBJECT"
git ls-tree -r --name-only "${STASH_OBJECT}^3"
```

Observed paths:

```text
M  .gitignore
A  .lattice/dev-memory/experience.jsonl
M  docs/requirements/NAV.md
M  docs/requirements/decisions/lifecycle-artifact-scope.md
A  docs/requirements/decisions/unlock-layer4-production-safety-suite.md
M  packages/main/src/core/dev-memory.ts
M  packages/main/src/core/lattice-parallel-wave.ts
M  packages/main/src/core/planner.ts
M  packages/main/src/core/rollout-check.ts
M  packages/main/src/core/runtime-artifact-registry.ts
M  packages/main/src/handlers/dev-memory.ts
M  packages/main/src/tasks/flow-stability-smoke.ts
```

Untracked stash paths:

```text
.lattice/dev-memory/experience.jsonl
docs/requirements/decisions/unlock-layer4-production-safety-suite.md
```

## Bucket Split

### Bucket A: Dev Memory Data Handling

Scope:

```text
packages/main/src/core/dev-memory.ts
packages/main/src/handlers/dev-memory.ts
```

Handling:

- Treat `.lattice/dev-memory/experience.jsonl` as inspection-only local runtime
  data for this bucket.
- Do not restore, stage, or commit `.lattice/dev-memory/experience.jsonl`.
- Do not treat the stashed `.gitignore` hunk as the mechanism for dev-memory
  exclusion. If a future story changes ignore policy, it must do so explicitly
  with its own acceptance evidence.
- If a future story needs to inspect the data file, use:

```bash
git show "${STASH_OBJECT}^3:.lattice/dev-memory/experience.jsonl"
```

Acceptance:

- Focused dev-memory tests pass.
- `git status --porcelain` does not show `.lattice/dev-memory/experience.jsonl`
  as restored, staged, or tracked.

### Bucket B: Runtime Artifact Cleanup

Scope:

```text
.gitignore
docs/requirements/decisions/lifecycle-artifact-scope.md
packages/main/src/core/lattice-parallel-wave.ts
packages/main/src/core/runtime-artifact-registry.ts
```

Handling:

- Keep runtime artifact semantics in the runtime artifact registry, not in
  process fact registries.
- Keep material hash, baseline risk, repair, and gitignore semantics aligned
  with the registry instead of hard-coding paths in separate call sites.
- Do not use the `.gitignore` hunk to claim dev-memory data is ignored; that is
  outside this bucket unless a future story explicitly changes ignore policy.

Acceptance:

- Runtime artifact contract verification passes.
- `lattice doctor` reports the intended runtime artifact scan semantics.
- Any docs touched in this bucket describe only runtime artifact policy.

### Bucket C: Smoke Expectation Repairs

Scope:

```text
packages/main/src/core/rollout-check.ts
packages/main/src/tasks/flow-stability-smoke.ts
```

Handling:

- Treat smoke expectation changes as behavior fixes, not cleanup.
- Restore only these paths for this bucket.
- Add or run the narrow smoke command that reproduces the current mismatch.

Acceptance:

- The focused smoke test fails before the bucket hunk and passes after it.
- No runtime registry, planner hash, Layer4 doc, or dev-memory behavior changes
  are included in the same commit.

### Bucket D: Layer 4 Documentation

Scope:

```text
docs/requirements/NAV.md
docs/requirements/decisions/unlock-layer4-production-safety-suite.md
```

Handling:

- Restore the new untracked Layer 4 document from the third stash parent:

```bash
git restore --source "${STASH_OBJECT}^3" -- docs/requirements/decisions/unlock-layer4-production-safety-suite.md
```

- Do not restore `docs/requirements/NAV.md` from the captured stash object. The
  stashed NAV hunk is stale relative to the current catalog.
- Hand-merge only the Layer 4 NAV link and count update from the current NAV
  state.
- Preserve existing `Unlock Layer 2 Engineering Baseline Suite`,
  `Unlock Layer 3 Loop Engineering Baseline Suite`, and
  `Root Document Migration Guide`, and `Stash Split Execution Plan` NAV entries.
- After adding the Layer 4 document, NAV should count the then-current catalog
  plus one requirement file (38 immediately after this story lands).

Acceptance:

- NAV count and link count agree.
- The Layer 2, Layer 3, root migration, and Layer 4 links are all present.
- No code files are included in the documentation commit.

### Bucket E: Planner Hash Hunk

Scope:

```text
packages/main/src/core/planner.ts
```

Handling:

- Defer by default.
- First create a failing repro or focused test showing that planner hash
  behavior is wrong.
- Only then restore the specific `planner.ts` hunk and keep the commit limited
  to the proven planner defect.

Acceptance:

- The repro fails before the hunk and passes after it.
- If no failing repro exists, leave this bucket untouched and document the
  deferral in the future story.

## Path-Limited Recovery Procedure

1. Record the stash identity:

```bash
EXPECTED_STASH_OBJECT=c4dcc3aff95fd999712d7f19dcf856f791cf0d05
STASH_OBJECT=$(git rev-parse 'stash@{0}')
test "$STASH_OBJECT" = "$EXPECTED_STASH_OBJECT"
git log -1 --format=%s "$STASH_OBJECT" | grep -Fx 'On main: park unrelated lattice path cleanup and layer4 doc before B-b5b2 DONE'
git stash show --name-status --include-untracked "$STASH_OBJECT"
git ls-tree -r --name-only "${STASH_OBJECT}^3"
```

2. Start one future story per bucket from a clean worktree.

3. Inspect tracked hunks without applying them:

```bash
git diff "${STASH_OBJECT}^1" "$STASH_OBJECT" -- <tracked-paths>
```

4. Restore only approved tracked paths for the current bucket:

```bash
git restore --source "$STASH_OBJECT" -- <tracked-paths>
```

   Exclude stale index/catalog files such as `docs/requirements/NAV.md` from
   generic tracked-path restore. Reconcile those by hand from the current file.

5. Restore only approved untracked paths from the third stash parent:

```bash
git restore --source "${STASH_OBJECT}^3" -- <untracked-paths>
```

6. Immediately run `git status --porcelain` and verify that only the current
   bucket paths changed.

7. Run the bucket acceptance checks, commit the bucket, and advance that story
   through review and validation.

8. Repeat for the next bucket. Keep the stash until all buckets are closed.

## Final Stash Retirement

Only after all accepted buckets are merged and rejected buckets are documented:

1. Record the resolved `STASH_OBJECT` and matching expected hash in the final
   story evidence.
2. Confirm no bucket still depends on the stash.
3. Ask a human owner before dropping the exact stash ref or object.
