# B-8963 Plan: command-local hash snapshot reuse

## CHK-001
Define a command-local evidence hash snapshot in `packages/main/src/core/evidence-freshness.ts`.

Implementation notes:
- Capture `headHash`, `materialHash`, `storyFilesHash`, metadata root, git cwd, ref, and material dirty state as one coherent binding.
- Keep the primitive command-local and stateless. It must not write a cache file and must not use mtime or file-count as freshness proof.
- Add a cheap reusability check based on same git cwd/ref/metadata root, same HEAD, and no material dirty files.

Verification:
- Logic smoke covers coherent capture and dirty-state invalidation.

## CHK-002
Thread the snapshot through DONE and review assurance consumers.

Implementation notes:
- Prefer passing a single binding into DONE oracle review escalation and review assurance floor evaluation.
- Preserve existing fallback behavior when no snapshot is supplied.
- Use the snapshot to avoid recomputing material/story hashes independently inside one command path.

Verification:
- Existing review escalation and DONE closure smokes continue to pass.
- New focused smoke proves supplied binding is consumed and stale supplied binding is not trusted.

## CHK-003
Prove reuse does not admit stale evidence.

Implementation notes:
- Add or extend smoke coverage for unchanged-state reuse, story-owned file drift, and dirty material worktree state.
- The dirty material path should fail reusability before a consumer can treat an old snapshot as current.

Verification:
- Build and focused smoke pass.
- `lattice validate` covers the story verification evidence.

## CHK-004
Document the syndrome-preflight boundary.

Implementation notes:
- Update the proof-admissibility hardening plan with a short subsection describing command-local syndrome preflight.
- Explicitly reject mtime/file-count keys, persistent caches, and fountain-code or erasure-code recovery as evidence semantics.

Verification:
- Docs check references the new subsection and the implementation boundary remains aligned with the story scope.
