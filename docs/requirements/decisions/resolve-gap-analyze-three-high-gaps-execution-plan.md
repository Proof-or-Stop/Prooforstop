# Resolve gap_analyze Three High Gaps Execution Plan

> Status: execution plan
> Story: B-ebc5
> Source command: `lattice gap_analyze`
> Boundary: this document does not close the gaps, unlock Layer 2, unlock Layer
> 4, set `productionDone`, set `receiptVerified`, or complete Authority work.

## 1. Purpose

This document gives the exact execution path for clearing the current
`gap_analyze` result:

```text
Gaps: 3 high / 0 medium
```

It exists to answer one product question: if these three high gaps are handled,
what remains and how do we avoid creating three new gaps while fixing them?

## 2. Current High Gaps

| ID | Source | Current analyzer text | Classification |
|---|---|---|---|
| GAP-SW-UNRESOLVED-1 | `decisions/review-run-start-signed-workspace-resolution-execution-plan.md:262` | `requires_git_signed_workspace_but_metadata_root_is_not_git_and_no_worktree_or_gitRoot_is_configured` | Signed workspace implementation or binding coverage gap. |
| GAP-SW-NO-BINDING-1 | `decisions/review-run-start-signed-workspace-resolution-execution-plan.md:311` | `Reason [requires_git_signed_workspace_but_no_binding]:` | Signed workspace diagnostic text and binding coverage gap. |
| GAP-L4-CUSTOMER-KEY-1 | `decisions/unlock-layer4-production-safety-suite.md:267` | `customerKeyRef` must be redacted and non-secret | Future Layer 4 Production Safety scope unless a Layer 4 implementation story is opened. |

The first two gaps belong together. They should be handled by one
signed-workspace implementation story because they share the same resolver,
diagnostic, and REVIEW artifact binding surface.

The third gap should not be mixed into that story. It belongs either to a
future Layer 4 implementation story or to a requirements wording adjustment
that keeps `customerKeyRef` explicitly future/blocked.

## 3. Required Work Split

| Workstream | Story type | Scope | Expected result |
|---|---|---|---|
| Signed workspace closure | implementation story | Bind the two signed-workspace gap strings to source, tests, and REVIEW behavior. | The two signed-workspace high gaps disappear from `gap_analyze`. |
| Layer 4 customer key boundary | decision or Layer 4 implementation story | Keep `customerKeyRef` future/blocked, or implement the full redaction and receipt evidence path in Layer 4. | The customerKeyRef high gap disappears without claiming false current support. |

Do not combine the workstreams unless the user explicitly opens a broader
Layer 4 implementation story. Combining them now would create unnecessary
Authority scope and raise the risk of false production-safety claims.

## 4. Story A: Signed Workspace Closure

### 4.1 Goal

Clear both signed-workspace gaps by proving that the documented failure reasons
are either implemented or correctly covered by code/test annotations.

### 4.2 Candidate Code Anchors

The implementation story should inspect these current anchors first:

| Area | Candidate files |
|---|---|
| Workspace resolution | `packages/main/src/handlers/context.ts`, `packages/main/src/handlers/story-resolve.ts` |
| REVIEW run signing | `packages/main/src/handlers/review-run.ts` |
| Regression coverage | `packages/main/src/tasks/field-regression-cli-smoke.ts` |
| Dispatch and reviewer guidance | `packages/main/src/handlers/story-dispatch.ts`, `packages/main/src/handlers/session.ts` |

These are starting anchors, not a permission slip to refactor. The
implementation story should confirm actual call flow before editing.

### 4.3 Minimum Closure Criteria

The signed-workspace story is complete only when all of these are true:

1. `story_resolve` distinguishes `metadataRoot`, `signedWorkspaceRoot`,
   `repoRoot`, and unresolved reason for a non-git wrapper root.
2. `review_run_start` fails closed before creating a reviewer run when no
   git-backed signed workspace can be resolved.
3. The failure output exposes the same semantic reason family as the source
   anchors listed in Section 2, without duplicating those literal labels as a
   new current requirement in this planning document.
4. REVIEW artifact binding records the signed workspace that produced
   `headHash`, `materialHash`, scope diff, and review scope binding.
5. A regression test covers the non-git metadata root with no worktree or
   configured `gitRoot`.
6. `lattice gap_analyze` no longer reports the two signed-workspace high gaps.

### 4.4 Verification Commands

The future implementation story should use commands shaped like:

```bash
lattice session_brief
lattice gap_analyze
npm --prefix packages/main run build
npm --prefix packages/main run test:field-regression
node packages/main/dist/tasks/field-regression-cli-smoke.js
lattice validate --story=<storyId>
lattice gap_analyze
```

If the package has no dedicated `test:field-regression` script at that time,
use the existing repository test entry that executes
`field-regression-cli-smoke.ts` or its built JavaScript equivalent. Do not add a
new test runner solely to make the command name look tidy.

### 4.5 Stop Conditions

Stop and return to PLAN if any of these occurs:

- the fix requires changing the signed review artifact schema;
- `review_run_start` can create a reviewer run without a valid git-backed
  `signedWorkspaceRoot`;
- the implementation makes wrapper-root diagnostics prettier but does not bind
  `headHash` and `materialHash` to the same signed workspace;
- tests pass locally but `gap_analyze` still reports either signed-workspace
  high gap.

## 5. Story B: Layer 4 customerKeyRef Boundary

### 5.1 Goal

Clear the `customerKeyRef` high gap without pretending that Layer 4 Production
Safety is currently implemented.

There are two valid paths.

### 5.2 Path B1: Keep It Future/Blocked

Use this path if the project is not yet ready to implement the Layer 4
Authority-backed evidence chain.

Actions:

1. Keep the `customerKeyRef` requirement in the Layer 4 plan.
2. Adjust wording so it is clearly future/blocked scope, not a current
   repository requirement.
3. Preserve the rule that any future `customerKeyRef` must be redacted and
   non-secret.
4. Run `lattice gap_analyze` and confirm the row is no longer reported as a
   current uncovered requirement.

Allowed result wording:

```text
customerKeyRef remains a future Layer 4 requirement and is blocked until a
dedicated Layer 4 implementation story adds redaction, evidence binding, and
Authority receipt verification.
```

Forbidden result wording:

```text
customerKeyRef is implemented.
receiptVerified=true.
productionDone=true.
Layer 4 Production Safety is unlocked.
```

### 5.3 Path B2: Implement Layer 4 customerKeyRef

Use this path only when the user explicitly opens a Layer 4 implementation
story.

That story must define and verify:

1. the producer of `customerKeyRef`;
2. redaction rules for logs, reports, receipts, and delivery summaries;
3. non-secret validation;
4. binding to Authority evidence or receipt refs;
5. stale/missing/tampered controls;
6. formal evaluator consumption;
7. negative tests proving local-only or fake evidence cannot pass.

Path B2 may clear the gap, but it must still leave broader claims locked unless
the full Layer 4 suite passes.

## 6. Anti-New-Gap Rules

Use these rules while resolving the three high gaps.

| Rule | Why |
|---|---|
| Do not add new current-tense requirements unless the same story implements and tests them. | Prevents fixing 3 high gaps and creating new uncovered requirements. |
| Put future capability behind `future/blocked` wording. | Keeps roadmap text from being interpreted as current product support. |
| Separate signed-workspace closure from Layer 4 Authority work. | Prevents a small correctness fix from ballooning into Production Safety scope. |
| Re-run `gap_analyze` before and after each follow-up story. | Proves the gap count moves in the intended direction. |
| Treat host review as review evidence, not Authority receipt. | Preserves host-neutral and non-authority CLI boundaries. |

## 7. Recommended Execution Order

1. Finish or intentionally park unrelated active stories so the target is clear.
2. Open one signed-workspace implementation story for GAP-SW-UNRESOLVED-1 and
   GAP-SW-NO-BINDING-1.
3. Run the signed-workspace story to DONE through Lattice lifecycle.
4. Re-run `lattice gap_analyze`.
5. If only GAP-L4-CUSTOMER-KEY-1 remains, choose Path B1 or Path B2.
6. Run the chosen Layer 4 boundary or implementation story to DONE.
7. Re-run `lattice gap_analyze` and `lattice convergence_check`.

Expected project state after both workstreams:

```text
gap_analyze: 0 high / 0 medium
convergence_check: No high-priority gaps PASS
```

`convergence_check` may still fail for other reasons, such as unfinished
stories. That is a separate project-level condition, not a failure of this
three-gap closure plan.

## 8. Evidence Pack

Each follow-up story must include:

- initial `lattice gap_analyze` output;
- final `lattice gap_analyze` output;
- exact changed files;
- source or document anchors for each cleared gap;
- deterministic commands that can be replayed;
- Lattice validation evidence;
- review pass evidence;
- final statement of what remains locked.

For the signed-workspace story, include source/test evidence.

For the customerKeyRef story, include either future/blocked wording evidence or
full Layer 4 implementation evidence. Do not mix the two.

## 9. DONE Criteria For This Plan

This planning story is complete when:

1. this document exists;
2. all three current high gaps are named;
3. the two signed-workspace gaps are assigned to one implementation story;
4. the customerKeyRef gap is assigned to either future/blocked wording or a
   separate Layer 4 implementation story;
5. the document includes stop conditions and anti-new-gap rules;
6. `docs/requirements/NAV.md` links this document;
7. no claim says the gaps are already resolved.

Allowed final wording for this story:

```text
Execution plan written. The three high gaps are not closed yet; they now have a
bounded follow-up path that should clear them without creating new current
uncovered requirements.
```
