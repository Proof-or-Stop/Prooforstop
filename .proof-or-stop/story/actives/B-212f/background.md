## Trigger Event

On 2026-09-04, accepted repro probe rp-mtn2kjzu-pap3kp and independent review rr-mtn2kqun-vcqatu proved that done_prepare can report readiness even when the real DONE transition rejects the same state. The two concrete cases are a missing finish decision and a stale reviewer pass after diffPackHash drift.

## Key Insights

The reviewed RED is exact behavioral evidence: the production DONE gate returns missing_dev_memory_finish_decision or stale_closeout_review, while done_prepare omits the corresponding oracle row. Candidate GREEN rgre-mtn2ptyg-asgnhf shows that delegating to the real predicates can make both paths agree, but it remains intake evidence rather than Story lifecycle evidence.

## Solution Tradeoffs

The narrow solution is to make done_prepare consume the real DONE finish-decision and reviewer-verdict predicates, preserve fail-closed behavior, and add a mechanical process-fact guard against future divergence. The Story will not weaken freshness rules, manufacture evidence, or expand into unrelated cleanup merely to make the repository globally green.

## Conversational Texture

The maintainer wants the reviewed RED and candidate GREEN carried into a normal Story so implementation can proceed from proven behavior. During execution, repair a verified applicable critical/high defect and any verified defect that blocks this Story acceptance or lifecycle-gate truth. A verified non-applicable critical/high defect requires strong nonblocking evidence plus a traceable owner or route; eligible unrelated nonblocking low/medium defects keep reproducible evidence and a named later route instead of expanding this Story.
