# Multi-Model Ablation M2 Provider Execution Plan

Status: planning-only launch layer. B-11be records metadata-only authorization
with provider spend capped at USD 0.00. The current launch state remains
`providerExecutionAuthorized=false`.

## Purpose

The M0/M1/M2 artifacts now prepare a provider-free readiness boundary: protocol
freeze, seed and cell matrix freeze, dated provider-family declarations, task
inventory binding, and Phase 1 runner-family planning. They still do not run
provider cells, spend provider budget, write outcome rows, or authorize Phase 1
or Phase 2.

This document defines the next M2 provider execution launch layer so a future
human-approved execution story can start from explicit blockers instead of
implicit guesses. The next formal step is
`nextPermittedFormalStep=cell-03-calibration`, but only in planning mode until a
separate provider-execution story records real dated snapshots, prompt/tool
digests, runner ownership, duplicate policy, and nonzero provider budget. Cell
06 remains `cell-06-a2prime-blocked`.

## Research Boundary

- Provider execution is disabled by default.
- Provider calls are not made by this story.
- No Phase 1 or Phase 2 cells have run.
- No outcome records, result rows, paper claims, product gates, playbooks,
  runtime guidance, or DONE gates are changed.
- Host labels are host or adapter labels only. A host-label-only snapshot is
  not a provider model snapshot.
- Provider fallback is rejected. Any fallback, model switch, or missing dated
  snapshot must void the affected cell or require an explicit amendment.

## Milestones

| Milestone | Current state | Exit condition |
|---|---|---|
| M0 research smoke | Complete | Provider-free examples and local invariants pass without provider calls. |
| M1 protocol freeze | Complete | Protocol, seed slots, cell matrix, and launch gate remain frozen and provider execution remains blocked. |
| M2 readiness | Prepared | Dated provider-family declarations, 24-task inventory, runner-family manifest, and static launch readiness pass local checks. |
| M2 provider authorization metadata | Done, disabled | B-11be records metadata-only approval, provider spend USD 0.00, no provider cells run, no result rows, cell 03 next, and cell 06 blocked. |
| M2 provider execution launch | Prepared, disabled | A future provider-execution story records real executor/reviewer snapshot, prompt, tool-surface, runner ownership, nonzero budget cap, and duplicate-policy metadata before any provider calls. |
| Cell 03 calibration | Next permitted formal step, planning-only | Run E2 A4 same-family calibration only after the launch gate authorizes provider execution. |
| Budget-lock freeze | Blocked | Freeze a real cell-03-derived budget lock from calibration records; examples and declarations do not count. |
| Cell 06 sequencing | Blocked | Run E2 A2prime only after the matching real cell-03-derived budget lock exists. |
| Cell 02 cross-review | Blocked behind launch discipline | Run E1 A4 cross-review only after provider execution is authorized and cell ownership/duplicate policy are locked. |
| Optional cell 04 | Optional, budget-permitting | Run E2 A4 cross-review only if the future execution approval explicitly includes it. |
| M3 Phase 2 decision | Pending | Decide from real Phase 1 records and budget, not from readiness artifacts. |
| M4 powered matrix | Pending | Launch only under a separate Phase 2 budget, protocol, and execution approval. |
| M5 analysis and recompute | Pending | Analyze and independently recompute real records; explain any differences. |
| M6 wording guard | Pending | Update paper wording only to claims supported by the locked records and recompute. |

## Required Ordering

1. Metadata authorization first: B-11be records a USD 0.00, metadata-only
   approval boundary without provider calls, result rows, or product-gate
   impact.
2. Real launch gate next: a separate provider-execution story must record human
   approval for nonzero spend, dated executor and reviewer snapshots, prompt
   digest, tool-surface digest, runner ownership, budget cap, and duplicate
   policy.
3. Cell 03 calibration after that: run E2 A4 same-family calibration as the first
   formal provider step.
4. Real budget lock after cell 03: derive and freeze the A2prime budget lock from real
   cell 03 calibration records.
5. Cell 06 only after the lock: keep A2prime blocked until the real
   cell-03-derived budget lock exists.

## Authorization Metadata

The launch layer must treat these fields as blockers when missing:

| Field | Required meaning |
|---|---|
| Human approval | Explicit dated approval to spend provider budget for the named cells. B-11be's USD 0.00 metadata-only approval is not enough for real provider execution. |
| Dated executor snapshot | Real provider model snapshot for the executor, not a host label. |
| Dated reviewer snapshot | Real provider model snapshot for reviewer cells; `not_applicable` only for A2prime. |
| Prompt digest | Digest of the prompt template and provider-specific minimal adaptation. |
| Tool-surface digest | Digest of the available tool surface and execution parameters. |
| Runner ownership | One owner per cell-key family unless a duplicate policy says otherwise. |
| Budget cap | Human-approved provider budget cap for the execution window. |
| Duplicate policy | Pre-registered handling for retries and duplicate cell keys. |

Host-label-only snapshots are rejected. `Codex CLI`, `Codex App`,
`Claude Code CLI`, `Antigravity CLI`, and `agy` may describe hosts or adapters;
they do not satisfy executorSnapshot or reviewerSnapshot requirements.

Provider fallback is rejected. A run that falls back to another provider,
changes model snapshot, omits the snapshot, or loses required metadata is not a
valid outcome row for this protocol.

## Explicit Non-Claims

- No outcome data exists in this launch layer.
- No H-M1 or H-M3 proof exists.
- No Phase 1 directional readout exists.
- No model-agnostic wording is unlocked.
- No Proofbound product gate, DONE gate, playbook, runtime memory, or default
  agent behavior is affected.
