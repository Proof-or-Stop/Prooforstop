## Trigger Event
On 2026-06-25, active code still follows a reduced lifecycle-control skeleton (B-88ae), while the full global-lifecycle-control execution plan requires CP-0..CP-5 status semantics for reliable host-neutral operations.

## Key Insights
This gap is not a behavioral regression fix; it is a model drift issue where milestone identifiers and status schema diverge from canonical docs, which weakens future command hardening and monitoring trust.

## Solution Tradeoffs
Renaming milestones and expanding status fields is safe because we keep read-only compatibility. It requires smoke updates and compatibility fields, but this is lower risk than retrofitting enforcement commands into an inconsistent schema.

## Conversational Texture
Need this cleaned up now so subsequent hardening stories can consume one control-plane schema and operators can trust dashboard + handoff signals without ad-hoc reinterpretation.
