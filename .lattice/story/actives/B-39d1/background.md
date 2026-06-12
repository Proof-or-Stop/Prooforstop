## Trigger Event
On 2026-06-12, B-ebc5 produced a concrete execution plan showing that the first two current gap_analyze high gaps both belong to signed workspace resolution. The user approved executing that plan with Lattice CLI instead of writing another planning note.

## Key Insights
The two signed-workspace gaps share the same correctness surface: story_resolve and review_run_start must agree on metadataRoot, signedWorkspaceRoot, repoRoot, and unresolved reason. The fix must be proven by source, regression tests, and gap_analyze output rather than wording alone.

## Solution Tradeoffs
Keep this story narrowly scoped to signed workspace implementation or binding coverage. Do not touch Layer4 customerKeyRef, Authority receipt behavior, productionDone, receiptVerified, or broader capability unlocks. If the current code already implements the behavior, add the minimal code annotation or test binding needed for gap_analyze to recognize it.

## Conversational Texture
The user is worried about fixing one issue and creating three more. This story should therefore make the smallest real correctness change, verify that the two signed-workspace gaps disappear, and prove no new high or medium gap was introduced.
