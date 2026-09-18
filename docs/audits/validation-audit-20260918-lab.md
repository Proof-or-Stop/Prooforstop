# Validation audit Lab checkpoint

## Continued repair acceptance

The 2026-09-18 follow-up uses a finite 900-second wall-clock budget for each complete serial command #1, #16, #69 and #130. Historical unchanged-command runs needed up to 611 seconds; the former 180-second registration could truncate valid work. The process contract alone contains a child with a 720-second allowance. This change is a configuration repair and makes no speedup claim. Identical executable/argv, complete assertions, fixed committed source and build, one audit command at a time, and recorded host load are required for the new live runs. Concurrent unrelated host work is observed, not terminated.

The #1 parent deadline also included launch and cleanup inside the same 120 seconds granted to its isolated worker. The worker retains 120 seconds; the parent receives 30 seconds for the surrounding lifecycle. The structural regression reads the actual parent call and worker default from their ASTs and checks their ordering against the registered lifecycle allowances. Runtime-contract verification invokes that regression. Full-suite passes are separate evidence and remain required.

An initial process-contract diagnostic was invalidated because this assistant modified source during execution, triggering `SETUP_BUILD_STALE`. Its log is retained with `validEvidence: false`; its failure and elapsed time are excluded from RED/GREEN and performance conclusions.

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

## First repair and continuation checkpoint

The shared identity-free delegate regression was committed as `fd5026d041`. The local Lab tool recorded target RED with `IDENTITY_SHARED_DELEGATE_REJECTED`. Repair commit `af2abe3a5b` admits only the two reviewed owners and retains explicit identity-free classification. The exact pinned test then passed GREEN twice, including seven rejection controls. These records prove the local shared-owner repair, not the entire identity suite.

The next repair cycle was synchronized with main and the complete configured identity-cutover command was run through Lab RED, with the original 2700000ms ceiling. It completed with ten failed assertions and recorded the target marker `owned identity use context changed`. The current Lab GREEN is therefore empty while this broader cycle remains unresolved; the earlier successful cycle remains in tool history and in `shared-owner-lab-status.txt` in the archive directory. Ten failed assertions are not a claim of ten independent root causes.

Current complete-suite RED assertions:

- `FAIL CHK-007:happy:0 active producer registry config and current baselines are proof-or-stop only: retired protocol identity exact count drift: packages/main/src/tasks/init-check-required-agents-smoke.ts:final-negative-context-2`
- `FAIL CHK-007:adversarial:0 proofbound injection at every active boundary fails closed with zero mutation: prompt-measurement report schema: public prompt-baseline verifier did not report the identity failure: `
- `FAIL F-060 all owned source and emitted identity sites have independent totality and public-operation cases: owned identity use context changed: packages/main/src/core/prompt-role-contract-registry.ts#proof-or-stop-product-reviewer`
- `FAIL F-060 reconciled consumers still reject added and moved identity uses: owned identity use context changed: packages/main/src/core/prompt-role-contract-registry.ts#proof-or-stop-product-reviewer`
- `FAIL F-060 memory v2 ownership retains exact consumer and mutation coverage: owned identity use context changed: packages/main/src/core/prompt-role-contract-registry.ts#proof-or-stop-product-reviewer`
- `FAIL F-060 discovered-site omissions and new typed producers fail independently of registry agreement: owned identity use context changed: packages/main/src/core/prompt-role-contract-registry.ts#proof-or-stop-product-reviewer`
- `FAIL CHK-007 canonical controls: every distinct registered public operation succeeds before mutation: missing public operation for active identity boundary maintenance-command-mode`
- `FAIL CHK-007:adversarial:0 every registered identity boundary rejects through its public operation with zero mutation: every required identity path must be exercised through a registered public operation`
- `FAIL CHK-007:adversarial:2 producer consumer config and baseline inventory omissions are mutation-detected: retired protocol identity exact count drift: packages/main/src/tasks/init-check-required-agents-smoke.ts:final-negative-context-2`
- `FAIL complete identity certification includes real runtime and package witnesses once: FAIL identity-cutover: frozen boundary or lineage invalid`


The current inventory diagnostic finds two changed role contexts, two missing protocol-site entries and fifteen changed import-use contexts. This diagnostic executes no tests and is not GREEN evidence. Before any re-pinning, reconcile the responsible source changes and public-operation coverage. Existing signing fixtures now run in this linked Lab; their prior missing-key clone failures must not be reported as still reproduced here.

Continue from the saved complete-suite RED. The performance/configuration work for 16/69/130, the inner timeout in 1, and validator coordination integration for 50 remain open. Commands 7 and 14 retain their environmental classification. No whole-suite repair or main integration is claimed.
