# Plan: B-eb18 Implement the global lifecycle control plane

## Scope Guardrails

This story implements the global lifecycle control plane from `docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md` without replacing existing sources of truth.

It must not:

- create a second lifecycle state machine;
- recalculate Proof Admissibility policy or evidence freshness;
- replace the DONE oracle, Evidence Runtime, or lifecycle readiness report;
- promote local diagnostic evidence into production or Authority completion;
- hide malformed experiment/queue records behind an exception.

Product-visible completion: an operator can run `lattice global_control_status --format=json` and inspect runtime, consumption, readiness, queue, authoritative cwd, next safe action, Tier-C grouping, and duplicate cleanup suggestions without stitching multiple commands or stale docs.

## CHK-001: Implement CP-0 read-only global control inventory report

Implementation:

- Add a `global_control_status` command with text/json output.
- Build report rows from existing public surfaces: story authority resolver, lifecycle readiness, lifecycle-control builders, and queue classifier.
- Include schema version, `readOnly=true`, project root, active story rows, authoritative cwd, mirror drift, runtime/consumption/readiness/queue sections, and top blockers.
- Keep the command non-mutating: no story metadata writes, no process events, no evidence writes, and no git changes.

Verification:

- CLI smoke asserts JSON schema, `readOnly=true`, authoritative cwd for a worktree story, and no mutation around the command.
- Logic smoke covers mirror/worktree divergence without plan-doc heuristics.

## CHK-002: Implement CP-1 runtime closure projection

Implementation:

- Add a runtime projector under `core/lifecycle-control/runtime`.
- Consume `resolveStoryAuthority`, `buildStoryReadinessReport`, `summarizeOwnerLease`, and existing stale/freshness hint helpers.
- Render runtime status, blocker count, source, safe next action, authoritative cwd, mirror drift, owner lease, validation/main-lock availability where public read APIs exist, and readiness row summary.
- Missing pure lock inspection APIs must render as `unknown`/`unavailable`, not green.

Verification:

- `runtime_closure_status` smoke covers worktree authority, mirror drift, readiness blockers, and no mutation.
- Logic tests assert runtime projection does not invent a freshness classifier.

## CHK-003: Implement CP-2 consumption closure projection

Implementation:

- Add a consumption projector under `core/lifecycle-control/consumption`.
- Consume existing Proof Admissibility public APIs/diagnostics where available.
- Because no implemented `admissibility_waterline` API currently exists, render waterline capability as unavailable/unknown rather than claiming green.
- Preserve policy/consumer/source identity fields when available.
- Never allow candidate, diagnostic, or legacy artifacts to satisfy DONE through the control plane.

Verification:

- Smoke covers unavailable waterline rendering.
- Logic tests assert candidate/diagnostic/legacy evidence remains non-satisfying for DONE/production wording in the control-plane projection.

## CHK-004: Implement CP-3 queue governance and experiment exceptions

Implementation:

- Add active story classification: `active-worktree`, `stale-worktree`, `main-init`, `experiment-batch-exception`, `duplicate-candidate`, `superseded`, and `cleanup-required`.
- Add a durable queue exception registry for experiment batches.
- Register Tier-C provider-execution receipt verification stories as an experiment exception by explicit registry/migration rule.
- Apply precedence: cleanup-required first, active worktree before collapse, experiment exception before duplicate candidate, superseded only with machine-readable metadata.

Verification:

- `queue_governance_status` smoke covers Tier-C grouping, non-experiment duplicates, and malformed experiment cleanup visibility.
- Tests assert experiment exceptions do not grant lifecycle readiness or proof admissibility.

## CHK-005: Implement CP-4 unified dashboard command output

Implementation:

- Compose project-level and story-level control status.
- Show runtime, consumption, readiness, and queue sections separately.
- Include aggregate counts: stale worktrees, duplicate clusters, experiment batch groups, and cleanup-required rows.
- Text output must make story-level gate blockers visibly separate from project-level queue health.

Verification:

- CLI smoke asserts text and JSON render project summary and story rows.
- Logic test asserts project queue pressure does not block an unrelated story-level gate.

## CHK-006: Implement CP-5A runtime enforcement rollout guardrails

Implementation:

- Add a runtime enforcement helper/config surface for only the unsafe operations named by the plan.
- Support warn-first semantics over the same story/head/material/runtime-policy tuple before enforce mode.
- Provide documented rollback/config switch.
- Do not evaluate proof admissibility in runtime enforcement.
- If existing story_advance/ownership gates already hard-block a condition, render that as covered instead of duplicating it.

Verification:

- Logic smoke covers named unsafe runtime operations, metadata-only versus material dirty distinction, and non-interference with normal development.
- Test asserts no Proof M7 policy is implemented in runtime enforcement.

## CHK-007: Implement CP-5B queue governance guard and verification

Implementation:

- Add `queue_exception_set` as a guarded write with actor, reason, timestamp, story identity/binding, and experiment batch id.
- Use write coordination for the shared exception registry.
- Keep `queue_governance_status` read-only.
- Do not hard-block or clean Tier-C experiment exception stories.
- Report non-experiment duplicates with canonical/superseded suggestions before any cleanup flow can proceed.

Verification:

- CLI smoke writes an exception and reads it back with audit metadata.
- Logic tests assert malformed experiment rows stay visible and Tier-C stories are preserved.
- Mutation tests assert read-only status commands remain read-only while `queue_exception_set` is the only planned write path.
