# Integration Audit

**Pin update: APPROVE** · **English translation: REQUEST_CHANGES** · **Overall: REQUEST_CHANGES**

*Process note:* to compute digests I had to write a temp script inside `packages/main/` (the `typescript` import won't resolve from `/tmp`). It was deleted immediately; tracked-file status is unchanged (25 entries, same as at start). No repo file was modified.

## 1. Source delta

`git diff aff3bdd335..origin/main -- packages/main/src/handlers/checklist.ts` is **+9 / −0** — purely additive, inside the existing verification-intent branch (`checklist.ts:2863`):

```js
for (const lane of VERIFICATION_LANES) {
  for (const [index, intent] of (args.verificationIntent[lane] ?? []).entries()) {
    if (!intent.scope || !intent.expectation || !intent.requirementSource) {
      throw new Error(`... [verification_intent_metadata_required]`);
```

No guard removed. The adjacent pre-existing `agent_dispatch_mutation_scope_denied` check is intact and still runs first. The new check adds a refusal path only, so **authority is strengthened, not preserved-at-best**.

## 2. Pin correctness

I verified what the pin actually covers before judging the value. `ACTIVE_IDENTITY_EXECUTABLE_SOURCE_BINDINGS` (`runtime-environment-checks.ts:1227`) is **keyed by source path but digests the compiled artifact**: `runtimeSource()` (`:338`) rewrites `packages/main/src/handlers/checklist.ts` → `dist/handlers/checklist.js`, which `assertIdentityExecutableSource` parses as `ScriptKind.JS` and re-prints with `removeComments`.

Recomputing with that exact algorithm against the built merged tree:

```
00dfd8fbebc27595977addead2dddfa73ced758db86210da32166d96f059cc15  dist/handlers/checklist.js
```

Matches the proposed value. `dist/` is untracked, so this reflects the local build; I confirmed the guard is present in both src (1×) and dist (1×), and that worktree src is byte-identical to `origin/main`.

**Only that pin needs updating.** One caveat worth recording: `aff3bdd335..origin/main` also shows changes to `evidence-freshness.ts` (±150), `git-tree-observation.ts` (−33) and `review-inventory-epoch.ts` (−34), which looks like three more pins at risk. It isn't — that diff is *not* the merge result. Diffing the actual merge against the Lab base shows **only `checklist.ts` changed (+9/−0)**; the Lab side was retained for those three. I confirmed independently by recomputing all four other digests — every one still equals its pinned value.

Separately-enforced identity-site counts in the built file are unaffected: bundle.v5 8/8, product-reviewer 1/1, review-story-init 1/1, execution-receipt.v3 4/4.

## 3. Translation — one limitation dropped

All 24 rows map 1:1 (v17 `REPORT.md:7-30` → v18 `RELEASE-NOTES.md:11-34`). Every decimal measurement is carried over, and critically the **unfavourable outcomes survive**: short task `0.674→1.935 slower`; long task `3.775→3.954, no universal speedup`; V15 `2.892→3.559, correctness improvement, not speedup`; V16 four phases `2.506→2.507, effectively flat`; warm reuse "remained expensive"; V16 smoke framed as "fixture repair, not a performance benefit". Non-additivity and the serial/parallel caveat on 16.719→11.572 are preserved. No CJK remains; v17 `REPORT.md` is untouched.

The blocking defect is in the limitations table. v17 has **six** open items; v18 has **six** — but they are not the same six. v18 *adds* "Formal completion" and **silently drops** v17 `REPORT.md:36`:

> `validation-evidence-reuse-smoke旧断言 | V16前后同处失败：拒绝发布exit1、夹具期待exit0；合并后重新定位并跑完整后续分支`

This is the most consequential item to lose: it discloses a **known-failing assertion** (failing identically before *and* after V16 — refusal returns exit 1, fixture expects exit 0) and carries an **outstanding post-merge obligation** to relocate the fixture and run the full downstream branch. Dropping it converts a disclosed failing test into an undisclosed one, exactly the kind of erosion the "preserve limitations" rule exists to prevent. The equal row count masks the removal.

`translation-check.json` does not catch this: its 24 entries assert only `decimalMeasurementsPreserved`, and it self-declares `"integerCountsAndLimitations": "Independent translation review pending"` — so limitations coverage was never checked.

**Required:** restore the `validation-evidence-reuse-smoke` row to v18 "Remaining limitations" (retaining the exit-1/exit-0 mismatch and the run-the-full-downstream-branch obligation), keeping "Formal completion" as a genuine addition.

## Scope

I did not run the test suite or any integration validation, and make no claim that integration tests passed. Pan Qi validation is explicitly pending per `RELEASE-NOTES.md:47` — consistent with the ask. The pin approval is on delta-and-digest grounds only, and assumes the pin is re-verified against a clean rebuild at release time, since `dist/` is untracked. The unresolved `UU CHANGELOG.md` merge conflict in the worktree is outside this audit's scope but must be resolved before commit.