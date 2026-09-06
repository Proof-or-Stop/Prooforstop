## Trigger Event
During B-212f closeout work on 2026-09-05, the owner tried to archive a separately scoped historical reviewer audit gap through the supported gap_log CLI. The command exited 1 before recording it: existing provenance chain is not extendable (invalid_binding_shape); expected=(none) observed=(none).

## Key Insights
The exact observed output was: gap_log: existing provenance chain is not extendable (invalid_binding_shape). The attempted payload included category missing, severity medium, structured sourceRefs, reproCommand, observedOutput and analysisNote. No provenance bypass or direct ledger mutation was attempted. The underlying malformed chain cause and repair path remain unconfirmed and must be diagnosed read-only first.

## Solution Tradeoffs
This is provisionally medium and outside B-212f active DONE/preflight parity; the refusal fails closed and the current tracking requirement was fulfilled using story_draft instead. Preserve the original ledger and investigate supported recovery in a separate human-approved Story. Do not lower provenance integrity merely to allow a log write. If evidence shows this defect blocks B-212f acceptance or distorts its gates, reassess applicability and severity immediately.

## Conversational Texture
The user requires evidence-backed routing of nonblocking issues and forbids unbounded scope expansion for global green. Owner and route: this draft backlog, pending human prioritization. Reproduction starts by inspecting the gap_log provenance validator and current chain shape; repeating a write is only warranted after confirming safe supported behavior. No repair or verified root cause is claimed.
