## Trigger Event
On 2026-06-24, the honest powered re-run after B-8e9f (merge 5614757) returned B4 (context-loss) as infra-fail with turns=2: the turn-1 truncate fired but handed the single-shot claude -p agent an EMPTY prompt.

## Key Insight
B4.truncatedContext is the empty string. When the turn-1 truncate replaces the context with empty, real-loop-agent.mjs passes String(context ?? "") = "" as the claude -p prompt, which is an invalid (empty) prompt and parseClaudeResult records infra-fail. B5 already mirrors the correct pattern: its checkpointContext is a NON-EMPTY token-less marker "[process killed and restarted; in-memory context lost]", which yielded a clean result (amplified). B4 should use the same non-empty, token-less style so the agent gets a valid prompt that lacks the task token and must recover the task from task.txt on disk.

## Tradeoff
Making truncatedContext non-empty changes the literal injected text but NOT the recovery semantics: it is still token-less, so a workspace-reading agent re-derives the task from disk (RECOVERED) while a context-reliant agent finds no token (AMPLIFIED). The disk-grounded classify is unchanged. The only cost is a one-line value change plus a comment update; the self-check stubs (which check task.txt vs context.includes(token)) are unaffected because the new marker still contains no token.

## Conversation Texture
After seeing B4 come back infra-fail (empty prompt), the operator chose fix-B4-mirroring-B5-then-rerun over accepting B4 as infra-fail in the exploratory backfill, so B4 must hand the single-shot agent a valid non-empty token-less prompt before the honest powered re-run feeds the paper recovery table.
