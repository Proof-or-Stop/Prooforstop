## Trigger Event
On 2026-07-15, review of B-e514 showed that shrinking AGENTS.md and CLAUDE.md exposes an older mechanical contract: process-fact verification, audit, docs-drift, prompts, and runtime comments still treat CLAUDE.md as a shared truth source. The user also challenged why a Claude-specific file exists without CODEX.md or AGY.md, which revealed that host discovery conventions and canonical project truth have been conflated.

## Key Insights
Codex discovers AGENTS.md; Antigravity/agy also consumes AGENTS.md and may use GEMINI.md; Claude Code discovers CLAUDE.md. Filename asymmetry is therefore expected, but shared lifecycle and evidence facts must not live in the Claude-specific entrypoint. Root documents should be thin discovery shims, while .lattice/Lattice.md provides host-neutral navigation, an operational runbook provides verified procedures, and decision docs plus registries and gates remain normative.

## Solution Tradeoffs
A minimal pointer-only design is small but can hide non-negotiable repository safety constraints. Copying the same safety and lifecycle prose into both root files preserves visibility but recreates drift. The plan should prefer one shared AGENTS.md contract, a Claude import or compatibility shim, explicit project-local user constraints outside managed blocks, a mechanically checked canonical-doc registry, and bounded entrypoint budgets. Adding a runbook improves operability but creates another projection that must be registry-validated rather than treated as an independent source of truth.

## Conversational Texture
The user wants an implementation-ready plan, not another abstract architectural essay. The document must say exactly what files and consumers migrate, what fails before the change, what passes afterward, how to split implementation Stories, how to avoid overlapping writes with B-e514, and how to roll back safely. This Story writes only the plan and navigation entry; later Stories perform the runtime, template, verifier, reviewer, and root-entrypoint changes.
