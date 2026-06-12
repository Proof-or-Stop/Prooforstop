# B-3a80 Execution Plan

## CHK-001

**Goal**: Triage the current `gap_analyze` high findings without falsely resolving them.

**Owner**: main-agent

**Steps**:
1. Run `lattice gap_analyze` in the story worktree.
2. Record the exact high findings in the execution document.
3. Classify signed workspace findings as real consistency or coverage candidates requiring follow-up proof.
4. Classify Layer4 `customerKeyRef` as future/blocked scope unless a separate Layer4 implementation story is opened.

**Verify**:
- Evidence includes the `lattice gap_analyze` command result.
- The document does not state F-009 is resolved.
- The document does not state Layer2, Layer4, Authority, or production claims are unlocked.

## CHK-002

**Goal**: Draft a conservative execution document for the high-gap follow-up.

**Owner**: main-agent

**Steps**:
1. Ask Codex CLI and Claude CLI for independent host review/draft input over the same scope.
2. Create `docs/requirements/decisions/f009-gap-analyze-high-gaps-execution-plan.md`.
3. Include Lattice CLI lifecycle steps, two-host audit protocol, exact stop conditions, and DONE criteria.
4. Add the new document to `docs/requirements/NAV.md` without absorbing unrelated root dirty files.

**Verify**:
- The document contains Purpose, Non-goals, Current Findings, Execution Flow, Two-Host Review, Stop Conditions, and DONE Criteria.
- Host outputs are treated as review inputs, not Authority Server receipts.
- NAV count and link match the new document.

## CHK-003

**Goal**: Mark Layer4 `customerKeyRef` as future/blocked for this context.

**Owner**: main-agent

**Steps**:
1. Update the Layer4 production safety suite document with a bounded note.
2. Preserve future Layer4 production-safety design intent.
3. State that this story does not implement customer key handling, receipt verification, or Production Safety unlock.

**Verify**:
- The Layer4 document contains `future/blocked` wording near `customerKeyRef`.
- The wording does not remove future requirements from the Layer4 suite.
- The wording does not imply current CLI or Authority Server support.

## CHK-004

**Goal**: Verify documentation consistency and navigation.

**Owner**: main-agent

**Steps**:
1. Run document/navigation checks available locally.
2. Run text checks for forbidden overclaims: Layer2 unlocked, Layer4 unlocked, production done, receipt verified.
3. Record verification evidence on each checklist item.
4. Send the final document to Claude CLI for an independent final audit.

**Verify**:
- `lattice validate --story=B-3a80 --json` passes or reports only real blockers.
- `git diff --name-only` contains only story-scoped docs and Lattice metadata.
- Claude CLI final audit reports no high/critical correctness issue.
