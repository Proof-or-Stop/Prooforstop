# Multi-Model Ablation M2 Provider Execution Plan

Status: Cell 03 complete only. B-6529 remains the no-provider-call readiness
boundary with `providerExecutionAuthorized=false` and
`providerCallEnabled=false`. B-991d separately opened, used, and closed a
Cell 03-only execution window for ③ A4 E2 same-family rows under the frozen
envelope. Current Cell 03 execution evidence records `finalRows=1142/1152`,
`terminalExhaustedRows=10`, `pendingExecutableRows=0`, and
`totalTokens=219253501`. Exact dollar cost is not recorded or invented because
no billing export or versioned pricingRef is attached. Downstream claims remain
locked.

## Purpose

The M0/M1/M2 artifacts provide a provider-free readiness boundary: protocol
freeze, seed and cell matrix freeze, dated provider-family declarations, task
inventory binding, and Phase 1 runner-family planning. B-6529 added the frozen
Cell 03 envelope and accounting policies without making provider calls. B-991d
then executed only the Cell 03 / protocol ③ A4 E2 same-family scope. It did not
authorize Cell 02, optional Cell 04, Cell 06, Phase 2, paper wording, product
gates, playbooks, runtime guidance, or DONE gates.

This document now records the post-execution M2 state. The frozen envelope still
records exact Cell 03 scope, task/row count, retry/time/token/output limits,
stop conditions, dated E2 executor/reviewer target snapshots, prompt/tool
digests, runner ownership, duplicate policy, and result output policy. The
completed Cell 03 rows and postflight usage artifacts are descriptive inputs
only. They can feed a separate Cell 06 story as usage/sequencing input, but they
do not authorize Cell 06 execution or any downstream claim.

## Research Boundary

- B-6529 provider execution remains disabled and made no provider calls.
- B-991d provider calls were scoped to Cell 03 / protocol ③ A4 E2 same-family
  rows only.
- No Cell 02, Cell 04, Cell 06, Phase 2, or powered-matrix rows have run.
- Cell 03 result rows exist only as Cell 03 descriptive evidence; they are not a
  complete Phase 1 or Phase 2 dataset.
- Exact dollar cost is withheld rather than guessed until a billing export or
  versioned pricingRef exists.
- No paper claims, product gates, playbooks, runtime guidance, or DONE gates are
  changed.
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
| M2 provider authorization metadata | Done, disabled | B-11be records metadata-only approval, provider spend USD 0.00 as a historical no-spend boundary rather than a future launch cap, no provider cells run, no result rows, cell 03 next, and cell 06 blocked. |
| Cell 03 execution envelope | Frozen, disabled | B-6529 records `m2-cell03-execution-envelope.json`: exact Cell 03 scope, 24 tasks, 1,152 planned rows, retry/time/token/output limits, stop conditions, dated E2 target snapshots, prompt/tool digests, runner ownership, duplicate policy, and result output policy. |
| Cell 03 usage accounting | Complete | `future-cell03-results/usage-summary.json` records provider-reported usage for all final Cell 03 rows: `totalTokens=219253501`. Exact dollar cost is not faked without a billing export or versioned pricingRef. |
| Cell 03 launch guardrail | B-6529 preserved; B-991d complete | B-6529 records the disabled guardrail. B-991d records the separate Cell 03-only execution provenance and completion state. |
| M2 provider execution launch | B-6529 preserved; Cell 03 complete only | `m2-provider-execution-launch.json` preserves `authorization_ready_execution_not_run`; B-991d evidence is separate and scoped to Cell 03 only. |
| Cell 03 calibration | Complete | `future-cell03-results/full/cell03-summary.json` records `finalRows=1142/1152`, `terminalExhaustedRows=10`, `pendingExecutableRows=0`, and `executionComplete=true`; only final rows are formal for analysis. |
| Usage/sequencing input for Cell 06 | Available, not an execution unlock | `future-cell03-results/cell03-usage-lock.json` is a real Cell 03-derived usage/sequencing input for a separate Cell 06 story. |
| Cell 06 sequencing | Input available; execution not authorized | E2 A2prime remains not started and requires a separate Cell 06 launch/execution story. |
| Cell 02 cross-review | Blocked behind launch discipline | Run E1 A4 cross-review only after provider execution is authorized and cell ownership/duplicate policy are locked. |
| Optional cell 04 | Optional, budget-permitting | Run E2 A4 cross-review only if the future execution approval explicitly includes it. |
| M3 Phase 2 decision | Pending | Decide from real Phase 1 records and budget, not from readiness artifacts. |
| M4 powered matrix | Pending | Launch only under a separate Phase 2 budget, protocol, and execution approval. |
| M5 analysis and recompute | Pending | Analyze and independently recompute real records; explain any differences. |
| M6 wording guard | Pending | Update paper wording only to claims supported by the locked records and recompute. |

## B-991d Cell 03 Real Execution Story

B-6529 is readiness and no-provider-call evidence: it freezes the Cell 03
envelope, target declarations, prompt/tool digests, duplicate policy, output
policy, and postflight accounting requirement while keeping provider calls
disabled. B-991d is the separate real-execution provenance story for Cell 03
only. Its records identify the Cell 03 execution window, the dated OpenAI GPT
executor/reviewer snapshots, the rows produced or terminally exhausted, and the
provider-reported token usage returned after the run.

B-991d opened provider calls only for Cell 03 under the frozen envelope and then
completed data collection for that scope. Pre-run dollar guesses were not launch
gates. Postflight provider-reported usage is recorded; exact dollar cost remains
null because the run artifacts do not contain a provider-reported dollar cost,
billing export, or versioned pricingRef.

B-991d is host-neutral. Execution host or adapter labels may describe where a
run was launched, but they do not substitute for dated provider executor and
reviewer snapshots. Codex, Claude, Antigravity, or other host labels are not
provider snapshots and must not be recorded as if they were provider model
provenance.

Cell 02, Cell 04, Cell 06, Phase 2, paper wording, product gates, and playbook
activation remain locked and out of scope for this Cell 03 real-execution story.
No Cell 02 or Cell 04 rows were launched, Cell 06 A2prime remains unstarted and
requires its own story, Phase 2 remains unapproved, paper claims remain
unchanged, product gates remain unaffected, and playbook activation remains
disabled.

| Cell 03 real-execution milestone | B-991d ledger entry | Exit evidence |
|---|---|---|
| M0 plan boundary | Added the bounded section without provider calls and distinguished B-6529 readiness/no-provider-call evidence from B-991d real execution provenance. | B-6529 remains no-provider-call readiness evidence. |
| M1 frozen-envelope preflight | Reconfirmed the B-6529 Cell 03 envelope, 24-task inventory, 1,152 planned rows, prompt/tool digests, duplicate policy, output policy, and stop conditions before launch. | Frozen inputs stayed unchanged for B-991d Cell 03. |
| M2 Cell 03 execution-window provenance | Opened and used the Cell 03 execution window only under B-991d with explicit provider-call enablement for the frozen envelope. | Timestamped execution-window record with `providerCallEnabled=true` for Cell 03 only; pre-run dollar guesses were not launch gates. |
| M3 provider provenance capture | Recorded dated provider executor and reviewer snapshots from the run context and responses; host labels remain routing context only. | Provider snapshot fields are present and are not Codex/Claude/other host-label substitutes. |
| M4 Cell 03 provider run | Executed only E2 A4 same-family Cell 03 rows within the open window and frozen limits. | Real Cell 03 row records exist; no Cell 02, Cell 04, Cell 06, or Phase 2 execution. |
| M5 duplicate/retry handling | Applied the frozen retry and duplicate policy to every attempted row. | Retry, duplicate, fallback, timeout, and void decisions are recorded per policy. |
| M6 result-row freeze | Froze Cell 03 real result rows under the result output policy after execution completed. | `finalRows=1142/1152`; 10 planned rows are terminal exhausted and not formal final rows. |
| M7 postflight usage/cost accounting | Recorded provider-reported token usage from provider responses. | `totalTokens=219253501`; exact dollar cost is withheld rather than guessed. |
| M8 Cell-03-derived usage/sequencing input | Derived the Cell 03 usage lock from real Cell 03 rows plus provider-reported usage accounting. | Input is available for a separate Cell 06 story; it is not a generic unlock. |
| M9 closure and non-activation | Closed Cell 03 data collection and preserved all out-of-scope locks. | Cell 02, Cell 04, Cell 06, Phase 2, paper wording, product gates, and playbook activation remain locked/out of scope. |

## Required Ordering

1. Metadata authorization first: B-11be records a USD 0.00, metadata-only
   no-spend boundary without provider calls, result rows, or product-gate
   impact. This historical no-spend record is not a future launch cap.
2. Cell 03 execution envelope next: B-6529 freezes exact Cell 03 execution
   bounds and target metadata while provider spend and provider calls remain
   disabled.
3. Real launch gate next: B-991d explicitly enabled provider calls for the
   frozen envelope and Cell 03 only. It did not use a pre-run dollar cap as the
   sole launch gate.
4. Cell 03 calibration after that: B-991d completed E2 A4 same-family Cell 03
   data collection with 1,142 final rows and 10 terminal exhausted planned rows.
5. Postflight accounting after Cell 03: provider-reported token usage is
   recorded with `totalTokens=219253501`; exact dollar cost is not faked.
6. Real usage/sequencing input after Cell 03: the Cell 03-derived usage lock is
   available for a separate Cell 06 story.
7. Cell 06 remains separate: A2prime execution, analysis, and claims are not
   authorized by the Cell 03 lock or by this story.

## Authorization Metadata

The launch layer must treat these fields as blockers when missing:

| Field | Required meaning |
|---|---|
| Frozen execution envelope | Exact Cell 03 scope, row count, retry/time/token/output limits, stop conditions, snapshots, prompt/tool digests, runner ownership, duplicate policy, and result output policy. |
| Dated executor target snapshot | Dated E2 provider model target snapshot for the executor, not a host label. |
| Dated reviewer target snapshot | Dated E2 same-family target snapshot for Cell 03 review, not a host label. |
| Prompt digest | Digest of `m2-cell03-execution-prompt.md`. |
| Tool-surface digest | Digest of `m2-cell03-tool-surface.json`. |
| Runner ownership | One owner per cell-key family unless a duplicate policy says otherwise. |
| Duplicate policy | Pre-registered handling for retries and duplicate cell keys. |
| Result output policy | B-6529 froze the no-row readiness write policy; B-991d wrote and froze only completed Cell 03 rows under that policy (`finalRows=1142/1152`, `terminalExhaustedRows=10`). |
| Postflight usage accounting policy | Provider-reported usage required after execution. Estimates are diagnostic only. |

Host-label-only snapshots are rejected. `Codex CLI`, `Codex App`,
`Claude Code CLI`, `Antigravity CLI`, and `agy` may describe hosts or adapters;
they do not satisfy executorSnapshot or reviewerSnapshot requirements.

Provider fallback is rejected. A run that falls back to another provider,
changes model snapshot, omits the snapshot, or loses required metadata is not a
valid outcome row for this protocol.

## Explicit Non-Claims

- B-6529 provider calls remain disabled and B-6529 does not become an execution
  story.
- Cell 03 execution envelope: frozen.
- Cell 03 execution result: `finalRows=1142/1152`,
  `terminalExhaustedRows=10`, `pendingExecutableRows=0`.
- Postflight provider-reported usage: `totalTokens=219253501`.
- Exact dollar cost: not recorded or invented without a billing export or
  versioned pricingRef.
- Cell 03 rows support descriptive Cell 03 analysis only.
- Cell 06 A2prime: usage/sequencing input is available for a separate Cell 06
  story, but Cell 06 execution and claims remain unauthorized.
- No H-M1 or H-M3 proof exists.
- No Phase 1 directional readout exists.
- No model-agnostic wording is unlocked.
- No Proofbound product gate, DONE gate, playbook, runtime memory, or default
  agent behavior is affected.
