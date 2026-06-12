# B-5cc7 Real-Machine Transcript Diff

Story: B-5cc7 — Execute stash bucket A dev-memory legacy read fallback
Phase recorded in TEST.

## Expected

- Bucket A restores only dev-memory legacy read fallback behavior.
- `.lattice` remains canonical writable dev-memory storage.
- `.koala` is read-only legacy fallback only.
- `KOALA_GLOBAL_MEMORY_DIR` can contribute legacy read fallback, but cannot redirect writable global storage.
- `parallel_dispatch` / `parallel_report` experience refs use the same dev-memory reader semantics.
- `dev_memory_start` emits `lattice dev_memory_finish` guidance, not `koala dev_memory_finish`.
- `.lattice/dev-memory/experience.jsonl` from the stash is not restored, staged, tracked, or committed.
- Dev-memory refs remain non-authoritative context, not gate evidence or production Authority receipt.

## Actual Commands

```bash
npm --prefix packages/main run build && node packages/main/dist/tasks/dev-memory-legacy-read-smoke.js
```

Result:

```text
> @koala-agent/core@0.3.5 build
> tsc

✓ dev-memory legacy read smoke passed
```

```bash
KOALA_SESSION_ID=sess-c91ef614bc20db4e lattice validate --story=B-5cc7 --json
```

Result summary:

```text
status=pass
allPass=true
Verification intent coverage: 9/9 covered
Fallback validation command: npm test
```

```bash
lattice evidence_inspect '{"storyId":"B-5cc7","format":"json"}'
```

Result summary:

```text
freshness.status=fresh
staleRefs=[]
authority.productionDone=false
authority.receiptRefsVerified=false
authority.canManufactureAuthority=false
```

```bash
git show stash@{0}^3:.lattice/dev-memory/experience.jsonl | wc -l
```

Result:

```text
23
```

```bash
git status --short --untracked-files=all
git diff --name-status main...HEAD | rg '.lattice/dev-memory/experience.jsonl|\.koala/dev-memory/experience.jsonl|\.gitignore|runtime-registry|runtime-artifact-registry|planner|NAV|Layer4|layer4' || true
```

Result:

```text
No dev-memory data file restore and no unrelated Bucket B/C/D/E paths were present.
```

## Diff Notes

- The implementation reads current `.lattice` project/global dev-memory plus read-only legacy `.koala` fallback.
- Writes still target canonical `.lattice` storage only.
- `lattice-parallel-wave` now uses `readProjectMemoryEntries` / `readGlobalMemoryEntries` for experience refs.
- `dev_memory_start` user guidance uses `lattice dev_memory_finish`.
- `docs/requirements/decisions/dev-memory.md` and `docs/requirements/decisions/lattice-parallel-wave.md` now match the implementation.
- Findings F-001 through F-006 are resolved; final concept, quality, test-coverage, and docs reviewers recorded fresh passes.

## User-Value Check

The user-visible outcome is that Lattice can safely consume migrated `.koala` dev-memory as advisory context without writing new data back into legacy `.koala` locations and without treating dev-memory as Authority or gate evidence.
