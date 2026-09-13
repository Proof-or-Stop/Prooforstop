# One intake maintenance Lab

The user requested one managed Lab for the existing Memory timing and static scanner AST repairs. The retained workspace is Lab-memory-intake-measurement, branch codex/lab-memory-intake-measurement. It now owns both repairs. This consolidation does not release or integrate either repair into main.

## Preservation and verification

The scanner branch is merged with its full ancestry, not copied as an untraceable patch. Original final heads are Memory 31cee7abd9304f10b77d8ede074a63ba7317d93a and scanner 0884d377923488f00bdbd94d8b63426cd599678c. import-source-parity.json proves that both product repairs and scanner controls retain their reviewed bytes. The two original evidence directories are retained under docs/lab. Their original logs and provenance describe those historical heads; they are not silently relabelled as evidence for the combined head.

The runtime registry and verifier include both facts and execute all three controls. Conflicting static-edge pins are rebound only to combined caller locations, real source excerpts and current dependency hashes, preserving both exact new entries and unrelated policy. The new Lab-only wrapper is a manual maintenance entry, not a configured validate command or a new child-process exception. Each child has 180s and the managed wrapper has a 900s total budget.

The original consolidation command was `node scripts/lab/verify-intake-consolidation.mjs`. RED was captured at d8f40b5615 before the scanner implementation was imported: Memory passed, and the real scanner still parsed 368 times for 234 inputs, failing STATIC_AST_REPEATED_IDENTICAL_INPUT. GREEN runs that same command after importing the repair and includes Memory timing/alignment, full scanner report parity, AST count, source freshness and argv/identity isolation. Historical Memory RED remains reachable and its signed record remains preserved.

Fresh consolidated runtime-contract and static-boundary outputs are stored in consolidated/, together with source provenance. Previously measured speed improvements are historical observations; consolidation itself is not claimed as another performance improvement. A fresh different-vendor audit must approve the combined candidate; previous independent approvals apply only to their original heads.

## Source workspace retirement

After combined verification, the user-authorized cleanup removes only Lab-static-ast-reuse and its codex/lab-static-ast-reuse branch. Cleanup must verify that the original source head is an ancestor of the retained head, the source workspace has no new changes, its sole generated override matches the signed record, and the global package does not link into it. Worktree removal and branch deletion use ordinary non-forced Git commands.

The current CLI has no consolidate or archive action. Signed historical Lab records and audits remain unmodified in the git common directory; they are historical provenance, not a second workspace to maintain. Cleanup is not represented as a formal Lab finish, main integration, release or Story DONE. Unknown changes or a failed cleanup preserve the source workspace for recovery.

## Historical intake follow-up

The same Lab now includes bounded workspace discovery, baseline probe and tree-failure-witness repairs. That follow-up used `node scripts/lab/verify-intake-history.mjs`; it includes the original consolidation command and its Memory/scanner controls. See [the follow-up report](history-repair/REPORT.md) for RED provenance, before/after measurements, preserved failure boundaries and the explicit no-new-regressions workspace health result. Earlier GREEN/audit records remain scoped to their original heads.

## Second repair cycle

The second-cycle pinned command was `node scripts/lab/verify-intake-round-two.mjs`. It requires absolute workspace-health success, early Memory-hit construction controls, and the prior consolidated/history controls. The former 38/40 baseline is now 40/40. See [second-round results](round-two/REPORT.md) for current scope, RED provenance, measurements and cache boundaries. All earlier records remain bound to their historical candidates.

## Current third repair cycle

The current pinned command is `node scripts/lab/verify-intake-round-three.mjs`. It adds operation-scoped learning-root reuse and boundary checks, then reruns the full second-cycle wrapper. See [third-round results](round-three/REPORT.md) for cold/warm before-after data, preserved overflow fallback behavior, selected live sampling and the unchanged remaining hash-call breakdown. All changes remain in this same Lab.
