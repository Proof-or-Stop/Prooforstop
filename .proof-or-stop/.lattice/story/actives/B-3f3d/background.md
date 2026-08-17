## Trigger Event
B-cdf6 review runs RR-043 through RR-046 were bound to the same frozen cutoff, but F-036 returned first and material commit 155e787d0c was created before the docs and test-coverage lanes terminated. Their later findings still described the old material, forcing new review runs. B-9812 separately accumulated 53 verified findings across 10 finding rounds. These incidents show that the workflow can turn valid review into repeated DEV and REVIEW churn.

## Key Insights
The number of review rounds is not assurance. A trustworthy boundary must prove that every scope and risk selected lane reviewed the same immutable subject, that the completeness critic saw the verified finding set, that missing output or timeout cannot become PASS, and that a complete saturation wave added no new verified findings. This establishes a bounded problem inventory, not absolute absence of every conceivable bug. The repaired material must still receive fresh final review.

## Solution Tradeoffs
Choose a Frozen Review Inventory Epoch with a signed receipt, material-mutation barrier, bounded discovery waves and explicit saturation criteria. Reject a fixed N-round shortcut because repeated identical reviewers can share the same blind spot, and reject an unbounded loop because continuing new finding families indicates excessive scope or a shallow design that should be replanned or decomposed. Keep atomic remediation closeout and PRE_CERT scheduling out of this first Story so the epoch remains one cohesive deliverable.

## Conversational Texture
The user first asked why REVIEW and DEV repeat and challenged whether the cause was incomplete review or defects introduced during repair. They then required that any reduction in rounds be trustworthy rather than mechanical: entering remediation DEV must happen only after review is sufficiently complete, with no omissions hidden by a smaller round count. The user proposed multiple review waves until no new finding appears; the accepted refinement is discovery saturation on one frozen version followed by one remediation DEV and mandatory final review of the changed version.
