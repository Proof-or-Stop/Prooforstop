# B-8404 Plan: Active Worktree File Overlap Guard

## CHK-001 Detect actual changed files for active story worktrees

Add a small read-only helper inside `packages/main/src/core/lattice-parallel-wave.ts` that derives material changed files for active story worktrees.

Rules:
- Use git from the story worktree path when available.
- Include committed branch changes against main, plus uncommitted tracked/untracked worktree changes.
- Normalize paths to repo-relative POSIX-style paths.
- Exclude Lattice/runtime-only paths: `.lattice/**`, `.koala/**`, `.omx/**`, owner-lease/runtime/cache/log style artifacts.
- If git probing fails, degrade visibly instead of throwing away the story.

User-visible output target:
- `parallel_plan`, `parallel_status`, and `parallel_merge_queue --format=json` should expose enough data for the operator to see which file overlaps and which peer story caused the risk.

## CHK-002 Integrate changed-file overlap into parallel safety and merge queue guidance

Feed actual material changed-file overlaps into the existing `ParallelWaveStoryRef` safety model.

Rules:
- An actual overlap with another active story should be a visible scheduling degradation.
- Stories with actual overlaps must not be recommended for simultaneous `parallel_dev`; they should degrade to `plan_only` unless a stronger existing dependency/blocker already blocks them.
- `parallel_merge_queue` should put the overlap in blockers/guidance so operators do not merge blindly.
- Preserve existing manually declared `sharedHotspots` behavior.

User-visible output target:
- JSON/text includes overlap file path and peer story id.
- Non-overlapping active stories remain eligible for `parallel_dev` when host capability and dependency checks pass.

## CHK-003 Preserve host-neutral and Authority boundaries

Keep all Parallel Wave surfaces read-only and non-authoritative.

Rules:
- No story metadata writes, evidence writes, receipt verification, host spawning, or Authority mutation.
- Preserve `authority.productionDone=false`, `authority.authorityChanged=false`, and `authority.receiptRefs=[]`.
- Do not reuse Authority receipt fields to describe local overlap facts.

User-visible output target:
- The command can warn/block local parallel scheduling while still saying it did not prove DONE or Authority completion.

## CHK-004 Add regression coverage for active worktree overlap behavior

Extend `packages/main/src/tasks/lattice-parallel-wave-smoke.ts` with deterministic fixture coverage.

Coverage:
- Two active story worktrees changing the same material file are detected without `sharedHotspots` metadata.
- The overlapping stories degrade out of `parallel_dev` and the queue guidance includes file + peer story.
- Lattice story/runtime metadata changes are ignored as overlap noise.
- A non-overlapping story remains a parallel candidate.
- Authority boundary assertions remain unchanged.

Verification commands:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/lattice-parallel-wave-smoke.js`
- `lattice parallel_merge_queue --storyIds='["<fixture-overlap-a>","<fixture-overlap-b>"]' --format=json` where possible in smoke or transcript form
