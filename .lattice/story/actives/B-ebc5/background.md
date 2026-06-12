## Trigger Event
On 2026-06-12, lattice gap_analyze reported three high-priority uncovered requirements after B-3a80 completed its triage document, so the next step needs a concrete execution plan rather than another broad capability discussion.

## Key Insights
Two gaps belong to signed workspace resolution binding and one belongs to Layer4 customerKeyRef production safety scope. They should not be treated as one generic cleanup because the first two may require implementation while the third may remain future or blocked.

## Solution Tradeoffs
Prefer a focused requirements decision document that defines exact follow-up stories, gates, and stop conditions. Avoid changing source code in this story so the plan cannot accidentally claim that implementation gaps are resolved.

## Conversational Texture
The user is concerned that resolving one issue may create several new ones. The document should therefore explain how to close the current gaps without writing new current-tense requirements that create fresh gap_analyze failures.
