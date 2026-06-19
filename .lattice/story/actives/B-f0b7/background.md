## Trigger Event
On 2026-06-19 the operator asked to run the full dispatch_auto scheduler (not just the ledger seam directly) to confirm a real claude-code dispatch produces a usage-ledger record. This story is the throwaway scheduling target for that single probe dispatch.

## Key Insights
dispatch_auto requires a storyId plus a policy that authorizes real claude-code subprocess launch (allowRealHostSubprocess, the canonical claude --print launcher in commandAllowlist, requireReceipt/requireReview true, allowAutoMerge/allowProductionDone false). The worker runs claude --print --output-format json which surfaces the four-field Anthropic usage object the ledger records.

## Solution Tradeoffs
No real development is intended; the worker objective is a trivial no-op reply so the dispatch completes quickly and cheaply while still exercising the real scheduler, real subprocess, and the usage-ledger write path. The story will be discarded after the probe.

## Conversational Texture
The operator first saw the ledger seam produce real data directly, then explicitly asked to also run the genuine dispatch_auto scheduler to see the same capture happen through the full unattended path.
