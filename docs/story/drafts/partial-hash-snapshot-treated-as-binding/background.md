## Trigger Event
On 2026-09-02, Codex cross-host review run B-a745-xhr-r3 filed 'Incomplete evidence hash snapshots are mislabeled as available' against B-a745's collector; the fix commit 9af45102b4 (Resolves: B-a745:F-022) corrected that one consumer, and the implementer reported five further callers of tryCaptureEvidenceHashSnapshot that share the thrown-versus-returned distinction only.

## Key Insights
The reader's contract is silent omission, not failure, so every consumer must check digest presence itself or the omission propagates as a null binding. Two of the listed consumers are gate owners (done-oracle, phase-gates), where a null digest that survives as a binding is a false-provenance risk rather than a display defect. B-a745 could not touch evidence-freshness.ts because it was a protected file in that story's scope contract, which is the right constraint for a planner story but leaves the shared fix undone.

## Solution Tradeoffs
Option one, add a shared missing-digest classifier next to the reader in evidence-freshness.ts and migrate all consumers to it, so the omission is named once; option two, patch each consumer locally as B-a745 did, which is faster but reproduces the F-006 duplicated-fact class across six sites. Option one is preferred; option two is acceptable only for a gate owner that needs an urgent fail-closed guard before the shared work lands.

## Conversational Texture
The user running B-a745 chose a genuine cross-host quorum so independent readers would attack the story; Codex found this, and the user's rule that deferred defects must leave a traceable owned record is why this is a repository draft rather than a session note.
