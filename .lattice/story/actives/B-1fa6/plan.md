# B-1fa6 Execution Plan

This is a documentation-only Story. Its sole material output is
`docs/requirements/decisions/dynamic-finding-system-execution-plan.md`.
It does not implement the proposed schemas, commands, runtime receipts, locks,
gate changes, package renames, or future Stories.

## CHK-001 — Document the seven historical Finding problems and reproducible evidence

1. Re-run the CLI-only corpus inventory at the Story worktree HEAD and label all
   totals as a dated snapshot rather than stable constants.
2. Record the projection semantics: legacy missing `evidenceState` is rendered
   as verified, reviewer-run counts are not review-round counts, and optional
   evidence fields have explicit denominators.
3. Use authorized `finding_list --json` queries for the named historical
   incidents: B-cdf6:F-056, F-067, F-070; B-META-framework-audit:F-029,
   F-030, F-031, F-032, and F-035.
4. Describe exactly seven problem classes and distinguish recorded historical
   incidents from assertions about current unresolved behavior.
5. Include the regeneration commands and forbid direct parsing of protected
   Story/Finding storage.

Verification: rerun the documented CLI queries, reconcile each identifier and
outcome, and fail if any copied figure lacks its observation date and HEAD.

## CHK-002 — Specify the four-component Dynamic Finding architecture and gate contract

Define exactly these four components:

1. Finding Ledger Integrity.
2. Candidate & Defect Identity.
3. Dynamic Applicability.
4. Freshness & Supersession.

Specify the typed records and authority boundary from DetectorSignal to
CandidateFinding, verified Finding, canonical defect, signed applicability
assessment, routing, freshness, supersession, batch manifest, and Gate.
Historical learning remains `gateEvidence=false`. The only new gate authority
is a fresh, signed, current-Story assessment registered as a process fact.

Define one shared blocking predicate. Unknown, unsigned, stale, mismatched, or
tampered high/critical assessments fail closed. File disjointness, model
confidence, historical similarity, signatureTag, DONE outcome, and playbook
content never independently block or unblock.

Verification: inspect every component for inputs, outputs, writes, authority,
non-responsibilities, legacy fallback, and negative gate paths.

## CHK-003 — Decompose delivery into three implementation Stories with dependencies and acceptance criteria

Define these exact future Story contracts:

1. Dynamic Finding Applicability.
2. Finding Identity and Historical Lineage.
3. Finding Ledger and Runtime Evidence Integrity.

Map all seven problems to one primary owner, with explicit jointly mitigated
problems. Explain that the displayed numbering is semantic, not execution order.
Safe execution order is Story 3, then Story 2, then Story 1 enforcement; Story 1
may prototype observe-only output earlier only if it remains non-authoritative.

Component 4 intentionally crosses two Stories: historical supersession and
canonical lookup belong to Story 2; runtime receipt and stale-artifact
invalidation belong to Story 3. Story 1 consumes both.

Each Story section must include objective, problem ownership, deliverables,
dependencies, acceptance tests, non-goals, process-fact impact, and combination
review requirements. The existing convergence breaker remains a backstop and is
not rebuilt.

Verification: the dependency graph is acyclic, all components and problems have
owners, no gate enforcement precedes its foundations, and no acceptance criterion
uses vague language such as "works".

## CHK-004 — Define migration rollout metrics and the @proof-or-stop/lab scope-change example

Define observe, warn, and enforce states with entry criteria, writes, authority,
operator output, rollback, and exit criteria. Legacy Findings stay append-only
and are assessed lazily; there is no bulk rewrite.

Define a reproducible scorecard for safety, precision, review effort, and runtime
cost. Zero false non-blocking high/critical verdicts is an enforcement floor.
Separate classifier compute, reviewer triage, genuine repair, and convergence
costs.

Use `@lattice/lab -> @proof-or-stop/lab` to demonstrate scope-bound
applicability: preserve the historical decision that sibling package names were
out of scope, treat the new operator request as current scope evidence, mint a
new assessment, and keep package publication/workspace resolution separate from
brand naming. Do not rename packages in this Story and do not expand to
`@lattice/utils`.

Verification: an independent reader can reproduce both the historical
out-of-scope and current applicable interpretations, and rollback restores the
old authoritative gate without deleting audit records.

## Commit and lifecycle sequence

1. Create the Markdown file with `apply_patch`.
2. Run structural checks, exact-name/count checks, link/path checks, English-only
   checks, and replay the named CLI evidence.
3. Record checklist verification evidence and mark all items done.
4. Commit material and metadata before REVIEW.
5. Run independent documentation, concept, and coverage review as required by
   the REVIEW gate.
6. Run routine validation once in TEST, then use `done_prepare` before DONE.
