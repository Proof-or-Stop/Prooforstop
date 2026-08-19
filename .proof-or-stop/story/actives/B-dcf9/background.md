## Trigger Event
On 2026-07-17, the user challenged the practice of feeding many Markdown documents to an LLM during every development task and asked how the approach could work once the repository contains 1000 documents. They requested a concrete execution-plan document for audit.

## Key Insights
The scaling problem is not the Markdown format itself but the absence of a bounded context contract. Live facts, reusable experience, operational playbooks, normative decisions, code reality, and gate evidence have different authority and freshness semantics and must be retrieved differently.

## Solution Tradeoffs
The plan should avoid both full-corpus ingestion and memory-only operation. It should use thin mandatory context, deterministic candidate routing, bounded ranking, risk-based escalation to canonical source sections, and mechanical provenance while retaining original decision documents as auditable truth sources.

## Conversational Texture
The user is focused on operational scalability rather than theoretical context-window size. The desired artifact must be specific enough to audit: budgets, milestones, failure behavior, verification, rollout, and measurable outcomes, without pretending that advisory memory can replace authoritative sources.
