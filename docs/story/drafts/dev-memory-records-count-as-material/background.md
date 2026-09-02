## Trigger Event
On 2026-09-02 story B-a745's first story_advance DONE attempt failed with every reviewer pass reported as an invalid Prompt Envelope; the delivery reviewer then traced the materialHash change (df3dc492... to e0ee1f41...) to exactly two files, .proof-or-stop/dev-memory/experience.jsonl and .proof-or-stop/dev-memory/finish-decisions/B-a745.json, committed at ddf9189cba by the dev_memory_finish_decision step that the DONE gate itself had demanded.

## Key Insights
The finish decision is required by the gate and is written late by design, after all evidence exists; if the file it writes is material, the gate is structurally self-invalidating and every story pays the full re-binding cost at the last step. The tracked dev-memory directory is the only writer left in the closeout path that is neither in the story directory nor gitignored, so a single classifier change closes the loop. B-f6fb (making captured lessons survive DONE) touches the same files and should be reconciled with this so a lesson is both preserved and non-material.

## Solution Tradeoffs
Option one, extend isMaterialExcludedPath with the dev-memory root via the brand-path resolver, which is minimal and keeps the records tracked; option two, move dev-memory under the story directory, which changes where lessons live and conflicts with cross-story reuse; option three, gitignore dev-memory, which loses durable lessons entirely and is rejected. Option one is preferred, with a fixture proving capture plus finish decision leave both hashes unchanged.

## Conversational Texture
The user on B-a745 chose a real cross-host quorum and a strict defect rule; this defect cost roughly an hour of re-binding at the very end of a story whose code had not changed, and was recorded as a repository draft rather than a session note because the user's rule requires deferred defects to leave an owned, traceable record.
