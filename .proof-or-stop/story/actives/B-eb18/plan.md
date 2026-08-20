# Plan: B-eb18 Implement the global lifecycle control plane

## Scope Guardrails

This story implements the global lifecycle control plane from `docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md` end to end, including the Proof Admissibility Appendix D `admissibility_waterline` minimum because CP-2 requires it when no equivalent entry point exists.

It must not:

- create a second lifecycle state machine;
- recalculate Proof Admissibility policy beyond the Appendix D diagnostic projection;
- replace the DONE oracle, Evidence Runtime, or lifecycle readiness report;
- promote local diagnostic evidence into production or Authority completion;
- hide malformed experiment/queue records behind an exception.

Product-visible completion: an operator can run `lattice global_control_status --format=json` and inspect runtime, consumption, readiness, queue, authoritative cwd, next safe action, Tier-C grouping, and duplicate cleanup suggestions. The operator can also run `lattice admissibility_waterline --storyId=<id> --format=json` to inspect consumer buckets, missing clauses, top reasons, stale/legacy/error counts, and diagnostic-only proof status.

## CHK-001: Implement CP-0 read-only global control inventory report

Implementation:

- Add a `global_control_status` command with text/json output.
- Build report rows from existing public surfaces: story authority resolver, lifecycle readiness, lifecycle-control builders, admissibility waterline, and queue classifier.
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

## CHK-003: Implement CP-2 consumption closure projection and Appendix D waterline

Implementation:

- Add `admissibility_waterline` as a diagnostic-only entry point matching the Proof Admissibility Appendix D minimum.
- Output each consumer's `pass`, `warn`, `fail`, `error`, `stale`, and `legacy` buckets, `missingClauses`, `topReasons`, `staleRatio`, `maxStaleAgeHours`, `highSeverityFailCount`, and `unknownArtifacts` where data exists.
- Add a consumption projector under `core/lifecycle-control/consumption` that consumes the waterline instead of defining a competing schema.
- Preserve current subject selector, consumer, contract version, temporal/material binding, active policy, and latest/non-superseded semantics in the projection boundary.
- Keep counts diagnostic-only; they cannot promote scope or satisfy proof by themselves.
- Never allow candidate, diagnostic, or legacy artifacts to satisfy DONE through the control plane.

Verification:

- Smoke covers `admissibility_waterline` text/json output and diagnostic-only status.
- Logic tests assert historical failed/stale rows remain audit-only unless they match current subject/consumer/contract/material/policy/latest selection.
- Logic tests assert candidate/diagnostic/legacy evidence remains non-satisfying for DONE/production wording in the control-plane projection.

## CHK-004: Implement CP-3 queue governance and experiment exceptions

Implementation:

- Add active story classification: `active-worktree`, `stale-worktree`, `main-init`, `experiment-batch-exception`, `duplicate-candidate`, `superseded`, and `cleanup-required`.
- Add a durable queue exception registry for experiment batches.
- Register Tier-C provider-execution receipt verification stories as an experiment exception by explicit registry/migration rule.
- Support collapsed experiment batches by default and expanded batch detail on request.
- Apply precedence: cleanup-required first, active worktree before collapse, experiment exception before duplicate candidate, superseded only with machine-readable metadata.

Verification:

- `queue_governance_status` smoke covers Tier-C grouping, expanded view, non-experiment duplicates, and malformed experiment cleanup visibility.
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

- Add `queue_exception_set` as a guarded write with `policyVersion`, class, subject, membership source, experiment batch id, actor, reason, timestamp, story identity/binding, required `storyFilesHash`, dashboard mode, and cleanup policy.
- Use write coordination for the shared exception registry.
- Keep `queue_governance_status` read-only.
- Do not hard-block or clean Tier-C experiment exception stories.
- Report non-experiment duplicates with canonical/superseded suggestions before any cleanup flow can proceed.

Verification:

- CLI smoke writes an exception and reads it back with audit metadata.
- Logic tests assert malformed experiment rows stay visible and Tier-C stories are preserved.
- Mutation tests assert read-only status commands remain read-only while `queue_exception_set` is the only planned write path.
