## Trigger Event
2026-06-08 user approved executing the Review Reflection Loop方案 after multi-host document review. The implementation should turn the accepted v0.1 proposal into executable Lattice CLI behavior without broadening scope.

## Key Insights
The real correctness gap is not more prompt text; it is a bounded REVIEW-stage loop with machine-readable start, iteration, close, status, trigger refs, material hashes, and policy decisions. Reflection remains non-evidence.

## Solution Tradeoffs
Implement only the minimal recording/status/gate protocol first. Defer auto execution, automatic host spawning, auto rollback, auto DONE, and policy mutation so the lifecycle remains host-neutral and auditable.

## Conversational Texture
The user explicitly pushed against arbitrary optimization and scope creep. The implementation must be supervised as an audit, using Claude CLI and Codex CLI as independent hosts while the main agent accepts only real correctness issues.
