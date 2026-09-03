## Trigger Event
On 2026-09-02 the repository history was rewritten by a harness step (git reflog shows strip attribution trailers on main and on story branches). B-41c8 found during its own REVIEW that the hash it had cited in a comment was orphaned (finding F-012, fixed in-story), and the round-4 concept review then found two pre-existing orphaned citations outside the story scope (finding F-014, dismissed into this draft).

## Key Insights
A commit hash in a source comment is only stable while history is never rewritten; this repository has now demonstrated that it can be. Story ids, checklist item ids and commit subjects survive rewrites, so they are the right citation currency for comments, and a residue check is the only way to keep new hash citations from creeping back.

## Solution Tradeoffs
One-time replacement plus a residue check (chosen) versus leaving the citations (they become unresolvable after gc and mislead readers) versus keeping the objects alive with refs (fragile and hides the problem).

## Conversational Texture
The user asked that low, non-blocking defects found mid-story be recorded with evidence and deferred rather than widening scope; this draft is that record for B-41c8 F-014.
