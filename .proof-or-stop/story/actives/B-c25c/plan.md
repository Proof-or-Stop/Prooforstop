# B-c25c Plan

## Goal

Prepare a Cell 03-only M2 provider execution launch guardrail for the
multi-model ablation protocol. The story records what must be true before Cell
03 can be treated as launch-ready, but it does not run provider calls, write
result rows, unlock Cell 06, or make paper/product claims.

## Milestone Ledger

| Layer | Milestone / Task | Status | Solves / Acceptance Target | Evidence |
|---|---|---|---|---|
| M0 | Red/status baseline | In Progress | Prove the current state is Cell 03 next but provider execution disabled, and Cell 06 blocked. | Existing checker output before edits. |
| M1 | Cell 03 launch authorization artifact | Not Started | Add a Cell 03-only guardrail artifact. Exact budget approval must include amount, currency, approval source, approver, and date; otherwise provider calls remain disabled. | New JSON artifact plus launch artifact reference. |
| M2 | Checker and negative controls | Not Started | Validate the guardrail and reject invented budget, host-label snapshots, provider fallback, outcome rows, duplicate ownership, and Cell 06 unblocking. | `node experiments/multi-model-ablation/m2-provider-execution-check.mjs`. |
| M3 | Docs/status ledger | Not Started | Make the milestone state readable for future hosts without implying result evidence. | README, status, and provider-execution plan updates. |
| M4 | Local validation | Not Started | Run local-only validation; prove no provider records file exists. | Checker transcript and Lattice verification evidence. |
| M5 | Lattice review/validate/DONE | Not Started | Complete review, validation, delivery check, summary, and DONE merge. | Lattice review and DONE evidence. |

## Execution Order

1. Capture the current checker output as M0 baseline evidence.
2. Add `m2-cell03-provider-launch-authorization.json` as a Cell 03 guardrail
   artifact.
3. Update `m2-provider-execution-launch.json` to reference the guardrail without
   enabling provider calls or result rows.
4. Extend `m2-provider-execution-check.mjs` to validate the guardrail and fail
   malformed variants closed.
5. Update `m2-status.md`, `README.md`, and the provider execution plan so future
   hosts see what is done, what remains pending, and what remains blocked.
6. Run local-only checks and Lattice lifecycle review/validate/DONE.

## Explicit Non-Goals

- No provider API calls.
- No provider spend.
- No `records-multi-model-ablation.jsonl`.
- No outcome rows or result rows.
- No Cell 06 A2prime execution or budget-lock generation.
- No Cell 02 or Cell 04 execution.
- No H-M1, H-M3, model-agnostic paper claim, product gate, runtime memory, or
  playbook behavior change.
- No edits to unrelated Tier-C documents or active stories.

## Budget Approval Rule

The story must not invent a nonzero budget cap. A budget approval is valid only
when it records an exact amount, currency, approval source, approver, and
approval date. When that exact approval is absent, the Cell 03 guardrail remains
recorded but provider execution remains disabled.
