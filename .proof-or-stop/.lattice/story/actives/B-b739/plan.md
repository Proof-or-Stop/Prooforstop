# Plan — B-b739: real multi-turn agent + powered path (S4' step 3)

## CHK-001 — real-loop-agent.mjs
- `makeRealLoopAgent({model})` -> async `agent({ws, context, turn, signal})`: run claude -p --output-format json on `context` in cwd=ws; parse via parseClaudeResult (imported from ./real-arm.mjs); honor `signal` (check signal.aborted + bounded timeout that kills the child); return {actions, shipped, output, costUsd, tokensSpent} (infra-fail on parse/spawn failure). + `makeStubLoopAgent(script)` (no claude) for the self-check.

## CHK-002 — --run powered path + hermetic stub self-check
- live-loop-harness.mjs `--run`: drive the 9 stateful scenarios via runLiveLoop with the real agent; append {scenario,outcome,turns,costUsd,tokensSpent} to live-loop-powered-records.jsonl; print per-scenario outcomes + summary + a small-N/exploratory caveat. The real run is operator-triggered.
- `--self-check`: extend with a stub multi-turn agent that drives the --run path deterministically (asserts the per-scenario outcomes via the stub + that the agent received {signal} + a slow-stub timeout/abort case), 0 spend. Keep the existing 23 cases passing.

## Out of scope
The actual powered run is operator-triggered (cost). The pre-reg amendment (6->15) + the paper backfill are the next steps.

## Verification
CHK-002 --self-check (stub agent, 0 spend) is the gate.
