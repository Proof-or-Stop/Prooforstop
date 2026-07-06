# B-991d Cell 03 Full Run

This directory contains the CHK-006 full Cell 03 execution artifacts.

- `run-full.mjs --dryRun --force` writes the deterministic 1,152-key expected manifest without provider calls.
- `run-full.mjs --limit <n>` runs the next resumable batch of Cell 03 rows.
- `cell03-rows.jsonl` is append-only for row attempts. A cell key may have at most two attempts and at most one final row.
- `validate-full.mjs` validates partial or complete artifacts. `validate-full.mjs --requireComplete` is the DONE-grade check for CHK-006.
- Provider-visible workspaces include only `prompt.md`, `acceptance.mjs`, `task.json`, and generated `solution.mjs`. Hidden oracle/reference/injection files remain outside provider-visible workspaces.

This directory is Cell 03 only. It does not run Cell 06, Phase 2, product gates, playbook activation, or paper claim upgrades.
