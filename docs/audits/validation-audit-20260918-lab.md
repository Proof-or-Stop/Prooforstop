# Validation audit Lab checkpoint

The user authorized preservation and continued bounded repair of the validation audit on 2026-09-18. This Lab starts from local main 0.3.420. Historical observations target 0.3.408 and do not become new Lab RED/GREEN records by being archived. The original external workspace remains intact.

- Lab: `validation-audit-20260918`; branch: `codex/lab-validation-audit-20260918`.
- Historical base: `967187635c961774341c021baa3921d16f8a822d`.
- Lab base: `4fed1bc1fd280ba5e6d3420e1eb6a55c9445e87c`.
- Durable local archive: `/Users/jek/Documents/GitHub/Prooforstop/.git/lab-evidence-archives/validation-audit-20260918/historical-evidence.tar.gz`.
- Archive SHA-256: `3353d4c2ec201434459280c6efded52cd1e7ac5b60cf6c18e821d869541feb49`.
- Manifest SHA-256: `50418efc0f15317eabd15490f958fe7a35bcd0b1cdc082fa2d1a4b6ff042f8f1`.
- Archived files: 2180; every archived member was read back and matched its original byte count and SHA-256. The archive includes the original 240-command audit, logs, 12 candidate proof pairs, runtime candidate overlays, and the selected follow-up experiments. Dependency trees, Git internals, private candidate checkouts and runtime state directories are excluded.
- The two-file registration candidate is also retained as `registration-candidate-e090654c6c40.patch` beside the archive; SHA-256: `c41bb537af2c1ed383fbc7cc9af70e31f78ce252585de2f1bccc84a3fceb3d21`. Historical runtime overlays are preserved as candidates, not claimed to be executable repairs on the new baseline.

## Historical evidence and remaining work

| Audit command numbers | Retained evidence | Required work on this Lab baseline |
|---|---|---|
| 9, 12, 13, 89, 90, 95, 106, 119, 136, 150, 158, 168 | Twelve full candidate double-pair results; exact scope and budget limits in the archived repair-status report | Reconcile candidates with current main before applying; preserve existing fixes and original assertions |
| 16, 69, 130 | Two budget contrasts each; no proof of success within the original 180-second budget | Measure comparable load and repair measured execution or calibrate explicit accepted budgets without masking failures |
| 1 | Outer timeouts and an inner 120-second timeout; extended full pass was not stable | Remove the inner timeout cause and earn two full GREEN runs |
| 148 | Two local shared-owner false-positive repair pairs; whole suite remains unclosed | Complete identity ownership/public-operation coverage and valid fixtures; preserve rejection controls |
| 50 | Two local coordination-topology pairs and one whole 73-case isolated pass | Integrate coordination isolation into the validator and run the whole suite |
| 7, 14 | Two real capacity-contention/release pairs; unchanged budgets and assertions | Preserve environmental classification; do not weaken assertions to manufacture a code repair |

## Execution boundary

No integration, finish or push was requested. Keep this worktree, archive, commits and tool-owned Lab records. A fresh regression must be committed and fail with its target assertion through `lab:worktree red` before a repair is called a new Lab RED/GREEN cycle. A missing dependency or a killed/timeout command is not target RED. Fresh tests use independent local dependencies and dist; the archive is not a shared executable build.
