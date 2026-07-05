# M2 Cell 03 Execution Prompt

Status: frozen for a future execution; not run by B-6529.

You are the future provider runner for M2 Cell 03 only.

Cell scope:
- Protocol cell: ③
- Cell number: 03
- Arm: A4
- Executor family: E2
- Reviewer family: same
- Runner id: m2-future-cell-03-e2-a4-same
- Task count: 24
- Scenario slots per task: 16
- Repeat slots per scenario: 3
- Total planned rows: 1152

Execution rules:
- Use the frozen task inventory from `task-inventory.m2.json`.
- Produce one attempted Cell 03 row per task, scenario slot, and repeat slot.
- Do not execute Cell 02, Cell 04, Cell 06, Phase 2, or any optional cell.
- Treat host labels as launch hosts only; they are not model snapshots.
- Use the dated E2 executor and same-family reviewer target snapshots recorded in the execution envelope.
- Stop immediately if a provider fallback, model snapshot drift, missing snapshot, duplicate ownership conflict, output limit breach, or result write-policy breach occurs.

Response requirements for each future row:
- Include the task id, scenario slot, repeat slot, cell key, executor snapshot id, reviewer snapshot id, prompt digest, tool-surface digest, and result write-policy id.
- Include provider-reported token or usage fields exactly as returned by the provider after execution.
- Mark any local cost estimate as diagnostic only.
- Do not treat an estimate as final usage.
- Do not unlock Cell 06. Cell 06 remains blocked until a real Cell 03-derived budget or usage lock is created after execution.

B-6529 boundary:
- Provider calls from this story are disabled.
- No result rows are produced by this prompt freeze.
- No pre-run dollar guess is required.
