# B-0717 Execution Plan

This PLAN stage is documentation-only. It prepares the cli-engine modularization execution plan and the strong-verification path. It does not refactor packages/main/src/cli-engine.ts or change CLI behavior.

## Scope Boundary

Allowed in B-0717:

- Create docs/requirements/decisions/cli-engine-modularization-execution-plan.md.
- Inventory cli-engine.ts responsibilities and existing command contracts from current source.
- Define Lattice Authority Server receipt-backed verification, local 3 round x 2 host quorum, and degraded 3 round x 1 host fallback semantics.
- Record verification commands and stop conditions for future implementation stories.

Excluded from B-0717:

- Refactoring cli-engine.ts or moving code.
- Renaming, removing, or changing command schemas.
- Claiming Authority production completion without a verified production gate_decision receipt.

## CHK-001

Write the execution-plan document. The document must include purpose, non-goals, current inventory, target module boundaries, staged implementation rounds, compatibility contract, Authority verification path, local review quorum, verification matrix, and rollback/stop conditions.

Evidence will be a docs_check entry pointing at docs/requirements/decisions/cli-engine-modularization-execution-plan.md and explaining how the document satisfies the happy, edge, and adversarial verificationIntent entries.

## CHK-002

Verify the plan against the current cli-engine and command contracts. The plan must be grounded in current source facts: cli-engine.ts is still the orchestration/god file, handlers are mostly registered through registry.ts and handlers/*, and future implementation stories must preserve or deliberately migrate test-facing exports such as MAIN_TOOLS, parseFlags, owner lease helpers, and init-check metadata sync helpers.

Evidence will include source-inventory commands such as rg over packages/main/src/cli-engine.ts, registry.ts, package scripts, and the selected verification commands. Source paths are read-only touchpoints in this story, not modification targets.

## CHK-003

Record strong-verification readiness and review quorum requirements. The plan must define the Authority Server command flow: authority_status/readiness, authority_job_create, independent verdict submission, authority_job_status reconciliation, authority_receipt_verify, and lifecycle receipt consumption. It must explicitly state that local authority_status off/not-configured cannot be represented as production Authority completion.

The default strong local quorum for future high-risk implementation slices is 3 rounds x 2 independent hosts over the same anchors. A 3 rounds x 1 host flow is only a degraded fallback with explicit lower-assurance classification and cannot be treated as equivalent to 3x2 for major architecture work.

## Review And Gate Path

1. PLAN review must pass before writing the external decision document.
2. DEV writes only docs/requirements/decisions/cli-engine-modularization-execution-plan.md.
3. REVIEW must include normal reviewer lanes and scope/coverage review for Authority overclaim and source-modification boundary violations.
4. TEST runs lattice validate for B-0717 and records documentation/source-inventory/Authority-readiness evidence.
5. DONE may state that the execution plan was produced, but not that cli-engine.ts was decomposed.

## Stop Conditions

Stop and re-plan if any host tries to move code in B-0717, if the Authority path is described as complete without a production gate_decision receipt, if future implementation slices lack compatibility re-export strategy, or if verification commands cannot be mapped to current package scripts or explicit conditional commands.
