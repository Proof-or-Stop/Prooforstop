# F-009 gap_analyze High Gaps Execution Plan

```text
Requirement coverage ████████████████████ 100%
Test coverage ████████████████████ 100%
Gaps: 3 high / 0 medium
```

> Status: execution plan
> Story: B-3a80
> Source command: `lattice gap_analyze`
> Claim boundary: this document does not resolve F-009, unlock Layer 2,
> unlock Layer 4, set `productionDone`, set `receiptVerified`, or complete
> Authority work.

## 1. Purpose

This document defines how to execute the current F-009 `gap_analyze` high-gap
triage without converting planning gaps into false completion claims.

The current analyzer output reports three high gaps:

| Source | Analyzer description | B-3a80 classification |
|---|---|---|
| `decisions/review-run-start-signed-workspace-resolution-execution-plan.md:262` | `requires_git_signed_workspace_but_metadata_root_is_not_git_and_no_worktree_or_gitRoot_is_configured` | Real signed-workspace consistency and coverage candidate. Requires source/test verification in a separate implementation path. |
| `decisions/review-run-start-signed-workspace-resolution-execution-plan.md:311` | `requires_git_signed_workspace_but_no_binding` | Real signed-workspace consistency and coverage candidate. Requires source/test verification in a separate implementation path. |
| `decisions/unlock-layer4-production-safety-suite.md:267` | `customerKeyRef` must be redacted and non-secret | Future/blocked Layer 4 scope in B-3a80 unless a separate Layer 4 implementation story is opened. |

The purpose of B-3a80 is to record a conservative execution path and mark the
Layer 4 `customerKeyRef` boundary. It is not to implement either the signed
workspace path or the Layer 4 customer key reference path.

## 2. Governing Principles

All execution under this plan must follow these four principles:

```text
Do not optimize for the sake of optimization.
Do not optimize arbitrarily.
Only fix real correctness issues.
Preserve consistency of logic.
```

Operational meaning:

- Do not add abstractions, registries, proof layers, or CLI surfaces just to
  make `gap_analyze` cleaner.
- Do not broaden this story into signed-workspace implementation, Layer 4
  production safety implementation, Authority implementation, or claim unlock.
- Treat a gap as implementation work only after it is reproduced against source,
  tests, and the current process contract.
- Keep analyzer output, requirement prose, lifecycle gates, signed workspace
  semantics, and Authority receipt semantics logically consistent.

## 3. Non-Goals

- Do not modify
  `review-run-start-signed-workspace-resolution-execution-plan.md` in B-3a80.
- Do not implement `customerKeyRef`.
- Do not claim F-009 resolved.
- Do not claim Layer 2 Engineering is unlocked.
- Do not claim Layer 4 Production Safety is unlocked.
- Do not set or imply `productionDone=true`.
- Do not set or imply `receiptVerified=true`.
- Do not claim Authority completion or full production readiness.
- Do not treat host transcripts, local diagnostics, or this document as formal
  proof artifacts.

## 4. Bounded Current Action

B-3a80 has only three documentation actions:

1. Create this execution plan.
2. Add a bounded note to
   `unlock-layer4-production-safety-suite.md` stating that `customerKeyRef` is
   future/blocked in this context unless a separate Layer 4 implementation
   story is opened.
3. Update `docs/requirements/NAV.md` so the new document is linked and counted.

The two signed-workspace high gaps remain candidates for a future implementation
or verification story. They are not closed by this document.

## 5. Lattice CLI Flow

The implementation story must keep all story metadata behind Lattice CLI
commands and avoid direct story-file edits.

Required local flow:

```bash
lattice session_brief
lattice aux_doc_list
lattice checklist_get '{"storyId":"B-3a80"}'
lattice gap_analyze
```

After scoped docs are updated, verify the result with repository-safe commands:

```bash
lattice gap_analyze
git add -N docs/requirements/decisions/f009-gap-analyze-high-gaps-execution-plan.md
git diff -- docs/requirements/decisions/f009-gap-analyze-high-gaps-execution-plan.md docs/requirements/decisions/unlock-layer4-production-safety-suite.md docs/requirements/NAV.md
git status --short
```

After the docs commit exists, use the commit-bound form so newly created files
cannot be omitted from evidence:

```bash
git diff main...HEAD -- docs/requirements/decisions/f009-gap-analyze-high-gaps-execution-plan.md docs/requirements/decisions/unlock-layer4-production-safety-suite.md docs/requirements/NAV.md
git show --stat --name-only HEAD
```

Commit only the scoped documentation changes. Existing unrelated story metadata
or unrelated working-tree changes must not be reverted or folded into the docs
commit.

## 6. Two-Host Audit Protocol

If a future execution story attempts to close either signed-workspace high gap,
it must use a bounded two-host audit before closure.

Minimum protocol:

| Step | Requirement |
|---|---|
| Freeze anchors | Both hosts receive the same HEAD, material hash, analyzer output, source anchors, and intended claim boundary. |
| Claude CLI review | Claude CLI reviews whether the signed-workspace requirement is implemented, missing, or diagnostic-only. |
| Codex CLI review | Codex CLI independently reviews the same anchors and produces the same verdict shape. |
| Same-anchor check | If hosts review different files, hashes, or analyzer output, both verdicts are stale. |
| Evidence limit | Host verdicts are review evidence only; they are not Authority receipts and cannot unlock claims. |

Required verdict shape:

```json
{
  "gapId": "<stable source anchor or analyzer description>",
  "verdict": "verified_gap | diagnostic_gap | disproven | still_suspected",
  "sourceRefs": ["<file:line>"],
  "testCommands": ["<command>"],
  "claimBoundary": "no Layer2/Layer4/Authority unlock"
}
```

If material evidence changes after either host review, both host verdicts must
be rerun.

## 7. Execution Phases

### Phase 0. Freeze Scope

Actions:

1. Confirm story id, worktree, HEAD, and material hash.
2. Confirm this story is docs-only.
3. Confirm the excluded signed-workspace document is not edited.
4. Confirm no customer-key implementation story has been opened inside B-3a80.

Success criteria:

```text
scope locked to docs triage
excluded signed-workspace plan untouched
customerKeyRef implementation out of scope
```

Stop condition:

```text
BLOCKED: requested change requires signed-workspace or Layer 4 implementation
```

### Phase 1. Reproduce Analyzer Snapshot

Actions:

1. Run `lattice gap_analyze`.
2. Record the count and high-gap source anchors.
3. Classify each high gap as signed-workspace candidate or future/blocked
   Layer 4 scope.

Success criteria:

```text
3 high gaps classified without closure claim
```

Stop condition:

```text
BLOCKED: analyzer output no longer matches the scoped B-3a80 problem
```

### Phase 2. Preserve Signed-Workspace Candidates

Actions:

1. Do not edit the signed-workspace execution plan in this story.
2. Record that both signed-workspace high gaps require real source/test
   verification before they can be closed.
3. If future implementation is requested, open or resume a separate scoped story
   that can modify code and tests.

Success criteria:

```text
signed-workspace gaps remain open candidates
no false resolved status
```

Stop condition:

```text
BLOCKED: closure is requested without source/test evidence
```

### Phase 3. Mark Layer 4 customerKeyRef Boundary

Actions:

1. Preserve the future Layer 4 `customerKeyRef` requirement.
2. Add a bounded note that B-3a80 treats the field as future/blocked planning
   scope.
3. State that a separate Layer 4 implementation story is required before CLI,
   evaluator, receipt, or final-report support can be claimed.

Success criteria:

```text
customerKeyRef requirement preserved
B-3a80 classification is future/blocked
no current implementation claim
```

Stop condition:

```text
BLOCKED: wording implies customerKeyRef is currently implemented or verified
```

### Phase 4. Update Navigation

Actions:

1. Add this document to `docs/requirements/NAV.md`.
2. Increment the document count by one.
3. Keep existing links and ordering stable except for the new entry.

Success criteria:

```text
NAV links the new document
NAV count matches the new document set
```

## 8. Required Evidence Pack

B-3a80 must produce or reference:

- `lattice session_brief` output for the active story/worktree;
- `lattice aux_doc_list` output for requirements context;
- `lattice checklist_get '{"storyId":"B-3a80"}'` output for scoped checklist;
- `lattice gap_analyze` output showing the three high gaps;
- diff of the three scoped docs files, using `git add -N` before commit or
  `git diff main...HEAD` / `git show --name-only HEAD` after commit so newly
  created docs are included;
- commit hash containing only scoped documentation changes.

This evidence pack supports documentation triage only. It does not support
F-009 closure, Layer 2 unlock, Layer 4 unlock, Authority completion,
`productionDone`, or `receiptVerified`.

## 9. DONE Criteria

B-3a80 documentation work is complete when all of these are true:

1. `f009-gap-analyze-high-gaps-execution-plan.md` exists and records the
   current high-gap split.
2. `unlock-layer4-production-safety-suite.md` says `customerKeyRef` is
   future/blocked in B-3a80 unless a separate Layer 4 implementation story is
   opened.
3. `docs/requirements/NAV.md` links the new document and increments the count.
4. The excluded signed-workspace execution plan is not modified.
5. No code implements `customerKeyRef`.
6. The final report avoids all false claim language.

Allowed final wording:

```text
B-3a80 docs triage complete. Signed-workspace high gaps remain implementation
candidates. Layer 4 customerKeyRef remains future/blocked unless a separate
Layer 4 implementation story is opened.
```

Forbidden final wording is any wording that presents F-009 as closed, either
Layer 2 or Layer 4 as unlocked, `productionDone` or `receiptVerified` as proven
or true, or Authority work as complete.
