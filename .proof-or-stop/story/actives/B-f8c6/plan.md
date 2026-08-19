# B-f8c6 Plan

## Goal

Create the M0 readiness foundation for the multi-model ablation replication
campaign. This story prepares canonical documentation and deterministic example
artifacts only. It does not run Phase 1 or Phase 2 cells, call model providers,
change product gates, or treat protocol audits as ablation outcomes.

## CHK-001: Promote Canonical Protocol

Create `docs/requirements/decisions/multi-model-ablation-replication.md` from
the reviewed protocol. Preserve these M0 constraints:

- E1/E2 are provider/model-family snapshots, not host names.
- Codex CLI/App are possible hosts, not proof of E2 by themselves.
- Parallel runner outputs count only when assigned through a frozen cell
  manifest and written as formal outcome records.
- A2 prime cells require an A4-derived budget lock before execution.
- Research evidence cannot automatically change Proofbound gates, playbooks,
  runtime memory, or DONE policy.

Verification:

- `rg "E2 runner|Host cannot|Codex CLI|phase1-budget-lock|② vs ④|research evidence" docs/requirements/decisions/multi-model-ablation-replication.md`
- Manual review that the protocol remains M0-only and does not authorize Phase 1
  execution.

## CHK-002: Cell Manifest And Runner Registry Examples

Create `experiments/multi-model-ablation/cell-manifest.example.json` and
`experiments/multi-model-ablation/runner-registry.example.json`.

The examples must show:

- unique `cellKey` values;
- formal cells for ③, ⑥, ②, and optional ④;
- host identity separate from model snapshots;
- no duplicate cellKey selection after results are known;
- no A2 prime cell without a `budgetLockDigest`.

Verification:

- `node -e` JSON parse checks for both files.
- Manual checks that host names do not determine E1/E2 classification.

## CHK-003: A2 Prime Budget Lock Example

Create `experiments/multi-model-ablation/phase1-budget-lock.example.json`.

The example must record:

- executor family and snapshot placeholders;
- A4 calibration source cells;
- task-level median budget entries;
- a `budgetLockDigest`;
- a rule that A2 prime cannot influence the budget lock.

Verification:

- JSON parse check.
- Manual check that the lock exists before any A2 prime manifest row references
  it.

## CHK-004: Read-Only M0 Readiness Path

Create `experiments/multi-model-ablation/README.md` with provider-free checks.
The README should document deterministic verification commands that validate the
example files and preserve the research/product boundary.

Verification:

- `rg` checks for the key forbidden/required concepts.
- `node -e` JSON parse checks for all example artifacts.
- No provider calls, no Phase 1/Phase 2 records, and no product gate changes.

## Out Of Scope

- Running formal ablation cells.
- Selecting final E2 model snapshots for Phase 1.
- Implementing a full CLI readiness checker command.
- Changing product runtime behavior, playbooks, gates, reviewer policy, or DONE
  policy.
