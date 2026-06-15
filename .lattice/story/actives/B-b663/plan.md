# Execution Plan

## CHK-001

### Goal
Update `docs/requirements/decisions/three-round-two-host-review-escalation-execution-plan.md` so documentation and decision-doc audit use the same automatic 3x2/3x1 escalation policy as ordinary development.

### Scope
Modify only the execution-plan decision document. Do not change runtime code, command handlers, gate predicates, process-fact registry, or Authority behavior in this story.

### Required Content
- Replace target-policy wording that preserves always-on decision-doc 3x2.
- State that documentation and decision-doc audit start with ordinary REVIEW by default.
- State that documentation and decision-doc audit escalate to full 3x2 only when the first REVIEW round has at least two countable problems.
- State that documentation and decision-doc audit can use the same explicit degraded 3x1 fallback when a second host is unavailable or approved single-host local mode is allowed.
- State that current runtime code may still enforce the legacy decision-doc 3x2 gate until a follow-up implementation story changes it.
- Preserve honesty: do not claim runtime behavior is already implemented.

### Verification
Use targeted `rg` checks against the document for unified audit policy, threshold trigger, degraded fallback, transition note, and no target-policy always-on language. Then run `lattice validate --story=B-b663 --json`.

### Non-Goals
Do not implement runtime gate behavior. Do not modify packages/main/src. Do not claim Authority receipt completion.
