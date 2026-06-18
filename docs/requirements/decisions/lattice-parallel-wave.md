# Lattice Parallel Wave

Parallel Wave is a collection-level scheduling and recovery projection for
multi-story Koala delivery. It reads existing Canonical Story v0 projections,
host capability profiles, story dependency metadata, and shared hotspot hints,
then emits a wave plan that helps operators decide which stories can proceed in
parallel worktrees.

It is not authority evidence. A wave artifact is local planning state only: it
cannot satisfy REVIEW, TEST, DONE, delivery, receipt, or production authority
gates. Each JSON surface keeps the non-authority boundary explicit with
`authority.productionDone=false`, `authority.authorityChanged=false`, and
`authority.receiptRefs=[]`; no surface emits production completion, non-empty
`receiptRefs`, or auto-spawned runner state.

## Lattice Mapping

- Canonical Story remains the story-level source projection. Parallel Wave does
  not extend or rewrite Canonical Story v0.
- Wave story refs point at Canonical Stories by `storyId`, lifecycle phase,
  lane, safety, dependencies, hotspots, evidence refs, and recovery refs.
- Host candidates come from the Lattice capability registry. Capability gaps are
  visible degradations and do not create receipts.
- Evidence refs are lineage references only. They are useful for recovery and
  validation planning, but the wave does not refresh evidence, submit evidence,
  verify receipts, or grant authority.
- Active story worktrees are inspected with read-only git probes to project
  material changed files. Committed changes against `main`, uncommitted tracked
  changes, and untracked files are compared across active stories; runtime
  and story metadata are excluded only through the shared material-exclusion
  classifiers (`isStoryMetadataPath` plus the runtime artifact registry), not by
  blanket root or filename filters. A failed changed-file probe anywhere in the
  active story collection degrades selected stories to local planning-only
  guidance until every active worktree projection can be collected. Actual
  material file overlaps are local scheduling degradations only.
- Merge order is guidance for sequencing integration. It does not replace Koala
  lifecycle gates.

## Commands

Lattice CLI 0.3.5 is the primary product entrypoint for these commands. The
legacy `koala` alias remains compatible.

`parallel_wave_create` creates a wave projection from story refs, or from active
stories when refs are omitted. Optional `output` writes JSON with no overwrite.

`parallel_wave_inspect` reads an existing wave JSON file and reports the same
non-authoritative scheduling facts plus inspection counts. Optional `output`
writes JSON with no overwrite.

`parallel_plan` builds a parallel execution plan either from a wave file or by
analyzing active stories directly. Optional `output` writes JSON with no
overwrite.

`parallel_dispatch` projects one dispatch entry per wave story. Entries contain
`storyId`, `title`, `recommendation`, `dispatchable`, `agentRole`, `spawned`,
`requiresRunnerConfirmation`, `recommendedHostIds`, optional `worktreePath` and
`branch`, `nextCommand`, `blockers`, `degradations`, `evidenceRefs`, and bounded
non-authoritative `experienceRefs`. `agentRole` is `implementer` for
`parallel_dev`, `planner` for `plan_only`, and `blocked` for `blocked`.
`spawned` is always `false`; the runner must explicitly confirm any follow-up.

`parallel_status` projects wave counts, parallel DEV candidates, plan-only
stories, blocked stories, and ready/blocked merge guidance.

`parallel_merge_queue` projects integration ordering from `mergeOrder`, split
into ready and blocked entries with blockers and guidance.

`parallel_report` combines the dispatch projection, count summary, ready/blocked
guidance, evidence lineage, and optional bounded dev-memory refs.

All seven commands are read-only workflow commands: they may write a caller
requested output artifact, but they do not mutate story metadata, process
evidence, lifecycle state, receipts, authority state, production completion, or
spawn agent runners. They are process fact level L0.

Related migration diagnostics are also L0/read-only:

- `host_list` / `lattice host list`
- `host_probe` / `lattice host probe`
- `host_install` / `lattice host install` (dry-run guidance only)
- `lattice_config_doctor` / `lattice config doctor`
- `authority_status` / `lattice authority status`
- `conduit_status` and `conduit_explain` / `lattice conduit ...`

These surfaces replace Mac App provider/config dashboard requirements for the
0.3.5 migration. The Mac App remains optional dashboard/archive only.

## Base Wave JSON Contract

The base wave/create/inspect/plan surfaces are the only JSON outputs that carry
the full wave envelope. `parallel_wave_create`, `parallel_wave_inspect`, and
`parallel_plan` include:

- `schemaVersion`
- `waveId`
- `storyRefs` with story id, title, phase, lane, safety, dependency summary,
  hotspot summary, visible degradations, evidence refs, and recovery refs
- `hostCandidates` with capability status and degradation summaries
- top-level `evidenceRefs`
- `mergeOrder`
- `authority.productionDone=false`
- `authority.authorityChanged=false`
- `authority.receiptRefs=[]`

`parallel_wave_create` additionally includes `generatedAt`.
`parallel_wave_inspect` additionally includes `waveSchemaVersion`,
`inspectedAt`, and an `inspection` count summary. `parallel_plan` additionally
includes `waveSchemaVersion`, `plannedAt`, `parallelDevCandidates`,
`planOnlyStories`, `blockedStories`, and `recoveryGuidance`.

## Projection JSON Contracts

Projection-specific schemas do not all repeat the full base wave envelope.
Every projection still includes `schemaVersion`, `waveSchemaVersion`, `waveId`,
a projection timestamp, `summary`, and the non-authoritative `authority`
boundary with `productionDone=false`, `authorityChanged=false`, and
`receiptRefs=[]`.

`parallel_dispatch` emits `dispatchedAt`, `summary`, `dispatchEntries`,
`hostCandidates`, top-level `evidenceRefs`, `mergeOrder`, and `authority`. It
does not emit top-level `storyRefs`. Each dispatch entry contains `storyId`,
`title`, `recommendation`, `dispatchable`, `agentRole`, `spawned=false`,
`requiresRunnerConfirmation=true`, `recommendedHostIds`, optional
`worktreePath` and `branch`, `nextCommand`, `blockers`, `degradations`,
`evidenceRefs`, and bounded non-authoritative `experienceRefs`.

`parallel_status` emits `statusAt`, `summary`, `candidates`, `planOnly`,
`blocked` entries with blockers, `mergeGuidance`, and `authority`. It does not
emit `storyRefs`, `hostCandidates`, top-level `evidenceRefs`, or `mergeOrder`.

`parallel_merge_queue` emits `queuedAt`, `summary`, `ready` and `blocked`
queue entries, `mergeGuidance`, and `authority`. Each queue entry contains
`storyId`, `title`, `after`, `safety`, `recommendation`, `ready`, `blockers`,
`guidance`, and story-level `evidenceRefs`. It does not emit `storyRefs`,
`hostCandidates`, top-level `evidenceRefs`, or raw `mergeOrder`.

`parallel_report` emits `reportedAt`, `summary`, `candidates`, `planOnly`,
`blocked`, `dispatchEntries`, `mergeGuidance`, `evidenceSummary`,
`experienceRefs`, and `authority`. `evidenceSummary` contains `topLevelRefs`
and per-story entries with `storyId`, `title`, story-level `evidenceRefs`,
`canonicalStoryRef`, and `recoveryRefs`. It does not emit `storyRefs`,
`hostCandidates`, top-level `evidenceRefs`, or raw `mergeOrder`.

Projection schema versions:

- `koala.parallel_wave.v1`
- `koala.parallel_wave_inspect.v1`
- `koala.parallel_plan.v1`
- `koala.parallel_dispatch.v1`
- `koala.parallel_status.v1`
- `koala.parallel_merge_queue.v1`
- `koala.parallel_report.v1`

Unsafe metadata is fail-closed. Active dependencies and shared hotspots degrade
or block parallel DEV recommendations even when a story declares
`parallelSafe=yes`.

## Dev-memory Boundary

Parallel dispatch and report projections may include dev-memory refs only when
`includeExperience=true`. The implementation reads project memory from
`<projectRoot>/.lattice/dev-memory/experience.jsonl` as the canonical project
store, with `<projectRoot>/.lattice/dev-memory/experience.jsonl` as a read-only
legacy fallback. Global reads use current `~/.lattice/dev-memory/experience.jsonl`
plus the legacy global fallback when appropriate: `~/.lattice/dev-memory/experience.jsonl`
by default, or `KOALA_GLOBAL_MEMORY_DIR` when that legacy fallback override is
set. Missing files are tolerated as an empty list. Results are de-duplicated by
id, searched through the existing dev-memory search routine, and capped by
`maxExperienceRefs`.

Each emitted memory ref is deliberately small: `id`, `category`, `summary`,
`source`, `scope`, `gateEvidence:false`, and
`authority:"non_authoritative"`. These refs are operator context only. They are
not evidence refs, cannot satisfy gates, and do not change the authority
boundary.

## Six Implementation Milestones

1. Document the execution contract and authority boundary.
2. Add the core Parallel Wave model and safety resolver.
3. Expose CLI surfaces for create, inspect, and plan.
4. Integrate capability, degradation, evidence, and merge-order guidance.
5. Add smoke coverage for candidates, blockers, policy registration, L0 fact
   levels, and no-overwrite behavior.
6. Record validation evidence after build, smoke, scope, and Koala validation.

## Authority Boundary

Parallel Wave can make work safer to schedule, resume, and merge, but it cannot
make work done. A wave artifact, handoff pack, local JSON file, missing receipt,
conditional receipt capability, or unverified receipt ref cannot satisfy DONE or
production authority. Production completion still requires the normal Koala
gates and a verified receipt-backed authority flow.

Every `buildParallelReport` output has `authority.productionDone=false`,
`authority.authorityChanged=false`, and `authority.receiptRefs=[]`. The
B-2522 CHK-002 enforce matrix smoke (`npm run test:authority-enforce-matrix`)
includes a `parallel_report` assertion that mechanically proves this invariant
holds even when a wave is created against real story IDs and real hosts.
