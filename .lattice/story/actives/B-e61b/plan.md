# B-e61b Execution Plan

## Goal

Separate Koala gate oracles from status renderers so user-facing status, session_brief, and next-step guidance render shared gate artifacts instead of duplicating phase-specific rule knowledge.

## Guardrails

- Keep gate decisions in checker/oracle helpers; renderers only format structured rows.
- Preserve the existing DONE gate behavior and readable story_advance output.
- Avoid a broad state-machine rewrite in this story.
- Validate through user-visible smoke coverage and koala validate.

## CHK-001 Define a shared oracle row contract for gate/status artifacts

Intent: Give DONE pre-check rows stable semantics beyond label text. The renderer should be able to rely on fields such as id, status, detail, hint, source, and blocking.

Implementation steps:

1. Introduce or formalize a light GateCheckRow-compatible contract around the existing DONE pre-check rows.
2. Populate stable ids for current DONE rows: test evidence, evidence freshness, bugs, git dirty, branch sync, related docs, delivery check, evaluator, summary, Codex evidence.
3. Keep renderDoneChecklist compatible with current output so story_advance remains readable.
4. Use row hint/action semantics rather than label matching where status needs next-step wording.

Verification:

- Smoke or unit assertion proves delivery-check/summary/git rows expose hints consumed by status.
- Existing DONE gate output still lists the same blocking checks.

Rollback:

- The contract is additive. If trouble appears, keep the old fields and stop consuming new ids while preserving buildDoneChecklist behavior.

## CHK-002 Refactor status and next renderers to consume oracle outputs only

Intent: Remove duplicated status knowledge that caused misleading TEST next-step and reviewer display drift.

Implementation steps:

1. Audit session_brief/status/next code paths that infer gate status from phase or label strings.
2. Make TEST next-step derive from failed DONE oracle rows and their hints.
3. Ensure reviewer status paths share computeActiveReviewers behavior, including docs reviewer git fallback.
4. Thread projectRoot into artifact/reviewer summary paths that need git-derived reviewer fallback.
5. Keep anti-stall text scoped to actual blockers, not stale historical conditions.

Verification:

- TEST status with missing delivery check and summary names both missing artifacts.
- Docs touchpoints require docs reviewer consistently in status and artifact contracts.
- Resolved findings do not continue to render unresolved blocker text.

Rollback:

- Revert renderer consumption changes while retaining the row contract if needed; gate behavior remains unchanged.

## CHK-003 Add regression coverage for renderer and gate consistency

Intent: Encode the user-visible failure modes that triggered this story so future changes cannot silently reintroduce optimistic status text.

Implementation steps:

1. Extend flow-stability smoke coverage for TEST stories with dirty tree, missing delivery-check, and missing summary.
2. Assert next-step guidance includes concrete remediation commands or row hints, not only commit-then-DONE wording.
3. Cover docs reviewer fallback consistency for status/artifact contract paths.
4. Cover resolved finding anti-stall behavior.
5. Run build, flow-stability smoke, and koala validate.

Verification:

- npm run build passes.
- npm --prefix packages/main run test:flow-stability-smoke passes.
- koala validate --json passes and shows the real validation command.

Rollback:

- Keep tests focused on user-visible strings; if one assertion is too brittle, relax it to check the shared row id/hint rather than exact prose.
