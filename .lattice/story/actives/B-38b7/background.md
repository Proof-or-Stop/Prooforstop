## Trigger Event
On 2026-08-18, the user approved importing the independently audited Revision 3 Story-aware dynamic validation plan after Claude CLI 2.1.220 and Agy CLI 1.1.13 both returned DYN-1 observe-only PASS with no critical or high findings.

## Key Insights
The external artifact is appropriate for drafting and adversarial review, but long-term authority requires a repository-relative, versioned decision document that lifecycle reviewers and future implementation Stories can reference without machine-specific paths.

## Solution Tradeoffs
Promote exactly one canonical decision document now, preserving audit history and accepted constraints, while excluding runtime implementation, scheduler changes, receipt schemas in code, benchmarks, and unavailable canonical-document registry integration from this documentation-only Story.

## Conversational Texture
The user explicitly agreed with the safe sequence: dual re-audit first, clear critical and high soundness issues, mark the plan approved for DYN-1 observe-only, then import it through the managed Story flow instead of copying it directly into main.
