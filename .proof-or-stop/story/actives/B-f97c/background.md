## Trigger Event
On 2026-07-12 the live story_review implementation was measured embedding 2,536,001 bytes from 114 requirements Markdown files into every generated _reviewPrompt, so even a simple story can exhaust the host context budget before useful review begins.

## Key Insights
The bounded reviewer-reading contract from B-cee5 does not constrain the producer: story-review.ts recursively reads every Markdown document and concatenates all contents before the reviewer can apply candidate routing. The fix must remove this producer-side corpus channel rather than truncate it.

## Solution Tradeoffs
Prefer the narrow immediate correction: keep structured PLAN artifacts and existing gate checks while deleting requirements full-content loading and Truth Source concatenation. Do not implement the larger M6 candidate router in this emergency story, and do not weaken signed scope-check semantics.

## Conversational Texture
The user explicitly requires immediate removal because a routine story burns the available quota. The visible outcome is that story_review remains useful for PLAN review while its generated prompt no longer grows with unrelated historical requirements content.
