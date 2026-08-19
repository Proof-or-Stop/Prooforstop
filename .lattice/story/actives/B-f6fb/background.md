## Trigger Event

During B-def6 closeout on 2026-08-19, a cross-host review spawned a real independent Codex reviewer. It returned fail with a MAJOR finding that five same-host review rounds had not surfaced: registering the dev-memory ledger as a non-blocking runtime artifact removes the only mechanism that previously guaranteed a captured lesson got committed.

## Key Insights

The regression is second-order. B-def6 change is correct for the problem it targeted, and materialHash exclusion is the right mechanism there. But blocking dirt was doing double duty: it was both an obstacle AND the thing that forced an operator to commit the file. Removing the obstacle removed the guarantee.

Verified against source during B-def6: dirty-worktree.ts line 204 routes any registered runtime artifact path to runtime_artifact_changes, and that category is non-blocking. The DONE clean-tree check consequently passes with the ledger uncommitted.

On B-def6 itself the ledger did end up committed, incidentally, via a merge commit — so the loss did not occur. That is luck, not a guarantee, and it is exactly the shape of bug that stays invisible until someone loses a lesson they wanted.

## Solution Tradeoffs

Option A, stage and commit the ledger during DONE: directly closes the hole, but adds a write to the DONE merge path, which is high-risk territory and moves HEAD at a moment when other evidence is bound.

Option B, make capture durable immediately by writing through to the canonical main ledger under the main-write lock: removes the dependence on DONE entirely, but introduces cross-worktree write coupling at capture time.

Option C, keep tracked non-volatile runtime artifacts blocking until committed: restores the old guarantee, but re-opens the exact problem B-def6 was created to fix, so it would need to block WITHOUT perturbing materialHash — the two properties are separable and B-def6 conflated them only because one entry controls both.

Option C is the most interesting because it suggests the registry may need to distinguish "excluded from materialHash" from "non-blocking when dirty" rather than granting both together.

## Conversational Texture

This surfaced at the very end of B-def6, after five same-host review rounds had all passed. The independent Codex host found it on its first look. That same run also produced a real defect in B-def6 own code, a target-phase versus current-phase conflation in the scope-gate remediation copy, which the same five rounds had missed and about which one reviewer had asserted the opposite of the truth. The cross-vendor lane earned its cost on that run alone.

Worth preserving: the first instinct was that the ledger being committed on B-def6 proved there was no problem. It did not. The ledger was committed incidentally by a merge commit, which is luck, and the guarantee that used to exist had genuinely been removed.
