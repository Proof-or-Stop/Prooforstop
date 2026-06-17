# Plan: B-f675 Incremental review context + round-2+ informed targeted re-review (gate unchanged)

> **Scope.** Read-only helper + `lattice review_incremental_context` CLI that gives a reviewer its prior
> verdict + the diff since its last-pass headHash + a scopeChanged flag; plus a round>=2 advisory in the
> REVIEW-entry output listing which reviewers' scope changed and noting the round-2+ gate only needs >=1
> valid receipt (so the operator can do informed targeted re-review). **HARD INVARIANT: do NOT change
> canPassReviewGuard / bindings / materialHash / staleness; the framework never skips a reviewer.** Decision
> Option 2 (merged). Reuse review-run headHash + evidence-freshness.changedFilesBetween. English-only.

## CHK-001: Read-only incremental-context + scopeChanged helper

**Owner**: lattice-implementer  **DependsOn**: none
**Files**:
- Create `packages/main/src/core/review-incremental-context.ts` (or extend `core/review-run.ts`): `export function reviewIncrementalContext(store, projectRoot, storyId, role): { role, priorVerdict, priorHeadHash, scopeChanged, changedFiles, isFirstPass }`.
- Resolve the reviewer's most recent prior verdict (review-passes.json / findings.json) + its bound headHash (review-run records). Compute changed material files between that headHash and HEAD via `core/evidence-freshness.ts changedFilesBetween` (rename-aware `--name-status -M`). `scopeChanged = changedFiles.length > 0`. No prior pass -> full `git diff main...HEAD`, `isFirstPass=true`, `scopeChanged=true`.
- Strictly read-only: no writes, no gate/store side effects.

**Verify**:
- Unit/smoke: returning reviewer -> prior verdict + since-last-pass changed files + scopeChanged; first-timer -> full diff + isFirstPass.
- `npm --prefix packages/main run build` clean; `lattice validate` green.

**DoneWhen**:
- Helper returns correct prior verdict + scopeChanged + changed files (rename-aware), reusing existing helpers, fully read-only.

## CHK-002: `lattice review_incremental_context` CLI + round>=2 REVIEW-entry advisory

**Owner**: lattice-implementer  **DependsOn**: CHK-001
**Files**:
- Register a read-only CLI `lattice review_incremental_context --storyId --role=<reviewer>` in `cli-engine.ts` that prints (English) the prior verdict, scopeChanged, and the incremental diff/changed-files.
- In `handlers/transition-effects.ts`, when entering REVIEW for round >= 2, append an advisory listing active reviewers whose scope changed since their last pass + the note that the round-2+ gate only needs >=1 valid current-round receipt, so the operator MAY re-run only the scope-changed reviewers (`lattice review_incremental_context --role=<name>`). Word it as an operator judgement; state the framework skips nobody. Append-only inside try/catch; must not change the transition result or touch canPassReviewGuard.

**Verify**:
- CLI prints the expected fields; round>=2 entry shows the scope-changed advisory; round 1 entry shows none.
- `lattice validate` green.

**DoneWhen**:
- CLI works read-only; round>=2 advisory present and round-1 absent; injection is append-only and never blocks.

## CHK-003: Tests + docs; assert canPassReviewGuard is UNCHANGED

**Owner**: lattice-implementer  **DependsOn**: CHK-002
**Files**:
- Smoke (`packages/main/src/tasks/*-smoke.ts`): (a) returning reviewer incremental context; (b) first-timer full diff; (c) a rename case counts as changed; (d) ASSERT gate-unchanged by exercising `canPassReviewGuard`: Round 1 blocks unless all opt-in reviewers have valid current-round verdicts + quorum; Round 2+ passes on >=1 valid current-round receipt; a current-round invalid binding blocks (all rounds) and a verified open blocking finding blocks -- identical with and without the helper. Wire the smoke into the validate/test chain.
- Update `CLAUDE.md` REVIEW section with the ACCURATE gate behavior (invalid-binding blocks all rounds; Round 1 = all opt-in + quorum; Round 2+ = >=1 valid receipt + no blocking finding) and the `review_incremental_context` CLI + round-2+ informed targeted re-review guidance.

**Verify**:
- `lattice validate` green with the smoke invoked; the gate-unchanged assertion passes.

**DoneWhen**:
- Smoke proves incremental context (returning + first-timer + rename) and that canPassReviewGuard is byte-identical in behavior with/without the helper; CLAUDE.md documents the real gate behavior + the guidance.
