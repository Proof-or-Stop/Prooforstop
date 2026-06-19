## Trigger Event
On 2026-06-19 during B-12d7's DONE, the materialHash drifted (90f7436 -> e28f2b8) mid-transition because main advanced after the DONE pre-check synced, re-staling all escalation host verdicts and verification evidence and forcing a full re-establish. The existing main-write-lock already serializes Lattice DONE merges; the residual race is an EXTERNAL (non-Lattice) git advance between lock-acquire and the in-lock merge.

## Key Insights
autoSyncMain + the in-lock git merge already run INSIDE the main-write-lock (transition-orchestrator.ts: lock acquire ~311, autoSyncMain ~319, the merge inside applyDoneMergeEffects ~473 — all in one try/finally), so concurrent Lattice DONEs do not corrupt each other -- "merge serialization" is NOT a missing capability. The only uncovered window is an external git advance to main between the pre-check sync and the in-lock merge: it changes material AFTER verdicts/evidence were re-established, so DONE could persist against a tree that drifted. The fix is a cheap re-read of main's sha after acquiring the lock and before merging.

## Solution Tradeoffs
Add a post-lock, pre-merge mainSha re-comparison: if main's sha changed since the pre-check sync, ABORT the transition BEFORE phase=DONE is persisted (transition-orchestrator.ts:431), leaving the story at TEST with a "re-run story_advance DONE to resync" hint. REJECT after-DONE auto-retry: it needs a partial-DONE state machine, has no rollback, and lengthens lock holds toward the ~120s stale-reclaim threshold (risking a second DONE reclaiming the lock mid-merge). Keep the merge atomic; fail closed (abort), never half-commit.

## Conversational Texture
The operator analyzed three workflow frictions; a workflow-verified review found the merge-lock already exists and only this external-advance window remains. Of the options weighed (full merge-serialization rework, after-DONE auto-retry, partial-DONE state machine, and a post-lock pre-merge mainSha re-check that aborts before persist), the review recommended exactly the last — the abort-before-persist re-check — and rejected after-DONE auto-retry. The operator approved drafting it.
