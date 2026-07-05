# Multi-Model Ablation M2 Provider Execution Plan

Status: authorization-ready metadata layer, execution not run. B-6529 replaces
the old guessed/exact pre-run dollar gate with a frozen Cell 03 execution
envelope plus postflight provider-reported usage accounting. The current launch
state remains `providerExecutionAuthorized=false` and `providerCallEnabled=false`.

## Purpose

The M0/M1/M2 artifacts now prepare a provider-free readiness boundary: protocol
freeze, seed and cell matrix freeze, dated provider-family declarations, task
inventory binding, and Phase 1 runner-family planning. They still do not run
provider cells, spend provider budget, write outcome rows, or authorize Phase 1
or Phase 2.

This document defines the next M2 provider execution launch layer so a future
human-approved execution story can start from explicit frozen metadata instead
of implicit guesses. The next formal step is
`nextPermittedFormalStep=cell-03-calibration`, but only with execution disabled
in B-6529. The frozen envelope records exact Cell 03 scope, task/row count,
retry/time/token/output limits, stop conditions, dated E2 executor/reviewer
target snapshots, prompt/tool digests, runner ownership, duplicate policy, and
result output policy. A pre-run dollar guess is not required. Provider-reported
usage is required after future execution; estimates are diagnostic only and are
not final usage or launch gates. Cell 06 remains `cell-06-a2prime-blocked`.

## Research Boundary

- Provider execution is disabled by default.
- Provider calls are not made by this story.
- Provider calls from this authorization story are disabled.
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
| M2 provider authorization metadata | Done, disabled | B-11be records metadata-only approval, provider spend USD 0.00 as a historical no-spend boundary rather than a future launch cap, no provider cells run, no result rows, cell 03 next, and cell 06 blocked. |
| Cell 03 execution envelope | Frozen, disabled | B-6529 records `m2-cell03-execution-envelope.json`: exact Cell 03 scope, 24 tasks, 1,152 planned rows, retry/time/token/output limits, stop conditions, dated E2 target snapshots, prompt/tool digests, runner ownership, duplicate policy, and result output policy. |
| Cell 03 usage accounting | Postflight required | B-6529 records `m2-cell03-usage-accounting-policy.json`: provider-reported usage is required after future execution; estimates are diagnostic only and not final usage or launch gates. |
| Cell 03 launch guardrail | Recorded, disabled | B-6529 records `m2-cell03-provider-launch-authorization.json`: execution envelope frozen, pre-run dollar guess not required, `providerSpendAllowed=false`, `providerCallEnabled=false`, no outcome rows, no result rows, and postflight provider-reported usage required after future execution. |
| M2 provider execution launch | Prepared, disabled | `m2-provider-execution-launch.json` records `authorization_ready_execution_not_run`; provider execution and formal Phase 1 use remain false. |
| Cell 03 calibration | Next permitted formal step, planning-only | Run E2 A4 same-family calibration only after the launch gate authorizes provider execution. |
| Budget/usage-lock freeze | Blocked | Freeze a real cell-03-derived budget/usage lock from calibration records and provider-reported usage; examples and declarations do not count. |
| Cell 06 sequencing | Blocked | Run E2 A2prime only after the matching real cell-03-derived budget/usage lock exists. |
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
only. Its records must identify when the Cell 03 execution window opens, which
provider snapshots actually answered, what rows were produced or voided, and
what provider-reported usage and cost were returned after the run.

Provider calls remain disabled until B-991d opens the Cell 03 execution window
for the frozen envelope. This plan update does not open that window. Pre-run
dollar guesses are not launch gates; they may be retained only as diagnostics.
Launch authority must come from the frozen envelope, dated provider target
snapshots, explicit provider-call enablement, and the story-owned execution
window. After execution, postflight provider-reported usage/cost accounting is
required before any budget/usage lock can be treated as real.

B-991d is host-neutral. Execution host or adapter labels may describe where a
run was launched, but they do not substitute for dated provider executor and
reviewer snapshots. Codex, Claude, Antigravity, or other host labels are not
provider snapshots and must not be recorded as if they were provider model
provenance.

Cell 02, Cell 04, Cell 06, Phase 2, paper wording, product gates, and playbook
activation remain locked and out of scope for this Cell 03 real-execution story.
No Cell 02 or Cell 04 rows are launched, Cell 06 A2prime remains blocked behind
a real Cell-03-derived budget/usage lock, Phase 2 remains unapproved, paper
claims remain unchanged, product gates remain unaffected, and playbook
activation remains disabled.

| Cell 03 real-execution milestone | B-991d ledger entry | Exit evidence |
|---|---|---|
| M0 plan boundary | Add this bounded section without provider calls and distinguish B-6529 readiness/no-provider-call evidence from B-991d real execution provenance. | Updated execution plan only; no outcome rows, result rows, provider spend, or provider calls. |
| M1 frozen-envelope preflight | Reconfirm the B-6529 Cell 03 envelope, 24-task inventory, 1,152 planned rows, prompt/tool digests, duplicate policy, output policy, and stop conditions before launch. | Frozen inputs are unchanged or the run stops for amendment; provider calls still disabled. |
| M2 execution-window open | Open the Cell 03 execution window only under B-991d with explicit provider-call enablement for the frozen envelope. | Timestamped execution-window record with `providerCallEnabled=true` for Cell 03 only; pre-run dollar guesses are not launch gates. |
| M3 provider provenance capture | Record dated provider executor and reviewer snapshots from the run context and responses; host labels remain routing context only. | Provider snapshot fields are present and are not Codex/Claude/other host-label substitutes. |
| M4 Cell 03 provider run | Execute only E2 A4 same-family Cell 03 rows within the open window and frozen limits. | Real Cell 03 row records or void records; no Cell 02, Cell 04, Cell 06, or Phase 2 execution. |
| M5 duplicate/retry handling | Apply the frozen retry and duplicate policy to every attempted row. | Retry, duplicate, fallback, timeout, and void decisions are recorded per policy. |
| M6 result-row freeze | Freeze Cell 03 real result rows under the result output policy after execution completes or stops. | Cell 03 result bundle is bounded, reviewable, and traceable to the execution window. |
| M7 postflight usage/cost accounting | Record provider-reported usage and cost from provider responses, invoices, or billing exports after the run. | Postflight provider-reported usage/cost ledger exists; estimates are diagnostic only. |
| M8 Cell-03-derived lock candidate | Derive any budget/usage lock only from real Cell 03 rows plus provider-reported usage/cost accounting. | Candidate lock exists or is explicitly withheld; Cell 06 remains blocked until a valid lock exists. |
| M9 closure and non-activation | Close the Cell 03 execution window and preserve all out-of-scope locks. | Window closed; Cell 02, Cell 04, Cell 06, Phase 2, paper wording, product gates, and playbook activation remain locked/out of scope. |

## Required Ordering

1. Metadata authorization first: B-11be records a USD 0.00, metadata-only
   no-spend boundary without provider calls, result rows, or product-gate
   impact. This historical no-spend record is not a future launch cap.
2. Cell 03 execution envelope next: B-6529 freezes exact Cell 03 execution
   bounds and target metadata while provider spend and provider calls remain
   disabled.
3. Real launch gate next: a separate provider-execution story must explicitly
   enable provider calls for the frozen envelope. It must not use a pre-run
   dollar cap as the sole launch gate.
4. Cell 03 calibration after that: run E2 A4 same-family calibration as the first
   formal provider step.
5. Postflight accounting after cell 03: record provider-reported usage from the
   provider response. Estimates may be retained as diagnostics only.
6. Real budget/usage lock after cell 03: derive and freeze the A2prime lock from
   real Cell 03 calibration records and provider-reported usage.
7. Cell 06 only after the lock: keep A2prime blocked until the real
   cell-03-derived budget/usage lock exists.

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
| Result output policy | Frozen write policy for future Cell 03 rows; this story writes no rows. |
| Postflight usage accounting policy | Provider-reported usage required after future execution. Estimates are diagnostic only. |

Host-label-only snapshots are rejected. `Codex CLI`, `Codex App`,
`Claude Code CLI`, `Antigravity CLI`, and `agy` may describe hosts or adapters;
they do not satisfy executorSnapshot or reviewerSnapshot requirements.

Provider fallback is rejected. A run that falls back to another provider,
changes model snapshot, omits the snapshot, or loses required metadata is not a
valid outcome row for this protocol.

## Explicit Non-Claims

- No outcome data exists in this launch layer.
- Cell 03 execution envelope: frozen.
- Pre-run dollar guess: not required.
- Provider calls from this authorization story: disabled.
- Postflight usage accounting: provider-reported usage required after execution.
- No Cell 03 provider calls, spend, outcome rows, or result rows exist.
- No Cell 03 outcome rows or result rows exist.
- Cell 06 A2prime: blocked.
- Cell 06 remains blocked until a real cell-03-derived budget/usage lock exists.
- No H-M1 or H-M3 proof exists.
- No Phase 1 directional readout exists.
- No model-agnostic wording is unlocked.
- No Proofbound product gate, DONE gate, playbook, runtime memory, or default
  agent behavior is affected.
