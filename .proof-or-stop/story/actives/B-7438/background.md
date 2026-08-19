## Trigger Event
On 2026-07-09, during B-99d4 closeout discussion, the operator selected the statement claiming only Codex was available and pointed out that Claude CLI and agy CLI were also installed. This exposed that degraded single-host review fallback could be justified by prose instead of proof.

## Key Insights
The real defect is not a one-off wording mistake. It is a gate-consumed process fact gap: degraded-single-host fallback can be recorded without a fresh mechanical probe of canonical hosts, so Proof-or-stop can continue without first proving the stop condition.

## Solution Tradeoffs
Prefer adding a small host availability evidence path that checks codex, claude, and agy and binds results to current material state. Avoid a broad host runner redesign; this story should only tighten degraded fallback admissibility and diagnostics.

## Conversational Texture
The user challenged a weak assurance claim directly and wants the framework to stop accepting agent self-report as evidence. The fix should make the honest path easy: run a probe, use real 3x2 when two hosts exist, or explicitly record lower-assurance human approval.
