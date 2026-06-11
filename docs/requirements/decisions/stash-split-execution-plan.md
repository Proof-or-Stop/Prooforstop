# Stash Split Execution Plan

## Purpose

Safely process `stash@{0}` without applying the whole stash. The stash was
created on main as `park unrelated lattice path cleanup and layer4 doc before
B-b5b2 DONE` and contains multiple unrelated buckets. Each bucket must become a
separate future story or commit with its own tests and evidence.

## Non-Negotiable Rules

1. Do not run `git stash pop stash@{0}`.
2. Do not run whole-stash `git stash apply stash@{0}`.
3. Do not restore the whole stash tree or checkout `stash@{0}` over `.`.
4. Do not drop `stash@{0}` until every accepted bucket has landed or been
   explicitly rejected, and record the stash object hash before any final drop.
5. Inspect untracked files with `--include-untracked` or the third stash parent.
   A normal stash diff omits them.
6. Restore untracked files only from `stash@{0}^3` and only by explicit path.
7. Keep `.lattice/dev-memory/experience.jsonl` excluded by default. It is local
   runtime data, not a normal source artifact.
8. Defer the `packages/main/src/core/planner.ts` hash hunk unless a failing
   repro or focused test proves that planner hash behavior is currently wrong.

## Current Stash Inventory

Mechanical inventory command:

```bash
git stash show --name-status --include-untracked 'stash@{0}'
git ls-tree -r --name-only 'stash@{0}^3'
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

### Bucket A: Dev Memory Default Exclusion

Scope:

```text
.gitignore
packages/main/src/core/dev-memory.ts
packages/main/src/handlers/dev-memory.ts
```

Handling:

- Keep `.lattice/dev-memory/experience.jsonl` ignored by default.
- Do not commit `.lattice/dev-memory/experience.jsonl`.
- If a future story needs to inspect the data file, use:

```bash
git show 'stash@{0}^3:.lattice/dev-memory/experience.jsonl'
```

Acceptance:

- `git check-ignore .lattice/dev-memory/experience.jsonl` reports it ignored.
- Focused dev-memory tests pass.
- `git status --porcelain` does not show `.lattice/dev-memory/experience.jsonl`
  as staged or tracked.

### Bucket B: Runtime Artifact Cleanup

Scope:

```text
docs/requirements/decisions/lifecycle-artifact-scope.md
packages/main/src/core/lattice-parallel-wave.ts
packages/main/src/core/runtime-artifact-registry.ts
```

Handling:

- Keep runtime artifact semantics in the runtime artifact registry, not in
  process fact registries.
- Keep material hash, baseline risk, repair, and gitignore semantics aligned
  with the registry instead of hard-coding paths in separate call sites.
- Do not add `.omx/` or OMX-derived paths as runtime artifacts.

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
git restore --source 'stash@{0}^3' -- docs/requirements/decisions/unlock-layer4-production-safety-suite.md
```

- Restore or hand-merge the `docs/requirements/NAV.md` hunk for this bucket only.
- Preserve existing `Unlock Layer 2 Engineering Baseline Suite`,
  `Unlock Layer 3 Loop Engineering Baseline Suite`, and
  `Root Document Migration Guide` NAV entries.
- After adding the Layer 4 document, NAV should count 37 requirement files in
  the current catalog shape.

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
git rev-parse 'stash@{0}'
git stash show --name-status --include-untracked 'stash@{0}'
git ls-tree -r --name-only 'stash@{0}^3'
```

2. Start one future story per bucket from a clean worktree.

3. Inspect tracked hunks without applying them:

```bash
git diff 'stash@{0}^1' 'stash@{0}' -- <tracked-paths>
```

4. Restore only approved tracked paths for the current bucket:

```bash
git restore --source 'stash@{0}' -- <tracked-paths>
```

5. Restore only approved untracked paths from the third stash parent:

```bash
git restore --source 'stash@{0}^3' -- <untracked-paths>
```

6. Immediately run `git status --porcelain` and verify that only the current
   bucket paths changed.

7. Run the bucket acceptance checks, commit the bucket, and advance that story
   through review and validation.

8. Repeat for the next bucket. Keep the stash until all buckets are closed.

## Final Stash Retirement

Only after all accepted buckets are merged and rejected buckets are documented:

1. Record `git rev-parse 'stash@{0}'` in the final story evidence.
2. Confirm no bucket still depends on the stash.
3. Ask a human owner before dropping the exact stash ref or object.
