# Validation widening matrix authority

Status: accepted for the shipped runtime

## Decision

The executable validation-widening reason-code contract lives in
`docs/validation-performance.md`, section `Dynamic-tier fail-closed widening
matrix`. That table and `VALIDATION_WIDENING_REASONS` must remain identical in
reason code, normalized outcome, and condition text; the bidirectional smoke
test enforces the relationship.

The branch-owned
`docs/requirements/decisions/story-relevance-dynamic-validation-tiers-execution-plan.md`
remains design history until it is integrated. If that plan is later published
on main, its fail-closed matrix must carry a pointer to this decision and the
executable operator contract instead of becoming a second runtime authority.

## Rationale

The runtime has added fail-closed reasons beyond the earlier design matrix.
Keeping two independently editable exact tables would make either document
silently stale. One shipped operator table, one executable runtime table, and a
bidirectional regression provide a mechanically checked source/projection pair;
this decision records that authority transfer in the canonical decisions tree.

## Change rule

Any change to a reason code, outcome, or condition must update the runtime table,
the operator table, and their bidirectional regression in the same commit. A
design-plan update may explain the change but cannot override the executable
contract.
