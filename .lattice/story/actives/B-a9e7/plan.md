# B-a9e7 Execution Plan — Dev-memory Legacy Koala Supersession Cleanup

## Goal
Keep historical dev-memory evidence intact while preventing old Koala wording from being treated as active guidance. Current Proofbound/Lattice memories must be preferred in preflight/search/list output, and legacy Koala memories must remain readable with visible superseded metadata.

## CHK-001 Inventory legacy Koala dev-memory entries and define supersession mapping

Implementation:
- Use project/global dev-memory reads to identify entries whose summary/trigger/lesson/reusePrompt/tags/evidenceRefs contain Koala, `.koala`, or `koala-*` terms.
- Treat these entries as historical, not wrong. Do not rewrite or delete them.
- Define the supersession mapping using existing durable signals: `tags` containing `supersedes-<id>` and `evidenceRefs` containing `dev-memory:<id>`.

Verification:
- `dev_memory_search --global --query=koala` shows legacy entries remain readable.
- Superseding entries cite the superseded ids.
- Smoke proves old evidence refs are not mutated.

## CHK-002 Implement dev-memory supersession priority for preflight/search/list consumers

Implementation:
- Add core helper(s) in `packages/main/src/core/dev-memory.ts` to compute supersession metadata from entries.
- Search/preflight should rank current superseding entries ahead of superseded legacy entries when both are relevant.
- List/search/preflight formatting should annotate superseded entries and superseding entries so a host can tell current guidance from legacy-readable context.
- Keep raw schema compatible: no migration required for existing JSONL rows.

Verification:
- Synthetic smoke with one legacy Koala entry and one Proofbound/Lattice superseding entry proves ordering and visible annotations.
- Existing dev-memory list/search/preflight behavior remains usable.

## CHK-003 Capture current Proofbound/Lattice superseding memories for legacy Koala lessons

Implementation:
- Append current project dev-memory entries that supersede legacy global Koala lessons for reviewer lane naming, delivery review, CLI self-hosting, and session preflight.
- Cite legacy ids in `evidenceRefs` and/or `supersedes-<id>` tags.
- Use current names: Proofbound, Lattice, `lattice-review-*`, `.lattice`, and `lattice` CLI.

Verification:
- Project memory contains the new current entries.
- Old global entries remain untouched and readable.
- Search/preflight prefers the current entries.

## CHK-004 Add smoke coverage for superseded dev-memory ordering and legacy terminology mapping

Implementation:
- Add `packages/main/src/tasks/dev-memory-supersession-smoke.ts`.
- Seed a temporary project/global memory store with legacy Koala entries and current Proofbound/Lattice superseding entries.
- Assert supersession projection, ordering, formatting, and non-authoritative flags.

Verification commands:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/dev-memory-supersession-smoke.js`
- Existing `lattice dev_memory_preflight/search/list` manual probes against B-a9e7 memory.

## Non-goals
- Do not rewrite or delete historical global memory rows.
- Do not perform broad branding cleanup outside dev-memory.
- Do not make dev-memory gate evidence.
- Do not touch unrelated active story artifacts.

## User-visible done signal
After completion, the user can run memory search/preflight and see Proofbound/Lattice guidance first, while old Koala entries are explicitly marked as superseded/legacy-readable. This is the visible behavior product review asked for.
