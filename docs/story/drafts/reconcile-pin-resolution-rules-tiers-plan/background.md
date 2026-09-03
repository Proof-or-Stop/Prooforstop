## Trigger Event
On 2026-09-02, story B-a745 finding F-011 (registered from Codex cross-host review run B-a745-xhr-r1, verdict verdict-96c790e338428427) and the concept reviewer's round-3 finding B-a745:F-013 established that the tiers execution plan states the unresolvable-pin rule two ways, and that B-a745's claim to have 'filed' the tension for the spec owner had no in-repository artifact behind it. This draft is that artifact.

## Key Insights
The widening matrix qualifies the stop with 'explicit'; resolver step 4 and the Step 7 invariant do not. Under the unqualified reading the planner is self-referentially unusable (the acceptance evidence for the planner pins the planner) and stops on essentially every real story, because verification evidence routinely pins test binaries outside validate.commands. Under the qualified reading nothing is pruned and the effective tier is still repository-full, so the fail-closed property that matters is preserved. Both readings are defensible from the text, which is exactly why the document, not an implementation, must decide.

## Solution Tradeoffs
Option one: ratify the qualified reading by rewording resolver step 4 and the Step 7 invariant to say an explicit commandId with no match stops while an unresolvable legacy string is classified and widens; B-a745's implementation then already matches. Option two: ratify the unqualified reading, in which case the document must also say how a story avoids the self-referential deadlock, and B-a745's pinned_command_non_inventory path must be reverted to a stop. Option three, silently leaving both sentences, is rejected: an independent host has already filed the divergence as a defect once.

## Conversational Texture
The user running B-a745 chose a genuine 3x2 cross-host quorum over a single-host fallback precisely so independent readers would challenge the story; Codex did, on this exact point. The user also set a rule that deferred defects must leave a traceable, owned record rather than a verbal note, which is why this is a repository draft and not only a session task chip.
