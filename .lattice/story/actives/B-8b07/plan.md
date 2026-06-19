# B-8b07 Plan

This story writes a requirements decision document only. It does not implement runtime gates, CLI commands, Authority behavior, baseline runners, or review escalation code.

## CHK-001: Inventory related governance documents and current baseline context

**Owner**: main-agent

**Scope**: Build the source/context inventory that will become visible inside the final decision document. The inventory must include the existing Lattice governance documents that shape this roadmap and the current baseline context discussed with the user.

**Steps**:
1. Read the established execution-plan documents for unattended completion, mid-flight story repair, three-round two-host review escalation, and baseline two-host multi-agent execution.
2. Read the lifecycle, testing completeness, verification context pack, scope guidance, artifact-scope, and ownership/lease documents for current process constraints.
3. Capture the product-reviewer INIT advisory by making the inventory visible in the final document as a Source And Context Mapping section.
4. Treat baseline PASS suites and negative-control BLOCKED suites as future validation expectations, not as proof that this new roadmap is implemented.

**Verify**:
- CHK-001:happy:0 is satisfied when the final decision document contains a Source And Context Mapping table that lists the relevant source documents and maps each one to plan sections or milestone decisions.
- CHK-001:edge:0 is satisfied when the mapping distinguishes overlapping concepts instead of flattening lifecycle, repair, 3x2 review, baseline, and negative-control facts into vague citations.
- CHK-001:adversarial:0 is satisfied when a skeptical reader can trace major source-derived claims without finding invented runtime behavior or direct story/fixture edits.

**Stop Conditions**:
- Stop if an implementation requirement appears necessary; route it into a future milestone story instead of adding code to this story.
- Stop if a source claim cannot be tied to a local document or to the current baseline inventory.

## CHK-002: Write the milestone execution plan for the three strengthening tracks

**Owner**: main-agent

**Scope**: Create docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md and register it in docs/requirements/NAV.md. The document must decompose the three strengthening tracks into executable milestones.

**Steps**:
1. Define status, purpose, non-goals, and guiding principles so the document cannot be mistaken for completed runtime behavior.
2. Define the three strengthening tracks: hard scope boundaries, mechanical verification evidence, and collaboration/preflight controls.
3. Break the roadmap into fine-grained milestones with deliverables, gate placement, tests, evidence, dependencies, blockers, and DONE criteria.
4. Add sequencing guidance that shows which milestones are serial, which can run in parallel, and what contracts must be frozen before parallel work.
5. Add explicit baseline and negative-control expectations for future implementation stories, including development, engineering, loop-engineering, and fail-closed suites where relevant.
6. Update docs/requirements/NAV.md with the new decision document.

**Verify**:
- CHK-002:happy:0 is satisfied when the new document exists, NAV links to it, and the three tracks are decomposed into executable milestones.
- CHK-002:edge:0 is satisfied when every milestone has deliverables, gates, tests, sequencing, dependencies, expected evidence, blockers, and DONE criteria, with 3-round 2-host and baseline expectations where applicable.
- CHK-002:adversarial:0 is satisfied when the plan does not collapse into vague prose or imply that future gates are already implemented.

**Stop Conditions**:
- Stop if the document starts specifying concrete runtime code changes beyond milestone-level plans.
- Stop if a milestone cannot be tested or audited; refine the milestone before proceeding.

## CHK-003: Verify the document is auditable and does not overclaim implementation

**Owner**: main-agent

**Scope**: Review the finished document and NAV update against the verificationIntent, scope boundary, and current Lattice governance rules. Record evidence for the document checks.

**Steps**:
1. Inspect the final document for explicit status, non-goals, source/context traceability, milestone DONE criteria, validation plan, review policy, baseline expectations, and overclaim boundaries.
2. Search for ambiguous wording that could imply runtime enforcement has already shipped, especially words such as enforces, blocks, guarantees, passes, complete, authorityDone, productionDone, and fullAuthorityDone.
3. Confirm direct implementation exclusions remain intact: no runtime CLI implementation, no Authority Server/customerKeyRef/Layer4 implementation, no repair UX code, no direct story JSON edits, and no fixture edits.
4. Run documentation checks such as git diff --check and, if practical, packages/main build to make sure the doc/NAV change does not leave the repo in a broken state.
5. Prepare for REVIEW by committing the document and metadata evidence before phase advancement.

**Verify**:
- CHK-003:happy:0 is satisfied when the document has explicit status/non-goals, milestone DONE criteria, verification plan, source/context traceability, 3x2 review policy, baseline expectations, and NAV registration verification.
- CHK-003:edge:0 is satisfied when ambiguous future-behavior wording is clearly scoped as proposed or future implementation work.
- CHK-003:adversarial:0 is satisfied when a hostile audit cannot find runtime overclaiming, missing NAV registration, missing 3x2/baseline expectations, or unauditable milestones.

**Stop Conditions**:
- Stop if review finds the document claims implemented runtime behavior.
- Stop if the final diff includes files outside docs/requirements/decisions and docs/requirements/NAV.md without a fresh scope acknowledgement.
