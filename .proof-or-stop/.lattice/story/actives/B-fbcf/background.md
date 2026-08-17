## Trigger Event
On 2026-07-09 during B-6914 closeout, done_prepare generated lifecycle metadata, required a manual metadata commit, then full validation was rerun even though materialHash and storyFilesHash were unchanged. The user asked for a fourth non-overlapping story to automate only that safe mechanical loop.

## Key Insights
B-eb08, B-eb92, and B-b264 already cover visibility, early review-assurance surfacing, and rerun explanation. The remaining gap is not another UX message; it is a narrow automation capability that consumes those classifications and safely handles generated lifecycle metadata without touching user work.

## Solution Tradeoffs
Keep the first implementation opt-in and fail-closed. It should auto-commit only current-run Proofbound lifecycle metadata, reuse validation only when hashes prove nothing material changed, and stop before DONE advancement unless a later story explicitly expands that boundary.

## Conversational Texture
The user was specifically concerned that agents waste time and confuse users by repeatedly running done_prepare and full validation after metadata-only commits. The story should make the safe path automatic while preserving the user's strict boundaries around reviewer evidence, publishing, and unrelated dirty files.
