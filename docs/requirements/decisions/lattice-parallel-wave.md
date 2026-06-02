# Lattice Parallel Wave

Parallel Wave is a collection-level scheduling and recovery projection for
multi-story Koala delivery. It reads existing Canonical Story v0 projections,
host capability profiles, story dependency metadata, and shared hotspot hints,
then emits a wave plan that helps operators decide which stories can proceed in
parallel worktrees.

It is not authority evidence. A wave artifact is local planning state only: it
cannot satisfy REVIEW, TEST, DONE, delivery, receipt, or production authority
gates. Every Parallel Wave output keeps `productionDone=false`,
`authorityChanged=false`, and top-level `receiptRefs=[]`.

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
- Merge order is guidance for sequencing integration. It does not replace Koala
  lifecycle gates.

## Commands

`parallel_wave_create` creates a wave projection from story refs, or from active
stories when refs are omitted. Optional `output` writes JSON with no overwrite.

`parallel_wave_inspect` reads an existing wave JSON file and reports the same
non-authoritative scheduling facts plus inspection counts. Optional `output`
writes JSON with no overwrite.

`parallel_plan` builds a parallel execution plan either from a wave file or by
analyzing active stories directly. Optional `output` writes JSON with no
overwrite.

All three commands are read-only workflow commands: they may write a caller
requested output artifact, but they do not mutate story metadata, process
evidence, lifecycle state, receipts, authority state, or production completion.
They are process fact level L0.

## Wave JSON Contract

Every JSON output includes:

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

Unsafe metadata is fail-closed. Active dependencies and shared hotspots degrade
or block parallel DEV recommendations even when a story declares
`parallelSafe=yes`.

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
