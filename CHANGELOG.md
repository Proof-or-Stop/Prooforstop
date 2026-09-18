# Changelog

## Lab dynamic-selection-cost - v0.3.411 - 2026-09-18

- Enable `validate.dynamic.mode=enforce-low-risk`. The production handler now executes the selected subset for eligible low-risk inputs; signed evidence admission, catalog risk floors, mandatory full-only policy and fail-closed full fallback remain unchanged. The user requested local integration after reviewing the measured limitations.
- Add a frozen, reproducible experiment: `node scripts/lab-dynamic-selection-cost.mjs`. Identical harness and contract digests produced target RED at `8274105adeb70c71486d4718f1fc723597206b57` and GREEN at `1b3cf3ad8778aefa371902deaba94dcff749f4b3`. The historical A/B/B/A sample reduced actual launches from six to two (66.7%), while mean wall time increased from 3.964 to 5.528 seconds (39.5%). Finish separately replays and records the prepared candidate; no latency improvement is claimed.
- Preserve fault detection and evidence boundaries: both modes caught the same injected arithmetic defect; missing baseline, shared-risk inventory and unmapped source changes each triggered one full fallback. An unchanged signed PASS reused evidence without launching children in both modes, and missing signatures were refused. Frozen acceptance, selector pinning, atomic remediation with one proof for two Findings, and shared receipt publication are covered by existing regression controls. These bounded cases do not establish population error reduction or sequential-remediation speedup.
- Disclose experiment limits in `docs/lab/dynamic-selection-cost/CONTRACT.md`: synthetic workloads and fixture-only OS-home queue isolation use real selector/executor/signing/consumer paths but synthetic causal/PRE_CERT prerequisites, not a full Story lifecycle. The inspected real catalog had 240 commands, 117 non-local risk rows and 65 full-only rows, so its existing full-catalog risk floor still forces conservative full execution. Real-repository savings remain unproven. Mechanical workloads made no model-service calls; development token costs were unavailable, not zero.
- Preserve detailed evidence at `.git/lab-maintenance/dynamic-selection-cost-measurements/REPORT.md`, raw measurements in the same directory, and the signed local Lab record at `.git/lab-maintenance/dynamic-selection-cost.json`. Build, exact candidate replay, independent different-vendor audit and post-merge replay are required by finish. This local maintenance record does not claim formal Story DONE or independent product-release evidence. No remote push is requested.

Maintenance provenance: codex/lab-dynamic-selection-cost, repair 41167c56239c58adbfa62afcdee95fc6128ac744.
Verification command (replayed before integration and on main): `["node","scripts/lab-dynamic-selection-cost.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab changelog-compact-history - v0.3.410 - 2026-09-18

- Compact legacy CHANGELOG entries, preserving newer releases and a Git link to the complete earlier history.
- Keep future entries to 3-5 final-change bullets; read only the current entry or relevant diff and link detailed records.
- Preserve frozen-history checks: accept only the exact compact baseline with byte-verified ancestor history, while allowing normal release prepends.
- Verification: compaction controls, static-edge validation and the process-fact contract passed. The unrelated identity scan retains its existing failures; see [verification details](docs/audits/changelog-compaction.md).

Maintenance provenance: codex/lab-changelog-compact-history, repair 62e3d3aaa5855e54f8a9cf254d25127cb9f1f150.
Verification command (replayed before integration and on main): `["node","scripts/verify-changelog-compaction.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-native-hash-verifier - v0.3.409 - 2026-09-17

Restore execution of the existing independent exact-digest hash oracle when its production TypeScript import graph contains non-erasable syntax. The verifier now installs a process-local TypeScript compilation hook while preserving its existing source resolver; production source and global loaders remain unchanged. Original 27 golden digest expectations, publication/tamper checks and invalidation checks are preserved. Focused assertions also retain failed Git observation identity, observation lifetime and retry behavior for incomplete commands. The existing static child exception keeps the same caller, child and invocation while its source excerpt/digest is refreshed for the changed verifier. Target RED was the observed unsupported TypeScript syntax failure; the same command must pass GREEN and the exact candidate must pass an independent vendor audit before integration. This is local maintenance, not Story DONE or a benchmark speedup claim.

Maintenance provenance: codex/lab-benchmark-native-hash-verifier, repair 9241984ed3b5dbc58e95a8ea740459f5a7695eac.
Verification command (replayed before integration and on main): `["node","scripts/verify-hash-accuracy.mjs"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## Lab benchmark-done-recovery-branch-snapshot - v0.3.408 - 2026-09-17

Restore partial-DONE recovery when the committed Story record exists only on its unmerged Story branch. The handler now resolves its integration target from the same committed branch snapshot used by discovery, with the existing local-store fallback. Recovery probes and merges use explicit local branch refs, and the checked-out branch is identified without tag-name ambiguity. Clean-worktree, merge-feasibility and local integration safeguards remain active.

The pinned artifact release suite covers branch-only legacy-main recovery, frozen non-main recovery, same-named tags, release ledgers, cleanup and runtime version/build behavior. The original failure was recorded as target RED before the repair. GREEN and independent vendor audit must be current before integration. An additional product-capability suite passed 25 checks, and recovery scanner behavior/process-budget controls passed 22 checks. Claude audit identified a detached-HEAD diagnostic regression; the candidate now preserves checkout guidance and adds a no-merge refusal test. The complete static-edge guard passed after retaining the existing runtime contract unchanged and limiting the repair to the handler, branch reader and focused tests. A separately attempted repository runtime-fact suite still reported STATIC_AST_PARSER_OBSERVER_SOURCE_DRIFT; this unrelated result is retained, not represented as a PASS. No formal Story DONE, benchmark speedup, complete token accounting or remote release is claimed.

Maintenance provenance: codex/lab-benchmark-done-recovery-branch-snapshot, repair fffff4c36d019f4b05062535b3bd21d88ed09285.
Verification command (replayed before integration and on main): `["node","packages/main/dist/tasks/artifact-release-ledger-smoke.js"]`.
This entry does not assert formal Story DONE or signed product-release credentials.

## v0.3.407 - 2026-09-17

- Allow a temporary parent directory that contains a sibling worktree; still reject a temporary parent inside a protected root.
- Keep the mutation guard strict: observed writes inside protected roots, including activity-log appends, remain mutations. The proposed log exemption was withdrawn.
- Verify the temp-parent repair with `node scripts/verify-quorum-smoke-host-activity-temp-overlap.mjs`; host-hook logging is handled separately.

## Earlier history

Earlier entries were removed from this file at the user's request on 2026-09-18.
The complete history through v0.3.407 remains in Git:

```sh
git show a8768173bc7488aa8fdc3ef45f1ed295cbd924c8:CHANGELOG.md
```
