## CHK-001
Remove the recursive requirements-directory traversal and all full Markdown reads from story-review.ts. Remove truthDocs and Truth Source concatenation rather than truncating. Verify no alternate producer path remains.

## CHK-002
Keep the structured _reviewPrompt sections for Story metadata, understanding, decision/preMortem, grill, experience hints, ProofStory diagnostics, checklist, and verificationIntent. Preserve existing scope-check and PLAN blockers. Resolve truthDocsCount compatibility based on actual consumers without claiming embedded documents.

## CHK-003
Add a focused smoke test that creates an unrelated large requirements sentinel, runs story_review, asserts the sentinel and Truth Source corpus are absent, asserts structured sections remain, and reports stable prompt bytes. Wire it into the package scripts used by validation.

## CHK-004
Capture deterministic pre-fix corpus bytes and estimated tokens, post-fix prompt bytes and estimated tokens, the delta and ratio, plus any available host usage records for this repair. Clearly label estimates and identify the dominant cost source.
