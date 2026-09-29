# Identity #148 timing and duplicate scheduling

This local Lab depends on original validation repair candidate `7e866ee7f9`.
It is not Story DONE or main integration evidence.

- The real check dispatcher now reports monotonic phase durations on stderr while preserving success, failure and group filtering. The regression executed the actual dispatcher and reproduced zero timing records before the fix, then passed success, failure and skip controls.
- Seven F-060 callbacks were scheduled in both identity-cutover and its mandatory nested identity-sites group. The repair removes only their outer registration; all seven callback bodies and independent identity-sites execution remain unchanged. A scheduling regression executes the actual dispatcher and checks unchanged callback digests against the dependency candidate.
- The exact dispatcher selector contract is updated after checking unchanged filtering semantics. Existing selector, callback-gate, entrypoint, child-group and witness mutation controls still reject drift. The static inventory passes with no review-needed or unexpanded commands; no execution exception was added.
- The first instrumented full diagnostic ran 259 mutation cases but failed nested static validation because the old dispatcher pin was stale. Preserve it as failed evidence, never full GREEN. That run measured 188.589 seconds for the combined active-boundary refusal check and 41.492 seconds for the seven outer F-060 callbacks.
- Full candidate replay remains required. Timing comparisons under concurrent validation are diagnostic, not controlled speedup evidence. Cross-run verifier reuse and snapshot omissions are not enabled. The child-deadline supervisor remains an external prototype and is not integrated.

Evidence and current execution state:
`/Users/jek/Documents/GitHub/Prooforstop/.git/lab-evidence-archives/identity-148-performance-20260920/`.

## Authorized migration retirement — first decomposition increment

The user authorized retiring the 259 historical identity mutations from routine
validation on 2026-09-20. The campaign remains available only through the explicit
`identity-migration-archive` group. Unfiltered execution also excludes this archive.
The baseline source/configuration and HEAD are preserved outside the checkout in
`.git/lab-evidence-archives/identity-148-performance-20260920/decomposition`.

The old campaign also contained normal consumer controls with the entry preflight
removed, plus project-configuration rejection checks. Those obligations are NOT
retired: `identity-consumer-smoke` runs them separately and restores the modified
CLI entrypoint in a finally block. The observed run passed 15 normal-operation
controls and 12 configuration negatives in 30167.862042 ms, with zero historical
mutation-case executions. This is not an equivalent-workload speedup measurement.

The committed RED showed six routine/default selectors entering the campaign.
The candidate dispatch test shows zero campaign calls for those selectors and one
for explicit archive selection. It also compares the real dispatcher with static
child traversal; exact-source contract bindings and unchanged reviewed witnesses
were refreshed without adding static exceptions. Static traversal reports zero
needs-review and zero unexpanded commands, with the same 1696 exceptions.

This increment does not yet replace validation command #148, alter the 248-command Lab
inventory, complete dynamic selection, or certify the complete remaining suite.

At the original increment recorded in this section, integration main had 244
configured commands; this is a historical measurement, not the current baseline. This Lab inherited
four additional validation registrations from the original audit repair before
this increment, so its actual before/after baseline is 248 -> 248. These are
configuration counts, not lifecycle gate counts or mutation assertion counts.

A read-only diagnostic using discoverValidationInventory, compileValidationCatalog,
buildValidationImpactIndexFromCatalog and selectValidationTiers from the Lab runtime
reported 248 partial selector input closures and zero complete closures. A synthetic
unrelated document path selected repository-full (248 commands), with reasons
command_exclusion_unproven and unclassified_material_input. This is a direct planner
diagnostic, not a completed Story invocation or a proof that every live request
runs all commands. It blocks claiming a production dynamic-selection improvement
from group splitting alone. No completeness declarations or unknown-input gates
were weakened to manufacture a smaller selection.

## Final integration inventory clarification

At main 392526fbf1 (0.3.454), the integration baseline is 246 commands and the
current Lab candidate has 250. The 244/248 figures and selector observations above
are retained as historical evidence of the original increment. They must not be
used as the current command inventory. See the final integration delta in
[the modularization ledger](verification-modularization.md#final-integration-inventory-delta-against-main-03454).
