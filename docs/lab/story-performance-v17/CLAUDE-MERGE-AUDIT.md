I have enough to render a verdict on the specified boundaries.

## Verdict: REQUEST_CHANGES

Scope limits, stated up front: this was read-only with `Read`/`Grep`/`Glob` only — no shell, no git. I could not diff `b715dd7b30` against `d66ffc6a7a`, recompute the TypeScript-printer digests behind the executable pins, or execute any test. Findings below are structural and evidenced from current file contents. This is not a full code audit and says nothing about Story performance as a whole.

---

### Blocker 1 — `certification_window_begin` never reaches the identity/executable-pin check

The mutating, receipt-consuming command is declared in two boundaries but enforces neither.

- `runtime-environment-checks.ts:468` — `certification-window` boundary lists `certification_window_begin` in `commands`.
- `runtime-environment-checks.ts:544` — `review-inventory-epoch` boundary also lists `certification_window_begin`.
- `runtime-environment-checks.ts:1367` — the CLI sweep skips any boundary without `preSideEffect`: `if (!boundary.preSideEffect || !boundary.commands.includes(input.command)) continue;`
- `runtime-environment-checks.ts:402` — `canonical-journal-authority` is the **only** boundary setting `preSideEffect: true`. Neither boundary above does.
- `cli-engine.ts:857` — the sole call site of `assertCanonicalActiveIdentityCommandConsumers`, so it covers nothing here.
- `handlers/certification-window.ts:696-697` — both `assertActiveIdentityConsumerContract` calls sit **only** in `certification_window_status`. `certification_window_begin` (`:588`) and `certification_window_cancel` (`:730`) have none.

Impact is precisely at the audited boundary. `begin` consumes the FINALIZED inventory receipt (`:580`, `:642`) and persists `ADMITTED` (`:675`), using `verifyReviewInventoryEpoch` / `verifyReviewInventoryReceipt` imported at `:3` and applied at `:554` — from `review-inventory-epoch.ts`, which is pinned at `runtime-environment-checks.ts:1225` for exactly this reason. The pins for `review-inventory-epoch.ts`, `verification-execution-evidence.ts` and `handlers/checklist.ts` are therefore verified only when someone later runs the read-only `status`. Tampered `dist` bytes can forge an admission first and be detected after the fact, if at all.

One nuance in fairness: `begin` calls `acceptanceCompletionBlocker` (`:591`), which reaches `assertCanonicalActiveIdentityBoundary({ boundaryId: 'canonical-journal-authority' })` (`acceptance-amendment-journal.ts:44`). That covers the journal boundary only — not the two at issue.

**Bounded repair:** add the two `assertActiveIdentityConsumerContract` calls at the top of `certification_window_begin`, before `withReviewInventoryMutationLock` (`:594`), mirroring `:696-697`; same for `cancel`. Prefer this over flipping `preSideEffect`, since the comment at `:1214-1216` states tests deliberately ablate the CLI preflight.

### Blocker 2 — preservation evidence does not cover the merge under audit

- `historical-table-binding.json:2` and `historical-table-preservation.json:2` both pin checkpoint `a7393908f9`.
- `INTEGRATION-LOG.md:7-8` records Lab checkpoint `a7393908f9` and **main merge input `33e7408c58`**.

Neither `d66ffc6a7a` nor `b715dd7b30` appears anywhere in `docs/lab/story-performance-v17`. The "verified byte-for-byte" claim at `INTEGRATION-LOG.md:53` is evidence for a *different* integration, so the preservation rule is currently unattested for this merge.

The rules themselves are coherent and were followed for what they cover: `binding.json:4` separates immutable historical values from separately-recorded post-main measurements, `preservation.json:3-7` asserts worktree/frozen-copy/digest equality over 24 rows, and the conflict inventory (`:13-38`) does not list `REPORT.md`, so the frozen table was likely untouched — but that is inference, not the recorded check.

**Bounded repair:** re-run the preservation check at current HEAD, append a new `INTEGRATION-LOG` entry naming `d66ffc6a7a` and `b715dd7b30`. Do not mutate the frozen `a7393908f9` binding.

---

### Boundaries that pass

**`verify-process-fact-contract.mjs` check ordering — satisfied.** `process.exit` occurs at exactly one place (`:11018`); the verdict block is `:11014-11019`; everything after is `console.log` (`:11021-11024`). The last check (`:11013`) precedes it, matching the `INTEGRATION-LOG.md:64` claim.

One non-blocking defect in the failure *mode*, not the order: `:11013` uses bare `execFileSync(..., stdio: 'inherit', timeout: 30000)`, which throws on non-zero exit or timeout, so the accumulated `failures` array is never rendered by `:11017`. Same shape at `:10883`. This still fails closed — an uncaught throw exits non-zero, so it cannot produce a false GREEN — it only loses diagnostics. Repair: wrap both in `try/catch` that calls `fail(...)`. (`read()` at `:959-962` already handles this correctly.)

**New declaration projection — sound.** `declareProcessFactMapping` (`process-fact-registry.ts:302-312`) defaults paths by kind, and `PROCESS_FACT_DECLARATION_PATHS_BY_KIND` (`:140-156`) is total over all 15 `ProcessFactKind` members. `projectProcessFactRegistry` (`:251-268`) enforces factId uniqueness and omits `generatedFrom`; `:233-246` enforces generated-path lineage both directions. The contract check at `:10883-10901` executes the real source and asserts totality (`projection === registry`), `generatedFrom` absence, P0m non-emptiness, and the typed `registry-component-mapping-unavailable` refusal.

**Lab rules — correctly fenced.** `PROCESS_FACT_LAB_MAINTENANCE` (`:2283-2291`) is scoped `consumerGate: 'Lab finish only; never Story REVIEW/TEST/DONE'` and closes with "These local records grant no formal Story or signed product-release credentials." It is spread into the registry at `:2435` like any other declaration — no special-casing in the projection path.

**Dynamic finding decisions — fail-closed.** `readDynamicFindingDecision` (`finding-applicability-projection.ts:58-90`) degrades every unverifiable input toward blocking: unverified assessment → `tampered` (`:71-72`), stale route → `receiptState: 'stale'` (`:77-79`), unverified deferral → `invalid` (`:81-82`), unverified mandatory repair → `required` (`:84-85`), and `killSwitch`/`observe` falls back to the legacy predicate (`:63-66`). The call site's `catch` (`handlers/certification-window.ts:427-429`) substitutes the `'<findings-unreadable>'` sentinel. `certification_window` is an authorized consumer per `PROCESS_FACT_DYNAMIC_FINDING_POLICY` (`process-fact-registry.ts:398`).

**Owned admission recovery — correct.** The `own` set (`handlers/certification-window.ts:567-568`) canonicalizes via `realpathSync(dirname)` to survive `/var`→`/private/var`, and the filter at `:573` uses `catch { return true }` — an unresolvable path stays counted as dirty. The `'<dirty-classifier-unreadable>'` sentinel (`:439`) survives the filter and refuses. Frozen-input equality at `:550` is exact, including `causalInputHashes`.

**git-tree-observation pin and the collection loop — no bypass found.** All five pinned paths (`:1222-1228`) are reachable from a registered boundary: `git-tree-observation.ts`, `evidence-freshness.ts`, `verification-execution-evidence.ts` via `:495-497`; `review-inventory-epoch.ts`, `handlers/checklist.ts` via `:546-548`. No dead pins. The three-stage loop (`:1294-1352`) closes its gaps: a path whose absolute was already cached under another `sourcePath` is recovered by the second loop (`:1343-1347`), a missing runtime identity-site file throws (`:1301`), and a missing pinned file throws at `readFileSync` (`:1346`). The pin is genuinely live — `packages/main/tests/validation-tree-delegate-binding.mjs:11-15` mutates `dist/core/git-tree-observation.js`, asserts the boundary throws, then restores and re-checks; it is wired from `verify-runtime-fact-contract.mjs:685`.

Two non-blocking notes: `identityBoundary` (`:362-371`) requires only "owned sites XOR one identity-free proof" — it does **not** require an identity-free path to carry an executable pin. `git-tree-observation.ts`'s evidence string (`:502`) claims its bytes "are independently pinned and mutation-tested", and that claim is true, but it is prose, not machine-checked; the other two identity-free paths (`:688`, `:754`) have no pin and no enforcement of their "type-only" claim. Also, the collection loop lacks the existence guard its sibling has at `:1299-1302`, so a missing pinned file surfaces as a raw `ENOENT` rather than a labelled refusal.

---

**Summary:** Blocker 1 is the one that matters — it leaves the audited pins unenforced on the only command in this boundary that mutates state and consumes authority, and the fix is a two-line addition matching an idiom already present in the same file. Blocker 2 is a cheap evidence refresh. Everything else in the specified scope holds.