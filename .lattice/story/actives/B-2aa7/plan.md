# Plan: B-2aa7 Validate the legacy v1 red-evidence artifact before enforce-gate evaluation

Decision: option **B — full validation at the read boundary, malformed entries quarantined** (see `decision.json`).
Spec: `docs/requirements/decisions/red-evidence-legacy-v1-record-validation-audit.md` (landed by CHK-008).

## Standing rules for every item

1. **Re-derive, never carry over.** Every existing-system claim must be re-checked against CURRENT `main`
   **by symbol, never by line number**. This story's inventory has been wrong twice and `main` moved
   mid-flight once. If a number in the checklist text disagrees with what you find, what you find wins —
   report the discrepancy rather than silently adjusting.
2. **Three defect classes, three different assertions.** This resolves INIT-007, which could not be fixed
   in the frozen checklist text and is therefore authoritative here:
   - **CRASH** — assert a bare `TypeError` escapes today.
   - **SILENT** — assert a *wrong observable value* AND explicitly assert **no throw**.
   - **UNTYPED-THROW** — the unparseable-file case *does* throw today (a raw `SyntaxError`). Assert that
     the escaping error is **raw and names nothing**. Its post-fix requirement is a **typed error naming
     the path** — *not* the absence of a throw. Do not fold this into SILENT.
3. **Quarantine means retain-and-report**, never drop. A "clean empty array" reads exactly like an absent
   artifact and would re-create the very defect this story exists to remove.
4. **Do not re-pin the invariance digest.** If it moves, the fix is wrong.

## CHK-008: Land the decision document

**Owner**: main-agent — structurally required: it must precede the PLAN scope review, which runs before DEV exists.
**DependsOn**: none — this is the root; every other item depends on it.
**Files**
- Create: `docs/requirements/decisions/red-evidence-legacy-v1-record-validation-audit.md`

**Verify**
- `git show 9583fb95aa2e5d3dda094dfc2341aa6d9e835722:docs/requirements/decisions/red-evidence-legacy-v1-record-validation-audit.md` resolves and matches the landed file's substance.
- The landed file's header does not contradict its own §0.0 about which tree the citations describe.

**DoneWhen**
- The file is committed in this story's diff and D-1…D-8 resolve for a reader with no access to this session.

**Status**: already complete — landed at `b8c458422e`, with the stale pre-merge header block corrected.

## CHK-001: Repro-first RED for all defect classes

**Owner**: lattice-implementer
**DependsOn**: CHK-008
**Files**
- Create: `packages/main/tests/red/red-b2aa7-artifact-validation.mjs`

**Verify**
- Runs on the pre-fix tree and **FAILS**. A RED artifact that passes before the fix proves nothing.
- Harness pattern: `packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs`. Drive
  `proofStoryDiagnosticInput` → `evaluateProofStoryDiagnostics`, never the predicate in isolation.

**DoneWhen** — all three classes present, each with its own assertion shape (standing rule 2):
- CRASH: `{id:'corrupt'}`; `observedFailure` null / `123`; an **array** record; malformed-first-then-satisfying; envelope `records` of `{}` and `42` and `"x"`.
- SILENT: JSON root `[]` / `"x"` / `null` / `42`; satisfying-first-then-malformed (row O2).
- UNTYPED-THROW: unparseable file → raw `SyntaxError` escapes.
- Rows B-506e already closed (record `null` / a string) are **absent**, so nothing passes vacuously.

## CHK-002: Pin the pre-fix invariance baseline

**Owner**: lattice-implementer
**DependsOn**: CHK-008
**Files**
- Modify: none (recording only)

**Verify**
- `node packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs` on the pre-fix tree prints
  `2d584cc157e83ebb2f8396735f04d46946f0ba90d18a55d9fb2f263d706a11ec` and exits 0.

**DoneWhen**
- The passing run is recorded as `verificationEvidence` naming the exact commit it was taken at.
- The pinned constant is **not edited**. `71c267a0…` appears nowhere as a pinned value.

## CHK-003: Migration scan

**Owner**: lattice-implementer
**DependsOn**: CHK-008
**Files**
- Create: a committed, re-runnable scan under `packages/main/tests/red/` or `scripts/`

**Verify**
- Enumerates every reachable `red-evidence.json`; for each record reports *(current verdict, verdict under full v1 validation)*.
- Prints a concrete count even when zero.

**DoneWhen**
- Output states `scanned N artifacts / M records, K affected`. Silence is not evidence.
- The affected set is empty, **or** every entry is individually justified in the story record.
- **Not** hard-coded to the PLAN-phase snapshot (105 artifacts / 144 records / 0 affected). That snapshot
  is one machine at one moment; parallel sessions create stories continuously, so it must be re-run at merge time.

## CHK-004: Read-boundary validation with quarantine

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**
- Modify: `packages/main/src/core/store.ts`, `packages/main/src/core/types.ts`
- Create: a validation leaf (do **not** touch `packages/main/src/core/red-evidence/` — execution boundary blocks it; that leaf is B-506e's)

**Verify**
- Envelope is validated **before** records, so a bad envelope never reaches record-level code.
- `lattice validate --lint` passes.

**DoneWhen**
- E5: a non-object root is rejected, **not** read as absent evidence.
- E6: a missing/unknown **file-level** `schemaVersion` does not degrade to `v1` (precedence rule D-1).
- E7: an unparseable file yields a **typed** error naming the path (standing rule 2 — a throw, just a typed one).
- An **array** record and a prototype-inherited `observedFailure` are both rejected.
- Malformed entries are retained and reported with index, identifying field and reason.
- An envelope fault is **never** reported as a record fault.
- A well-formed artifact loads unchanged.

## CHK-005: Keep the predicate total

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**
- Modify: `packages/main/src/core/proofstory.ts`

**Verify**
- Inject a malformed record **directly** into the diagnostic input, bypassing the read boundary: the predicate returns a verdict and does not throw.
- Diff the predicate: only the shape guard is added.

**DoneWhen**
- `redEvidenceRecordSatisfied` never throws on arbitrary input.
- The other per-record checks at the existing truthiness/short-circuit block are **unchanged** — `observedFailure` was verified to be the only unguarded dereference; do not widen this into a rewrite.

## CHK-006: Consumer behaviour

**Owner**: lattice-implementer
**DependsOn**: CHK-004
**Files**
- Modify: `packages/main/src/handlers/proofstory.ts`, `packages/main/src/handlers/red-evidence.ts`, `packages/main/src/handlers/story-review.ts`

**Verify**
- **Re-derive the call-site list by symbol first.** The count was 7, then 10; treat any number in the checklist as unverified.
- Exercise `red_evidence_get` and `red_evidence_add` against a store carrying a malformed artifact.

**DoneWhen**
- `red_evidence_get` **displays** the corruption instead of aborting.
- `red_evidence_add` repairs by appending, or refuses with an actionable message — never leaves the artifact unrepairable through the CLI.
- The `story_review` advisory path does not let corruption read as "feature not configured".
- Every consumer found by the fresh sweep renders corruption **distinctly from absence**.

## CHK-009: Order independence

**Owner**: lattice-implementer
**DependsOn**: CHK-004
**Files**
- Modify: `packages/main/tests/red/red-b2aa7-artifact-validation.mjs`

**Verify**
- Pre-fix: satisfying-first-then-malformed returns SATISFIED with no throw — pin this first so the post-fix assertion is not vacuous.

**DoneWhen**
- The same record set produces the same verdict regardless of the malformed entry's position.
- A malformed entry is reported even when a satisfying record precedes it.

## CHK-007: Post-fix invariance + registration

**Owner**: lattice-implementer
**DependsOn**: CHK-004, CHK-005, CHK-006, CHK-009
**Files**
- Modify: `lattice.config.json`

**Verify**
- `node packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs` passes with the **same** digest as CHK-002.
- `lattice validate` runs the new tests.

**DoneWhen**
- Digest unchanged. **If it moved, the fix is wrong — do not re-pin the constant.**
- Blank `observedFailure` still yields UNSATISFIED with **no new diagnostic** and is never quarantined (D-5), so scenario 3's report shape is untouched.
- New tests registered in `lattice.config.json` `validate.commands` beside the existing red-evidence smokes.

## Dependency graph (acyclic)

```
CHK-008 (done)
   ├── CHK-001 ──┬── CHK-005 ─────────────┐
   │             └── CHK-004 ──┬── CHK-006 ┤
   ├── CHK-002 ────────────────┤          ├── CHK-007
   │                           └── CHK-009 ┘
   └── CHK-003 (independent)
```

## Parallelism

- CHK-001, CHK-002, CHK-003 may run **in parallel** — disjoint write sets, no shared dependency beyond CHK-008.
- CHK-004 and CHK-005 both follow CHK-001 but touch **different** files (`store.ts` vs `proofstory.ts`), so they may run in parallel.
- CHK-006 and CHK-009 both follow CHK-004 and touch different files, so they may run in parallel.
- CHK-007 is last: it must observe the finished state.
