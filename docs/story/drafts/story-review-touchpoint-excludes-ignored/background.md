## Trigger Event

On 2026-09-04, during PLAN for B-77e6, story_review raised `touchpoint_uncovered` for a path that the story deliberately reads but never modifies. The blocker message ends "please add this path to the corresponding item's files.modify/create/test or explicitly exclude it via excludes". Setting that item's `excludes` to the exact path, via `checklist_update`, did not clear the blocker. Setting it to a prose justification did not either. The only route through was to delete the path from `understanding.touchpoints`, which is a weaker record than the exclusion the message offers.

## Key Insights

The coverage check is at packages/main/src/handlers/story-review.ts around line 525. It builds a `covered` set from `files.modify`, `files.create` and `files.test` across every checklist item that has a `files` field, then raises one blocker per touchpoint absent from that set. The `excludes` field is never read on that path, although the blocker it emits names `excludes` as one of the two remedies.

`excludes` does exist as a real checklist field: `checklist_update --excludes` accepts an array and the CLI help describes it as explicitly declared out-of-scope functionality that INIT reviewer lanes may not modify directly. So the message points at a field that exists and is accepted, which is what makes the guidance convincing and the failure confusing; a reader concludes their exclusion was malformed rather than unread.

The consequence is a quiet loss of record fidelity rather than a wrong gate outcome. The honest workaround, dropping the path from `understanding.touchpoints`, makes the story's own record claim the file is not a touchpoint at all, when in truth it is central and deliberately unmodified. That distinction is exactly what an exclusion is for, and it is the distinction a later reviewer needs when asking whether a file was overlooked or left alone on purpose.

## Solution Tradeoffs

The narrow fix is to make the check read `excludes` as the message already promises: a touchpoint named in any item's `excludes` is covered, and the story keeps the stronger record. The risk is that `excludes` becomes a way to silence the coverage check by listing a path with no reason, so an exclusion probably needs to carry a justification and be visible to the PLAN scope reviewer rather than merely suppressing the blocker.

The alternative is to correct the message instead of the code, naming only `files.modify/create/test` as remedies. That is cheaper and removes the misdirection, but it leaves no way to record a path as deliberately unmodified, which pushes authors toward deleting touchpoints and degrades the record in exactly the way observed here.

A third option is to accept a touchpoint annotated with a reason, since `normalizeTouchpointPath` already tolerates annotations such as a path followed by a parenthesised reason. That keeps everything in one field at the cost of encoding structure in prose.

## Conversational Texture

Found while planning B-77e6, whose whole subject is a file that is called from twenty-eight places and modified by none of them, so the gap was unavoidable rather than incidental. Recorded rather than fixed in place: the defect does not block that story, which has an honest route through, and widening a migration story into the review handler would be scope expansion. What makes it worth writing down is that the tool's own remediation text is the thing that is wrong, so every author who follows the instruction loses the same record in the same way.
