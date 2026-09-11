# REQUEST_CHANGES

Scope: the exact site/import/class updates in `post-main-owned-rebinding-proposal.json` only — not release approval. Read-only; nothing edited or committed (`git status` shows the same two untracked files as at session start). Production frozen throughout.

## What is verified correct

Every one of the 15 rows is exact and the drift set is complete:

- **All 15 `old` values equal the current pins and all 15 `new` values equal the freshly derived values**, at full 64-hex, no exceptions (compared `post-main-owned-rebinding-proposal.json` against `current-owned-contexts.json` row by row).
- **The diff is exactly these 15 rows and nothing else.** Derived vs pinned yields exactly 4 site + 10 import + 1 class drifts; **no stale pins**; imports are 46/46 on identical paths in identical order, which is what `assertOwnedImportUseIntegrity`'s `assert.deepEqual` requires; 264 derived sites = 250 owner pins + 13 classifications + **exactly one** unclassified.
- **That one unclassified site is the P0m row**, `packages/main/src/core/process-fact-registry.ts # proof-or-stop.config.json`, count 1, context `d76aa4750daa…` — byte-identical to the previously approved value. The first review's correction #2 (re-derive at final bytes, do not assume) is satisfied by measurement: the value did not move.
- **No blanket exemption, no algorithm change.** `canonical-new-story-artifacts.test.mjs` is byte-identical to main tip, so both derivers are untouched; no count relaxed; the config admission class keeps all 8 claims (the merged main entry uses `git-common-dir`/`fixed-path`, so no claim added or removed).
- **Amendment 3 checked against the diff, not the note.** `persistAdmittingCertificationWindow` is a real producer of `.certification_window.v1` (4→5); the other two extras are both reader guards inside `isCertificationRunningOnlyAdvance` (`certification_windows.v1` 2→3, `precert_receipt.v1` 4→5). The characterization is accurate.
- `merged-seven-baseline.log` at final bytes aborts on exactly `owned identity use count changed: …#proof-or-stop.certification_window.v1 / 5 !== 4` — the first proposed row — corroborating that the derivation was taken on the bytes the gate reads.

## Required changes

**1. The classification context-mutation negative is still absent, and the note still claims it exists.**
`classification context drift` appears exactly once in the repo: the live equality at `canonical-new-story-artifacts.test.mjs:3191`. The classification branch's controls (lines 3255-3259) cover only omission and count. The one `assert.throws` context-mutation control (`moved`, lines 3291-3292) targets `story-dispatch.ts#proof-or-stop-implementer` — an **owner** site — and throws the owner-branch message `owned identity use context changed`; it never reaches the classification branch. `OWNED-CONTEXT-AMENDMENTS.md` item 2 still asserts "omission/count/**context** mutation controls which iterate every classification". That is the same overclaim the first review required be corrected, unchanged. Add the two-line mirror of 3258-3259 that mutates `contextSha256` and asserts `/classification context drift/`, and fix the note. This matters more now than before: P0m is the only classification whose context this proposal sets, and it is being set from a value with no negative control behind it.

**2. The proposal does not contain the P0m classification row at all.** `grep -c d76aa475 post-main-owned-rebinding-proposal.json` = 0. All 15 rows are `old`→`new` rebindings; the addition exists only as an unclassified site in `current-owned-contexts.json` and as prose in the amendments note. Applying exactly what the proposal lists leaves `unclassified owned executable identity sites` red. Add the row explicitly with all six fields: sourcePath, canonical, `occurrences: 1`, `contextSha256: d76aa4750daa0a3bd2e672550d9704eb42847abd42415fae9a20f8fe301b6eb1`, `kind: registry-source-path`, plus reason and proof.

**3. The class row's `new` object drops `kind`/`reason`/`proof`.** `old` carries all three, `new` carries only the four positional fields. Line 3192 asserts all three non-empty, so a literal drop-in replacement fails with `owned identity classification has no bounded proof`. Amendment 1's intent ("keep all eight claims, update only the moved context digest") is right; the artifact does not express it.

All three defects sit in the same lane — the classification rows. The site and import lanes are clean.

## Provenance: pre-existing main vs imported change

**Pre-existing (not introduced here):**
- `handlers/checklist.ts` (802→803) — **byte-identical to main tip**, so the derivation being a pure function of bytes means this drift exists on main itself. Amendment 4's attribution is correct and now proven, not asserted.
- `store.ts`, `core/certification-window.ts`, `evidence-freshness.ts`, `review-inventory-epoch.ts`, `cli-init.ts`, the `process-fact-registry.ts` import row, and all three certification-window site rows — already measured at these exact values at 16:02 in `owned-context-diff-proposal.json`, i.e. before both the repair and the main merge.

**Imported from latest main (`f4778567dd`, external Go story worktrees):**
- Config site row `0cbdccc8…` (16:02) → `6673b940…` (now), count unchanged at 13; class row now `1e3cf338…`, count unchanged at 8. Cause is index displacement: the merge inserts a `verify-external-worktree-go-pre-review.mjs` block at config line ~2766, ahead of admission claims at 3156/3191/3259 (8 claims at 206/785/2194/2238/2282/3156/3191/3259).
- Both config rows are **mixed** — they had already drifted from the pin before this merge — which matches amendment 4's "mixed historical and current integration change".

**First-review-base repair (`45f4e01e63`) — the three additional rows, and only these three:**
- `core/review-run.ts`: new row, 283→283, context-only move (one added `fullStoryBaseHead: envelope.fullStoryBaseHead` property).
- `handlers/review-run.ts`: new row, 225→229 (`resolveFullStoryBaseHead` added to an existing import clause, one call site, two property lines).
- `core/review-incremental-context.ts`: revised from 310→314 (16:02) to 310→319; the +5 is the repair's.
- The repair also edited `process-fact-registry.ts`, yet its import row is byte-identical across both derivations (21 / `35c1318f…`) and no registry site row moved — confirming amendment 4's "equal import contexts, unequal source bytes" for that file.

## Bounds on this audit

- I did not re-execute the derivation (no `node` execution available here). I verified the evidence's internal consistency, read both derivers, and confirmed the failing baseline aborts on exactly the first proposed row.
- I checked whether `derive-current-owned-contexts.mjs` using the required-paths map instead of `identityCutoverSourceMap()`'s recursive set was an input mismatch. **It is not** — both `deriveOwnedIdentityLiterals` (line 2383) and `deriveOwnedImportUseContexts` (line 2883) iterate `IDENTITY_CUTOVER_REQUIRED_PATHS` and ignore extras.
- The `emitted: true` pass (line 3207, against `dist/*.js`) asserts counts only, and the current baseline aborts on the source pass before reaching it — so the proposed counts are **unverified against dist**. Amendment 5's rebuild-then-rerun remains the prerequisite that closes this.
- For files other than `checklist.ts`, "already present at 16:02" is my provenance basis; proving main itself derives those values would need a derivation at main's bytes, which I could not run.

## Recorded, outside this decision

`merged-seven-baseline.log` reports `BASELINE_CONVERGENCE_FAIL count=4` at final bytes. This proposal addresses only `identity-site-pins`. Untouched: `retired-authority-loader-provenance` (`cli-engine.ts:897`, unapproved non-literal dynamic load), `identity-inventory-pins` (retired token `lattice-evidence-timeout-` at `packages/main/src/tasks/validate-command-timeout-smoke.ts:297` — same identity-cutover family, active source path), and `b49d4-derived-guard-execution` (2 red rows). Also, main carries one commit not in HEAD (`05c5134492`, version bump); it touches CHANGELOG, package/lockfiles and `proof-or-stop-brand.ts`, none in `IDENTITY_CUTOVER_REQUIRED_PATHS`, so merging it will not re-stale these 15 values.
