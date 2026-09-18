# Changelog

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
