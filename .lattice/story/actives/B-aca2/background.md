## Trigger Event
2026-06-18: B-META-framework-audit still shows F-010 and F-011 as open verified advisories, and audit output confirms they remain unresolved in the current framework report.

## Key Insights
The underlying code is already correct: story_get really lives in handlers/story-query.ts, and HandoffAuthorityBoundary already includes noHiddenContextSharing:true. The only mismatch is the audit doc text.

## Solution Tradeoffs
Keep the edit narrow: fix the citation and the missing table field in docs/audits/lattice-token-cost-and-takeover-audit.md, then resolve the findings. Avoid broader prose churn so the audit stays easy to compare.

## Conversational Texture
The user asked to verify the advisory state first and then solve it through Lattice. This story should read like a documentation correction, not a runtime change or a policy rewrite.
