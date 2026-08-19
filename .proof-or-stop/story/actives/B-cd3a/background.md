## Trigger Event
On 2026-06-30, after B-5082 and B-e1a8, the user asked whether global-lifecycle-control-plane-execution-plan.md and proof-admissibility-hardening-execution-plan.md still contain milestone-planned capabilities that were only partially implemented. The concrete evidence included global_control_status showing proofM7Enforcement=false, queueCleanupEnforcement=false, tierCCleanup=false, and queue_governance_status showing Tier-C stories as duplicate candidates.

## Key Insights
B-5082 solves intent and ProofStory contract shrinkage, but it is not the full implementation vehicle for Global Lifecycle Control Plane or Proof Admissibility. The two execution-plan documents contain system-level capabilities owned by B-0985, B-0405, and later control-plane work; several pieces exist as read-only diagnostics rather than enforceable completion gates.

## Solution Tradeoffs
The safest path is one parent story with a milestone ledger and possible child slicing, rather than one giant implementation pass. This preserves the user intent ledger, lets the new ProofStory gates verify coverage, and avoids confusing command existence with document-level DONE. Enforcement must be staged so normal development is not broken by over-broad hard blocks.

## Conversational Texture
The user is specifically testing whether the new B-5082 mechanism prevents the earlier failure pattern where a large document milestone list was declared DONE while multiple milestones were only partially complete. This story should be careful, evidence-heavy, and explicit about partial versus complete status instead of optimistic summaries.
