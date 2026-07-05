# B-991d Plan: M2 Cell 03 Real Provider Execution

## Objective

Move M2 Cell 03 from authorization-ready metadata into a separate auditable execution story, without rewriting B-6529 as execution evidence. B-991d first updates the existing M2 provider execution plan, then can later open only the Cell 03 execution window, run probe/full rows, and compute actual provider-reported usage after execution.

## Non-Negotiable Boundaries

- B-6529 remains historical no-provider-call readiness evidence.
- B-991d must record provenance for any execution artifact it opens or supersedes.
- Provider calls stay disabled until the execution window milestone opens.
- Pre-run dollar guesses are not launch gates; postflight provider-reported usage/cost is required.
- Cell 02, Cell 04, Cell 06, Phase 2, product gates, playbook activation, and paper claim wording remain out of scope.

## CHK-001

**Goal**: Update the existing M2 provider execution plan with a B-991d Cell 03 Real Execution Story section and M0-M9 ledger.

**Work**: Modify `docs/requirements/decisions/multi-model-ablation-m2-provider-execution-plan.md` only. Add the B-6529/B-991d provenance split, execution invariants, milestone ledger, and user-facing status semantics.

**Verify**: `rg -n "B-991d Cell 03 Real Execution|Cell 03 Real Execution Story" docs/requirements/decisions/multi-model-ablation-m2-provider-execution-plan.md` succeeds, and the section states provider calls remain disabled until B-991d opens Cell 03.

## CHK-002

**Goal**: Re-run preflight freeze checks before provider execution.

**Work**: Use the existing M2 checker to confirm the Cell 03 execution envelope remains frozen before any provider call.

**Verify**: `node experiments/multi-model-ablation/m2-provider-execution-check.mjs` passes and reports the Cell 03 execution envelope as frozen.

## CHK-003

**Goal**: Define execution receipt and result-row contract.

**Work**: Update or create the result write policy so formal rows bind cell key, task, scenario, repeat, executor/reviewer snapshots, prompt digest, tool digest, provider usage, retry/supersession metadata, and B-991d provenance.

**Verify**: Row-contract checks reject unstructured logs, missing provider usage, duplicate rows, provider fallback, and digest drift.

## CHK-004

**Goal**: Open a Cell 03-only execution window.

**Work**: Update launch artifacts under B-991d provenance so only protocol cell ③ / Cell 03 can run. Preserve B-6529 no-provider-call readiness evidence via explicit supersession/refers-to semantics.

**Verify**: Launch artifacts enable only Cell 03 and continue to block Cell 02, Cell 04, Cell 06, Phase 2, product gates, playbooks, and paper claims.

## CHK-005

**Goal**: Run a small probe batch before the full 1,152-row execution.

**Work**: Execute a bounded probe after the execution window opens. Capture receipts, result rows, duplicate handling, and provider usage.

**Verify**: Probe rows validate against the result contract. Failed probe rows are recorded and do not unlock the full run.

## CHK-006

**Goal**: Run the full Cell 03 matrix.

**Work**: Execute 24 tasks x 16 scenarios x 3 repeats for Cell 03 after the probe passes, preserving one formal final row per cell key and auditable retry supersession.

**Verify**: All 1,152 expected cell keys have valid final status or explicit missing/failed accounting.

## CHK-007

**Goal**: Compute postflight usage and derived cost.

**Work**: Aggregate actual provider-reported usage after execution and derive cost from the provider usage fields. Estimates remain diagnostics only.

**Verify**: Usage summary is based on provider-reported fields; rows missing usage stay non-formal.

## CHK-008

**Goal**: Derive the Cell 03 usage lock for downstream A2prime sequencing.

**Work**: After Cell 03 rows and usage are complete, derive the dependency artifact Cell 06 needs. Do not execute Cell 06 in this story.

**Verify**: The lock is derived from actual Cell 03 rows and usage, not examples or declarations.

## CHK-009

**Goal**: Make Cell 03 data analysis-ready without overclaiming.

**Work**: Record exactly what Cell 03 can support and what it cannot support alone. Do not update paper wording unless later analysis warrants it.

**Verify**: Analysis readiness does not claim H-M1, H-M3, model-agnostic conclusions, Phase 2 approval, product gate changes, or playbook activation.

## CHK-010

**Goal**: Close B-991d with delivery check and cost/claim summary.

**Work**: Summarize what ran, row completeness, failed/missing rows, actual usage/cost, B-991d provenance, and remaining blocked cells.

**Verify**: DONE summary and delivery check report Cell 03 status without hiding failures or implying Cell 06/Phase 2/product/playbook/paper unlocks.
