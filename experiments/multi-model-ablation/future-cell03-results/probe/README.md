# B-991d Cell 03 Probe

This directory contains the bounded CHK-005 probe for the B-991d Cell 03 execution window.

- `run-probe.mjs` runs two Cell 03 probe rows through `codex exec --json` in isolated task workspaces.
- Raw provider stdout/stderr is not persisted; rows store response digests, byte counts, usage fields, and status.
- `validate-probe.mjs` checks B-991d provenance, Cell 03-only scope, provider usage, uniqueness, and negative controls.
- Probe success may unlock CHK-006 full Cell 03 execution. It does not unlock Cell 06, Phase 2, paper claims, product gates, or playbook activation.
