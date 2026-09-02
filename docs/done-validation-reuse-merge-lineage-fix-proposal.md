# Proposal: Fix redundant DONE-validation re-runs caused by merge-commit lineage over-trigger

Status: rev 2 — audited by Claude CLI + Agy CLI (both SOUND-WITH-CHANGES); findings folded in (see §11). Ready for an implementation story.
Date: 2026-07-26
Author: main session (Claude), grounded in the B-3783 DONE run
Scope (rev 2, corrected by audit H1): the shared merge-lineage classifier used by BOTH
`packages/main/src/core/validation-evidence-reuse.ts` (`classifyTrustedValidationLineage`) AND
`packages/main/src/core/validation-evidence-admissibility.ts` (`validationHeadLineage`)

---

## 1. Problem (observed, not hypothetical)

During B-3783's TEST→DONE convergence the full `build + root npm test` DONE-required validation
(~17 min) ran **3–4 times** against the **same material**. One of those re-runs was forced by
`done_prepare` **refusing to reuse a validation it had just produced**, even though the identity
digest was byte-identical:

```
routine validation reuse refused:
  refusalReasons=untrusted-lineage-path:proof-or-stop.config.json,
                 untrusted-lineage-path:packages/main/src/tasks/command-catalog-smoke.ts
  priorIdentityDigest=a21a13de5f7152075bef00150480b0189a07fcb97690b0f85fdb9f3a0dbfc7fe
  currentIdentityDigest=a21a13de5f7152075bef00150480b0189a07fcb97690b0f85fdb9f3a0dbfc7fe   ← SAME
```

The prior validation was a genuine executed PASS at exactly this material. Re-running produced
an identical PASS. That re-run was pure waste (~17 min).

## 2. Root cause (code-level, verified)

`evaluateRoutineValidationReuse` (`validation-evidence-reuse.ts:293`) is a careful **9-factor**
gate. It is NOT the problem and must not be weakened. It already requires, all together:

1. a genuine executed command receipt — `isReusableCommandPass` (`:232`) checks
   `schema/version/status=PASS/complete=true/commandCount==expected/requiredFailureCount==0/…`;
2. prior overall result PASS;
3. `routineValidationIdentity.digest === currentIdentity.digest`;
4. current verification coverage complete;
5. worktree clean;
6. `materialHash` matches;
7. `storyFilesHash` matches;
8. **trusted lineage** — `classifyTrustedValidationLineage` (`:251`);
9. head stable during evaluation (`headAfter === headBefore`).

The defect is isolated to factor **#8**. `classifyTrustedValidationLineage` computes the set of
files changed between `evidenceHead` and `currentHead` as the **union of per-commit
`git diff-tree -m` outputs** (`:270-274`), then rejects reuse if any changed path is not a story
metadata path (`:275-277`, `isStoryMetadataPath` from `evidence-freshness.ts:143`).

`git diff-tree -m` expands a **merge commit into a diff against *each* parent**. When
`main` is merged into the story branch (a normal DONE-prep step), the merge commit's diff **against
the main parent** lists the story's OWN files because they **differ from the main parent** (absent OR
modified — e.g. `proof-or-stop.config.json` exists on `main` with different content; audit L5). So the
story's already-validated code/config files surface as `untrusted-lineage-path:*` — even though their
blob content is identical at `evidenceHead` and `currentHead` (verified: parent1→merge blob IDs
identical for both files). NOTE (audit L4): factor #2 also admits a prior FAIL whose only failure is
coverage-incomplete (`priorCoverageOnlyFailure`, `:309-315`), so the negative tests must not assume
"prior result must be literally PASS".

Verified on the real B-3783 merge commit `2140375ac7`:

```
$ git diff-tree --no-commit-id --name-only -r -m 2140375ac7 | grep -E 'command-catalog-smoke|proof-or-stop.config'
proof-or-stop.config.json
packages/main/src/tasks/command-catalog-smoke.ts
```

So: **a main-merge between the validation and the reuse check makes the story's own unchanged files
look like untrusted lineage changes, forcing a full re-validation.** Because factors #6/#7/#3 already
proved the validated content is byte-identical, factor #8's rejection here is a false positive.

## 3. Blast radius  — CORRECTED in rev 2 (audit Finding H1)

`classifyTrustedValidationLineage` / `evaluateRoutineValidationReuse` callers:

- `core/done-prepare-validation-reuse.ts:123` (done_prepare reuse gate)
- `handlers/verifier.ts:606` (routine validation reuse evaluation)

**The rev-1 claim "nothing else depends on the lineage classifier" was FALSE.** There is a
**byte-equivalent second copy** of the per-commit `-m` union logic:

- `core/validation-evidence-admissibility.ts:42-73` `validationHeadLineage` (identical
  `diff-tree --root --no-commit-id --name-only --no-renames -r -m` union at `:58-63`, same
  `isStoryMetadataPath` filter → `code:'lineage_untrusted'`).
- Consumed by `assessStoredValidationPassAdmissibility` → gates the DEV→TEST validate-skip
  (`phase-gates.ts`) **and hard-throws** in `autopilot_review_submit --deriveBindings`
  (`handlers/verdict.ts:139-141`: `throw ... requires canonical current PASS validation evidence`).

So in the exact hot-main closeout window this proposal targets, the quorum-floor submission
(`autopilot_review_submit --deriveBindings`) **also** fails the same false positive. **The fix MUST
cover both copies.** Recommended: extract one shared `netDiffChangedPaths(evidenceHead, currentHead)`
helper and one shared lineage classifier, used by both `validation-evidence-reuse.ts` and
`validation-evidence-admissibility.ts`, so the two can never diverge again.

## 4. Proposed fix — REVISED in rev 2 (audit Findings A1/H1/M2/M3)

Extract one shared helper and use it in **both** copies (§3). Replace the per-commit `diff-tree -m`
UNION with a **net endpoint diff**, hardened per the audit:

```ts
// Shared helper (new): files whose CONTENT differs between the two endpoint trees.
// - net endpoint diff (no -m) → a merge that re-touches an unchanged file does NOT list it
// - -z + NUL split → pathnames with spaces/non-ASCII are not git-quoted (audit A2/Agy)
// - explicit large maxBuffer → mirrors GIT_EXEC_OPTS; large main-syncs won't ENOBUFS (audit M3)
function netDiffChangedPaths(evidenceHead: string, currentHead: string, gitCwd: string): string[] {
  const out = execFileSync('git',
    ['diff-tree', '-r', '--no-commit-id', '--name-only', '--no-renames', '-z', evidenceHead, currentHead],
    { cwd: gitCwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  return out.split('\0').map(s => s.trim()).filter(Boolean);
}
```

Then in BOTH `classifyTrustedValidationLineage` (`validation-evidence-reuse.ts:251`) AND
`validationHeadLineage` (`validation-evidence-admissibility.ts:42`):

- keep the `evidenceHead === currentHead` fast-path and the `merge-base --is-ancestor` gate;
- compute `changed = netDiffChangedPaths(...)`;
- **empty net diff ⇒ TRUSTED, not rejected** (audit M2, both hosts). With the net diff, an empty
  `changed` means the endpoint trees are byte-identical — strictly safer than a metadata-only change,
  so it must return `trusted-*`, NOT `empty-descendant-lineage`/`lineage_empty` rejected. **Remove
  the `changed.length === 0 → rejected` push** (`validation-evidence-reuse.ts:276`,
  `validation-evidence-admissibility.ts:64`) and return trusted instead;
- keep `untrusted = changed.filter(p => !isStoryMetadataPath(p, root))` → any genuinely
  content-changed non-metadata path still rejects reuse.

**Split the catch** (audit M3): the current single `catch` (`validation-evidence-reuse.ts:281-283`)
mislabels a diff/`ENOBUFS` failure as `evidence-head-is-not-current-ancestor`. Wrap only the
`merge-base --is-ancestor` in the ancestry catch; let a `netDiffChangedPaths` failure surface a
distinct `lineage-diff-failed` reason (still fail-closed → refuse, but not silently mislabeled).

## 5. Why this is safe (security argument)

The threat this gate defends against: **reusing a validation after the code/config it validated (or
that determines what it validates) changed** — e.g. a story that edits `proof-or-stop.config.json`'s
`validate.commands` to drop tests, then reuses an old PASS. That threat is real and this proposal
does **not** relax it:

- **Content identity is the invariant.** The net diff flags a path iff its blob differs between the
  validated head and the current head. If it does not differ, the file the validation ran against is
  byte-identical to the current file — the validation's verdict is still exactly correct for it.
- **Genuinely-changed non-material files are still caught.** The lineage check's unique value over
  factors #6/#7 is catching files *outside* the story's material/diff set (e.g. a shared helper that
  landed on `main`). If such a file changed content between the endpoints, the net diff reports it →
  still `untrusted` → reuse still refused. Only merge-artifact (identical-content) paths are dropped.
- **The genuine-receipt gate is untouched.** `isReusableCommandPass` still requires a real executed
  PASS receipt; this is not a `refresh_stale`-style laundering path (see §7).
- **No fail-open.** On any git error the classifier still returns `rejected`
  (`evidence-head-is-not-current-ancestor`), same as today.

Net: the change removes a **false positive** (merge re-touch of unchanged files) without removing any
**true positive** (genuine content change).

## 6. Risk / new-bug analysis

| Risk | Assessment |
|---|---|
| A transient change→revert within the range that mattered | Validation validates the snapshot at `evidenceHead`; if `currentHead` content equals it, the verdict holds regardless of intermediate churn. Net diff is the correct semantic. |
| Merge-conflict resolution altered a file | If resolution changed final content vs `evidenceHead`, net diff reports it → still refused. Correct. |
| Rename / delete of a lineage file | `--no-renames` keeps behavior identical to today; deletes surface as changed paths → refused. No regression. |
| Reuse of a *non-executed* (laundered) validation | Out of scope of factor #8; still blocked by `isReusableCommandPass` (#1) and `material/storyFilesHash` (#6/#7). Unchanged. |
| Someone edits `validate.commands` then reuses | `proof-or-stop.config.json` blob differs → net diff reports it → refused. The exact threat still blocked. |
| Interaction with B-3b88 (evidence-integrity Step 1) | B-3b88 touches `refresh_stale` laundering + evidence-row contradiction (`core/verification.ts`, `checklist.ts`), different files. No code overlap. This proposal does not re-open any laundering vector B-3b88 closes. |
| Interaction with the B-914f validation-reuse envelope | This IS that envelope; we refine one factor and keep the other eight. |

## 7. Explicitly NOT proposed here

- **Not** relaxing `refresh_stale` for command-backed evidence (that is B-3b88's domain and stays
  strict).
- **Not** reducing how many rounds/hosts the review assurance floor needs — B-3783 used 3×1 local
  host rounds and they cost seconds; they are not the bottleneck.
- **Not** the build-step 290s timeout that produced a partial `dist`. That was **operational
  contention** (three heavy validations sharing the machine), not this policy. Separate, optional
  follow-up: serialize DONE-required validation vs other heavy jobs, and/or make the timeout
  incremental-build-aware. Flagged, not bundled.

## 8. Test plan (RED-first)

New smoke `tasks/validation-reuse-merge-lineage-smoke.ts` (pattern per `evidence-refresh-smoke.ts`:
mkdtemp + git init + seed):

1. Seed story; commit story code file `foo.ts`; produce a genuine PASS `test-evidence.json` receipt
   at head `H1` (identity digest `D`, materialHash `M`, storyFilesHash `S`).
2. Create a `main` branch lacking `foo.ts`; merge it into the story branch → merge commit → head `H2`.
   Assert `H2` leaves `foo.ts` blob, `M`, `S`, and identity `D` unchanged.
3. **RED (today):** `evaluateRoutineValidationReuse(...)` at `H2` returns `reusable:false` with
   `untrusted-lineage-path:foo.ts`.
4. **GREEN (after fix):** returns `reusable:true`, `lineage:'trusted-story-metadata-descendant'` (or a
   new `trusted-no-content-change`).
5. **NEGATIVE (protection preserved):** additionally change `foo.ts` content on `main` before merge so
   its blob differs at `H2` → reuse STILL `false` with `untrusted-lineage-path:foo.ts`.
6. **NEGATIVE:** change a non-material shared file `shared/helper.ts` on `main` → reuse STILL `false`.

## 9. Open questions for auditors

1. Was the **per-commit `diff-tree -m` union** deliberate (e.g. to catch a change→revert that some
   downstream cares about), or incidental? If deliberate, what property breaks under the net-diff?
2. Is there any consumer that relies on the *lineage reason strings* naming every touched path
   (audit/forensics), such that switching to net-diff loses a signal they want? (grep suggests no.)
3. Should the fix instead **keep** the per-commit `changed` set for reporting but **filter** it by
   `git diff --quiet evidenceHead currentHead -- <path>` before deciding `untrusted`? (Equivalent
   result, preserves per-path provenance in logs. Slightly more git calls.)
4. Does `handlers/verifier.ts:606` pass `headBefore/headAfter` such that factor #9
   (`head-changed-during-reuse-evaluation`) would independently refuse in the merge scenario anyway?
   **Empirical data point:** the observed B-3783 refusal listed *only* the two
   `untrusted-lineage-path:*` reasons — factor #9 did **not** fire — so for that case the lineage fix
   is sufficient. Still, auditors should confirm #9 cannot fire in the general hot-main path (evidence
   is captured at `H1`, then metadata commits + merge advance the head to `H2` before the reuse check;
   if `headBefore` is re-read at `H2` each call, #9 stays satisfied). If #9 *can* fire, the fix must
   also address it or the redundancy persists.
5. Confirm `done-prepare-validation-reuse.ts` uses the same corrected classifier (it imports
   `classifyTrustedValidationLineage` directly at `:123`, so one fix covers both — verify no second
   copy of the union logic exists).

## 10. Expected impact

Eliminates redundant ~17 min full-suite re-runs per DONE convergence that includes a main-merge
(the common hot-main case) — **both** the `done_prepare`/reuse path AND the
`autopilot_review_submit --deriveBindings` admissibility path (§3) — with **zero change** to what a
genuinely-changed tree validates. Does not touch the review assurance floor, the ProofStory gates, or
the evidence-integrity laundering guards.

---

## 11. Cross-host audit results (2026-07-26)

Two independent adversarial audits of rev 1, each verifying claims against source (not prose):

- **Claude CLI (2.1.220)** — VERDICT: SOUND-WITH-CHANGES
- **Agy CLI (antigravity 1.1.7)** — VERDICT: SOUND-WITH-CHANGES

**Both confirmed:** root-cause diagnosis correct (Claude verified parent1→merge blob IDs identical);
net-diff fix preserves the security property with no attack vector (Claude tried a `-s ours` evil
merge → empty net diff → fail-closed reject; genuine evil merges differ at endpoints → caught);
factor #9 (`head-changed-during-reuse-evaluation`) is an intra-evaluation TOCTOU guard (H2 vs H2) and
does **not** fire on hot-main merges, so the lineage fix is sufficient on that axis. Resolves rev-1
open questions §9 #1 (per-commit `-m` was needed because plain `diff-tree <merge>` prints nothing —
net diff preserves evil-merge detection) and #4.

**Findings folded into rev 2:**

| ID | Sev | Host | Finding | Resolution (rev 2) |
|---|---|---|---|---|
| H1 | high | Claude | Second byte-equivalent `-m` union copy `validation-evidence-admissibility.ts:42-73` gates `autopilot_review_submit --deriveBindings` (hard-throw, `verdict.ts:139`) — fixing one copy is insufficient | §3/§4: shared helper + fix **both** copies |
| M2 | med | both | `empty-descendant-lineage`/`lineage_empty` rejects a zero-net-diff range; rev-1 §4 wrongly called it "trusted" | §4: empty net diff ⇒ **trusted** (remove the `length===0→rejected` push), + test |
| M3 | med | Claude | proposed `execFileSync` has no `maxBuffer`; large main-sync diff → ENOBUFS swallowed by catch, mislabeled ancestry failure → silent re-run (precedent: `evidence-freshness.ts:121-135` B-f492) | §4: explicit large `maxBuffer` + split the catch |
| A2 | low-med | Agy | `--name-only` without `-z` git-quotes spaced/non-ASCII paths → `isStoryMetadataPath` mis-match | §4: `-z` + NUL split |
| L4 | low | Claude | §2 factor list omitted `priorCoverageOnlyFailure` (prior coverage-only FAIL admitted) | §2 note added |
| L5 | low | Claude | §2 wording "absent from main" → should be "differ from main parent" | §2 corrected |

**No finding refuted the core approach.** The audit expanded scope from 1 file to 2 (+ shared helper)
and added three robustness requirements (empty-tree-trust, maxBuffer, `-z`). Recommended next step: an
implementation story (Red-first per §8, now including the admissibility-copy/autopilot path and the
empty-net-diff and large-diff cases).
