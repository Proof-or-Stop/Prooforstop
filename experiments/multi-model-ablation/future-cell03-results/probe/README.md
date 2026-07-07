# B-991d Cell 03 Probe

This directory contains the bounded CHK-005 probe for the B-991d Cell 03 execution window.

- `run-probe.mjs` runs two Cell 03 probe rows through isolated scratch workspaces.
- Each row has an executor `codex exec --json` call plus a fresh same-family read-only reviewer `codex exec --json` call.
- Hidden oracle files such as `ground-truth.mjs` and `reference-solution.mjs` are not copied into provider-visible workspaces; ground truth is run only after executor and reviewer calls finish.
- Raw provider stdout/stderr is not persisted; rows store response digests, byte counts, executor usage, reviewer usage, aggregate usage fields, review verdict, acceptance status, hidden ground-truth status, and final status.
- `validate-probe.mjs` checks B-991d provenance, Cell 03-only scope, executor and reviewer usage, reviewer freshness, ground-truth binding, uniqueness, and negative controls.
- Probe success may unlock CHK-006 full Cell 03 execution. It does not unlock Cell 06, Phase 2, paper claims, product gates, or playbook activation.
