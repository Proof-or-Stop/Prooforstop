## Trigger Event
B-ccb6 exposed a 117-document candidate-routing bootstrap deadlock, fixed by commits eb839537ad and 4da48099ad. Replacement B-0571 then reached bounded 6-document PLAN review, where the reviewer found that implementable metadata-only evidence HEAD lineage conflicts with exact-current-HEAD wording in canonical DONE/proof documents; its INIT boundary could not be expanded in PLAN.

## Key Insights
The runtime has three independent false-timeout risks: a 240000ms done_prepare phase default, a direct CLI heartbeat that never reaches ctx.log, and a 900000ms absolute CLI maximum shorter than the legal 290000ms + 1200000ms sequential DONE-required budget. Fresh evidence also cannot literally equal current HEAD after its own metadata commit, so reuse needs a narrowly verified metadata-only lineage rather than ignoring HEAD or demanding an impossible fixed point.

## Solution Tradeoffs
A shared timeout-budget core is preferred over raised constants. CLI defaults are coordinated only for DONE-related commands; explicit environment overrides remain authoritative. Receipt reuse defaults on but is independently disableable and must pass canonical evidence checks plus trusted HEAD lineage. All six related canonical documents are writable in the initial boundary so implementation and specification cannot diverge.

## Conversational Texture
The user asked to execute the remediation program and observe process loops. Two discarded predecessors are intentional audit records, not hidden failures. The final experience must be economical and visible: six relevant documents stay six, long validation reports progress, fresh proof is reused, and every skip/failure states its disposition, result, refusal reason, and timeout layer.
