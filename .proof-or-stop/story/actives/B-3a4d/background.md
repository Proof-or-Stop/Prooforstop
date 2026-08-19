## Trigger Event
On 2026-07-05, story B-bfba reached DONE and the story worktree was cleaned, but `lattice milestone_closeout --storyId=B-bfba` from the canonical root still reported `Snapshot: missing`. This proves the closeout snapshot write did not survive the real DONE merge / cleanup path.

## Key Insights
The previous implementation verified helper behavior and a focused DONE handler path, but it did not verify that the snapshot artifact becomes durable in main after `applyDoneMergeEffects` and worktree deletion. The accepted milestone table must be stored as committed story metadata, not as a transient worktree file.

## Solution Tradeoffs
Keep the fix narrow. Prefer making the existing DONE flow commit or carry the generated closeout artifact through the same durable metadata path as summary, delivery-check, and done-required evidence. Do not turn `milestone_closeout` into a live recomputation command, because that would reintroduce stale/live semantics into a historical closeout reader.

## Conversational Texture
The user asked whether the four reviewer passes were complete and then we found the final artifact was still missing after DONE. The right response is to treat this as a real correctness miss, preserve the host-neutral closeout design, and add a regression that proves the artifact survives the full lifecycle path.
