# Proofbound Strengthening Roadmap Execution Plan

Date: 2026-06-19
Origin story: B-8b07
Audit repair story: B-b5c0
Wave 1 implementation story: B-997b
Status: M1-M3 wave complete; M4-M12 remain follow-up milestones

## Status And Purpose

This document is a requirements decision and execution roadmap for strengthening
Proofbound along three coordinated tracks:

1. **Hard scope boundaries**: make every story's allowed work, excluded work,
   lifecycle artifact allowance, and later-phase scope change path explicit and
   mechanically checkable.
2. **Mechanical verification and evidence chain**: ensure claims flow from
   structured intent, fresh evidence, signed reviewer runs, material hashes,
   validation output, baseline results, and receipt or host verdict artifacts
   instead of prose conclusions.
3. **Collaboration and preflight controls**: make multi-session, multi-host,
   and pre-DONE coordination fail closed before it can produce false DONE,
   stale review, duplicated work, or overclaimed authority.

B-997b implements the first hard-scope wave for M1-M3: canonical scope rows,
registry-backed lifecycle/runtime artifact classification, guard projection, and
explicit acknowledgement visibility. M4-M12 remain follow-up milestones; this
document still schedules those later controls so future implementation stories
can be scoped, reviewed, validated, and accepted without rediscovering the same
policy choices in every branch.

The desired product outcome is:

```text
An operator can ask "is this Proofbound story safe to proceed, review, validate,
merge, or claim?" and receive a mechanically grounded answer that names the
scope boundary, evidence state, host/reviewer independence state, baseline
expectation, and next required action.
```

The product/material deliverable of B-b5c0 was only this document repair. The
B-997b wave is deliberately narrower than the whole roadmap: it ships M1-M3
scope boundary behavior and keeps local-assurance Layer 4/customer key work out of
scope. Any `.lattice/story/actives/<storyId>/*` lifecycle metadata is
story-scoped provenance produced by the Proofbound workflow, not proof of later
roadmap milestones.

## Source And Context Mapping

| Source | Current role | Roadmap decisions derived from it |
|---|---|---|
| `docs/requirements/decisions/lattice-unattended-completion-plan.md` | Defines the larger unattended completion path: planned steps, Authority, executor loop, planner, redevelopment, gap gates, and final multi-host certification. | This roadmap keeps typed execution, evidence upload, gate receipt, bounded repair, and 3-wave host certification as future implementation milestones; it treats Authority and executor work as downstream implementation, not current delivery. |
| `docs/requirements/decisions/lattice-midflight-story-repair-and-gitroot-worktree-plan.md` | Defines audited legacy repair for missing `verificationIntent`, gitRoot-aware worktree bootstrap, and decision-document 3-round 2-host verification expectations for core workflow changes. | This roadmap uses repair as a model for explicit, phase-aware, audited escape hatches; it forbids silent schema repair and direct story JSON edits; it carries 3-round 2-host validation into high-risk roadmap milestones. |
| `docs/requirements/decisions/three-round-two-host-review-escalation-execution-plan.md` | Defines threshold-triggered review escalation, independent host identity requirements, degraded single-host fallback, and DONE gate placement. | This roadmap separates ordinary review, triggered 3x2 escalation, and lower-assurance fallback; it requires host/session/key/material binding before final high-risk claims. |
| `docs/requirements/decisions/lattice-baseline-two-host-multi-agent-execution-plan.md` | Defines two-host baseline execution, natural-language and redevelopment baseline tracks, success-rate reporting, expected blocks, and claim boundaries. | This roadmap treats baseline PASS suites and negative-control BLOCKED suites as future validation expectations, not proof from this story; it requires success-rate math and false-DONE accounting before capability claims. |
| `docs/requirements/decisions/story-lifecycle.md` | Defines the current `INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE` lifecycle, `verificationIntent`, `verificationEvidence`, review runs, stale evidence, process fact registry, owner lease, and user-value DONE semantics. | This roadmap uses lifecycle phase gates as the placement for scope, evidence, review, validation, delivery, and user-value checks; it requires two-layer protection for process facts. |
| `docs/requirements/decisions/testing-completeness.md` | Defines flow-function test expectations and gate-consumed test evidence metadata. | This roadmap requires flow-level and end-to-end validation for shared gate logic, not only unit tests; it keeps validation metadata separate from material drift. |
| `docs/requirements/decisions/verification-context-pack.md` | Defines structured verification context packs, digest parity, required refs, context expansion, and authority evidence envelopes. | This roadmap uses context packs as the verifier reading boundary and requires every future evidence-chain milestone to bind evidence to changed files, refs, commands, and material hashes. |
| `docs/requirements/decisions/lattice-authority-receipt-contract.md` | Defines the server-owned Authority receipt contract directly: current policy discovery, actor key registry, runner/session baseline, evidence envelope handling, `gate_decision` receipt subject fields, proof bundle, state-version freshness, server key trust, and minimum server tests. | This roadmap derives Authority receipt requirements from that primary contract, not from a secondary summary. Future Authority-facing milestones must preserve `gate_decision` subject/input/decision digest binding, trusted server key verification, state-version freshness, actor/runner/session requirements when policy makes them hard, and the rule that server receipts do not exist merely because local prose or transcripts say they do. |
| `docs/requirements/decisions/lifecycle-gate-receipt-consumption.md` | Defines the CLI lifecycle-gate receipt consumer directly: TEST/DONE Authority shadow/enforce baseline, REVIEW policy-dependence, receipt eligibility predicate, gate consumption predicate, `strongEvidenceConsumed`, local review escalation, and the boundary between local host verdicts and Authority completion. | This roadmap derives lifecycle receipt and local review-escalation requirements from that primary contract. Future lifecycle milestones must keep receipt eligibility separate from consumption, require exact story/phase/head/material/policy binding, and prevent local verdicts, degraded fallback, decision-doc diagnostics, or Authority identity from setting local completion or Authority completion fields by prose. |
| `docs/requirements/decisions/lifecycle-artifact-scope.md` | Defines the narrow story-scoped lifecycle artifact classifier and rejects blanket runtime/story metadata exemptions. | This roadmap requires filename-aware lifecycle artifact allowances and negative controls for arbitrary metadata files. |
| `docs/requirements/decisions/session-ownership-and-write-leases.md` | Defines story owner leases, main write locks, read-only reviewer mode, and multi-session mutation classes. | This roadmap makes owner lease, main lock, takeover, and read-only advisory reviewer behavior preconditions for collaboration milestones. |
| `docs/requirements/decisions/scope-check-missing-guidance-execution-plan.md` | Defines the difference between PLAN `scope_check_save` evidence and later scope contracts, and requires better guidance without weakening gates. | This roadmap keeps PLAN scope review, DEV/REVIEW scope acknowledgements, and runtime guard sessions distinct; it prevents `scope_contract_check` from substituting for `scope_check_save`. |
| `docs/guide-scope-guard.md` | Defines prewrite scope guard modes: active Claude hook vs watcher fallback for Codex/Gemini/headless hosts. | This roadmap requires host-specific protection levels to be reported honestly; watcher fallback may block lifecycle progression but must not claim prewrite interception. |
| `docs/requirements/decisions/lattice-parallel-wave.md` | Defines read-only collection-level scheduling, no authority evidence, no runner spawning, and hotspot/dependency projections. | This roadmap uses parallel wave only as planning/preflight context; it cannot satisfy lifecycle, authority, review, or production gates. |
| `docs/requirements/decisions/unlock-layer2-ENG-suite.md` | Defines Engineering baseline proof, real engineering task classes, fail-closed proof gates, independent host review, and formal unlock boundaries. | This roadmap names Layer 2 Engineering baseline expectations for future scope/evidence milestones and keeps local diagnostic baseline output separate from formal proof. |
| `docs/requirements/decisions/unlock-layer3-loop-engineering-suite.md` | Defines Loop Engineering / UDM baselines for planner, executor, repair, review loop, evidence gate, budget stop, human handoff, and no false DONE. | This roadmap names UDM negative controls and bounded loop expectations for future collaboration/preflight milestones. |
| `docs/requirements/decisions/unlock-layer4-production-safety-suite.md` | Defines Production Safety baselines, Authority receipt expectations, negative controls, and production claim boundaries. | This roadmap requires future Authority/production milestones to prove fake, stale, wrong-run, wrong-material, local-only, and host-transcript controls as expected blocks. |

Overlapping concepts are intentionally kept separate:

- **Unattended completion** is the broad capability path; it does not prove this
  roadmap is implemented.
- **Mid-flight repair** is an explicit migration/repair escape hatch; it must
  not normalize silent late mutation.
- **3-round 2-host review** is a high-assurance final review pattern; it does
  not create Authority receipts, local completion fields, or production claims.
- **Authority receipt contracts** are server/gate contracts with signed
  `gate_decision` receipt refs; local host verdicts, local identities,
  decision-doc diagnostics, and transcripts cannot stand in for them.
- **Baseline PASS suites** prove selected capability classes only after they
  run; this roadmap merely names expected future suites.
- **Negative-control BLOCKED suites** are successful safety outcomes only when
  the expected block is mechanically checkable and the suite definition allows
  `EXPECTED_BLOCK`.

## Current Implementation Status Axis

Future stories must classify each touched surface before implementation. The
status axis prevents a roadmap milestone from reintroducing already shipped
behavior as if it were net-new.

| Status | Meaning for future stories |
|---|---|
| `shipped` | Current runtime/docs already define and deliver the behavior. Future stories may test, preserve, or extend it, but must not claim to be creating the baseline from scratch. |
| `harden-existing` | A baseline exists and the milestone adds stricter rows, tests, identity binding, status projection, or negative controls. |
| `partial` | Some primitives are shipped, but important policy, binding, enforcement, or cross-surface consumption remains incomplete. |
| `planned` | Adopted design or acceptance target exists, but this roadmap does not implement the runtime behavior. |
| `greenfield` | No current product capability exists; a future story would create the first implementation. |

Current baseline classification after the B-997b M1-M3 wave:

| Surface | Current status | Source of truth | Roadmap treatment |
|---|---|---|---|
| `INIT -> INIT_CHECK` scope anti-expansion gate | `shipped` + `harden-existing` | `story-lifecycle.md`; `lifecycle-artifact-scope.md` | Preserve the existing hard gate and add clearer row ids, validation commands, and cross-host negative controls where later milestones touch it. |
| `scope_boundary_set`, `execution_boundary_set`, `scope_freeze_check`, `scope_extension_decide` artifacts | `shipped` + `harden-existing` | `story-lifecycle.md`; `lifecycle-artifact-scope.md` | Treat these as current structured process facts. Future work hardens freshness, renderer parity, and audit visibility rather than inventing scope freeze. |
| Lifecycle artifact classifier and runtime artifact registry split | `shipped` + `harden-existing` | `lifecycle-artifact-scope.md`; `story-lifecycle.md` | Keep filename-aware provenance classification separate from gate receipt or DONE satisfaction. Future work adds expected-block coverage. |
| Story owner lease, `--takeover` / `--forceTakeover`, main write lock, and `session_brief` ownership rendering | `shipped` + `harden-existing` | `session-ownership-and-write-leases.md`; `story-lifecycle.md` | Build preflight and rollout controls on the existing owner/main-lock baseline. Do not describe owner lease, main lock, or ownership rendering as future invention. |
| Parallel Wave planning surfaces | `shipped` + `harden-existing` | `lattice-parallel-wave.md` | Treat `parallel_wave_*`, `parallel_plan`, `parallel_dispatch`, `parallel_status`, `parallel_merge_queue`, and `parallel_report` as current L0/read-only non-authority planning surfaces. M10 hardens scheduling integration; it does not make wave output gate evidence. |
| Process fact registry and contract verifier | `shipped` + `harden-existing` | `story-lifecycle.md`; `AGENTS.md` | Future process facts must extend the existing registry/verifier model before gates consume them. |
| Runtime fact registry and runtime artifact registry surfaces, including material-hash exclusions and baseline-risk inputs | `shipped` + `harden-existing` | `story-lifecycle.md`; `lifecycle-artifact-scope.md` | Keep runtime/environment/artifact facts out of the process registry while requiring future gates and doctors to consume registered tables. |
| Local review escalation and host-verdict quorum | `partial` + `harden-existing` | `story-lifecycle.md`; `three-round-two-host-review-escalation-execution-plan.md`; `lifecycle-gate-receipt-consumption.md` | Preserve threshold-triggered local escalation and diagnostic commands, then harden policy-version binding, verdict identity binding, and false-positive controls in M8/M11. |
| Authority receipt contract and lifecycle receipt consumption | `partial` + `harden-existing` | `lattice-authority-receipt-contract.md`; `lifecycle-gate-receipt-consumption.md` | Preserve current receipt subject/proof and TEST/DONE consumption baseline. Future work hardens policy, state-version, actor/runner/session, and lifecycle consumer checks; it does not let local evidence set Authority completion. |
| Baseline suites and production capability claims | `planned` | `lattice-baseline-two-host-multi-agent-execution-plan.md`; unlock-suite docs | Treat baseline reports and production claims as future proof targets only. This document and B-b5c0 produce no baseline PASS, `authorityDone`, `fullAuthorityDone`, `productionDone`, or `receiptVerified`. |
| Cross-track certification package | `planned` | This roadmap plus lower-level contracts above | M12 is final certification after implementation milestones land; B-b5c0 only names validation expectations. |

## Non-Goals

This roadmap story does not:

- implement runtime CLI gates, handlers, state machine changes, Authority
  behavior, executor loops, review escalation code, baseline runners, or
  prewrite hooks;
- alter `verificationIntent`, `verificationEvidence`, review-run, finding,
  delivery, validation, summary, or DONE semantics;
- directly edit story JSON by hand, or change product/runtime metadata outside
  the Proofbound workflow (story-scoped provenance under
  `.lattice/story/actives/B-b5c0/*` is allowed);
- claim that any future baseline has passed;
- claim `authorityDone`, `fullAuthorityDone`, `productionDone`,
  `receiptVerified`, or formal capability unlock;
- replace lower-level Authority, lifecycle, receipt, scope, or baseline
  contracts;
- use host transcripts, decision-doc prose, or documentation registration as
  gate evidence;
- expand Proofbound into a generic optimization program; future stories must fix
  real correctness issues or close named evidence gaps.

## Principles

Every implementation milestone under this roadmap must carry these principles:

```text
Do not optimize for the sake of optimization.
Do not optimize arbitrarily.
Only fix real correctness issues.
Preserve consistency of logic.
```

Additional roadmap principles:

1. **Prompt plus gate**: any process fact that affects phase, review, TEST,
   DONE, evidence freshness, or audit must have prompt guidance and a
   mechanical handler/gate backstop.
2. **No prose-as-proof**: human-readable explanations can guide operators, but
   gates consume structured facts, signatures, hashes, receipts, verdicts,
   evidence refs, and typed outcomes.
3. **Freshness wins over optimism**: tests, reviews, receipts, host verdicts,
   and baseline reports are invalidated when their material binding is stale.
4. **Scope exceptions are explicit**: later-phase scope expansion, repair, or
   fallback paths require named commands, reasons, audit events, and reviewer
   visibility.
5. **Local host evidence is not Authority**: Codex/Claude/Gemini verdicts are
   review evidence; they do not become production Authority without a separate
   receipt-backed path.
6. **Parallel work is scheduling, not completion**: a wave plan can recommend
   safe work split, but lifecycle gates decide whether work proceeds.
7. **Expected blocks are success only by contract**: `EXPECTED_BLOCK` counts as
   safety proof only when the suite defined that block and the actual blocked
   reason matches it.
8. **User-value acceptance remains final**: DONE must still explain what the
   user can observe, how to use it, and what evidence supports it.

## Roadmap Tracks

### Track A. Hard Scope Boundaries

Goal: prevent Proofbound stories from drifting across unapproved code, document,
metadata, fixture, authority, runtime, or generated-artifact boundaries.

Core product questions:

- What is this story allowed to create, modify, and test?
- Which paths are lifecycle artifacts rather than product implementation?
- When scope changes mid-flight, who acknowledged it and why?
- Did a host write outside the boundary before review or before DONE?
- Does a scope exception weaken a gate, or is it only provenance?

### Track B. Mechanical Verification And Evidence Chain

Goal: make every claim traceable from acceptance intent to fresh verification
evidence, review-run evidence, validation evidence, baseline outcome, and
receipt or host-verdict proof where applicable.

Core product questions:

- What behavior was supposed to be verified?
- Which command, browser trace, artifact, receipt, or reviewer run proved it?
- Does the proof bind to the current material?
- Does every gate consume the same registered fact rather than duplicated
  renderer logic?
- Do negative controls fail closed with named reasons?

### Track C. Collaboration And Preflight Controls

Goal: let multiple sessions, hosts, and agents work safely without duplicated
mutations, stale evidence, invisible dependencies, or overclaimed final status.

Core product questions:

- Who owns story-scoped writes?
- Which shared writes require the main lock?
- Which stories can proceed in parallel?
- Which review or validation steps must happen before TEST/DONE?
- When a second host is unavailable, is fallback explicit and lower-assurance?

## Milestone Table

| Milestone | Track | Purpose | Depends on | Primary future gate |
|---|---|---|---|---|
| M0 | All | Freeze roadmap scope, inventory sources, and define acceptance surface for future stories. | This document | PLAN/story_review |
| M1 | A | Create a canonical scope boundary model for allowed, excluded, protected, runtime, lifecycle, and generated artifact paths. | M0 | INIT_CHECK / PLAN |
| M2 | A | Harden scope guard and lifecycle artifact classification across hosts. | M1 | story_advance gates |
| M3 | A | Define explicit scope drift, repair, and fallback commands without self-signing. | M1-M2 | REVIEW / TEST |
| M4 | B | Expand process fact registry coverage for all gate-consumed facts touched by strengthening work. | M0 | static contract verifier |
| M5 | B | Standardize verification context packs and evidence envelopes for reviewers, validators, and Authority-facing flows. | M4 | REVIEW / TEST |
| M6 | B | Add negative-control and stale-evidence gate matrices for lifecycle and receipt paths. | M4-M5 | TEST / DONE |
| M7 | B | Formalize baseline suite expectations and report math for Development, Engineering, Loop Engineering, and Production Safety. | M6 | baseline suite gate |
| M8 | C | Strengthen host identity, review-run, and 3-round 2-host quorum policy. | M4-M6 | DONE escalation gate |
| M9 | C | Build a preflight command center that renders next actions from gate oracle rows. | M1-M8 | session_brief / status |
| M10 | C | Integrate parallel wave scheduling with owner leases, hotspots, dependencies, and read-only advisory reviewers. | M1, M8, M9 | dispatch/preflight |
| M11 | All | Roll out migration, compatibility, docs, and operator guidance without changing claim boundaries. | M0; finalized after M1-M10 | release readiness |
| M12 | All | Final cross-track certification and handoff package. | M1-M11 | TEST / DONE |

## Milestone Details

### M0. Scope And Source Freeze

Track: all

Purpose: create a stable, auditable base for future implementation stories.

Deliverables:

- This roadmap repaired in place for B-b5c0; NAV updates are out of scope for
  this audit repair unless a later story explicitly permits them.
- A source/context mapping that names the existing governance documents used.
- A current implementation status axis with `shipped`, `harden-existing`,
  `partial`, `planned`, and `greenfield`.
- A non-goal list that prevents future implementation stories from treating the
  roadmap as shipped behavior.
- Initial milestone IDs and track ownership language.

Gate placement:

- PLAN/story_review for future implementation stories must confirm the story
  cites this roadmap and the lower-level source documents it changes.
- REVIEW must check that the implementation story did not expand beyond its
  milestone.

Required tests or checks:

- Documentation check: `git diff --check`.
- Scope check: `git diff --name-only main...HEAD` shows only files allowed by
  the active story scope.
- Spot check: `rg -n "Current Implementation Status Axis|lattice-authority-receipt-contract|lifecycle-gate-receipt-consumption|requires3x2|Milestone-To-Rollout Stage Crosswalk" docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md`.
- TEST check when the story enters TEST: `lattice validate --story=B-b5c0`.
- Build guard: `npm --prefix packages/main run build` is required only when
  `git diff --name-only main...HEAD` includes CLI runtime inputs such as
  `packages/main/src/**`, package manifests, or TypeScript config. A doc-only
  B-b5c0 repair should record that the build guard was not applicable.
- Reviewer check: no runtime behavior is claimed as implemented by B-b5c0.

Expected evidence:

- Material/product diff changes only this document for B-b5c0.
  B-b5c0 lifecycle metadata may be present as story-scoped provenance and is
  not product/runtime material.
- Expected row/artifact ids for future validation: `M0.scope-source-freeze`,
  `M0.current-implementation-status`, `M0.source-mapping-authority-receipt`,
  `M0.source-mapping-lifecycle-receipt`, and
  `M0.execution-plan-only-boundary`.
- Future stories should reference M0 when using this roadmap as a source.

Blockers:

- Roadmap claims runtime gates already exist.
- Source mapping omits a relevant governance source or collapses conflicting
  concepts into one vague citation.
- Future story tries to implement multiple downstream milestones without a
  scope split.

DONE criteria:

- The document repair is committed as the only B-b5c0 material change.
- Required sections are present.
- The story's final response clearly states this is an execution plan only.

### Wave 1 shipped behavior

M1-M3 wave complete; M4-M12 remain follow-up milestones.

B-997b ships the hard-scope slice only:

- Scope checks now expose canonical row-shaped decisions for product source,
  docs, lifecycle metadata, runtime artifacts, fixtures, and unknown metadata.
  A normal undeclared product edit has a stable row like
  `scope.out_of_scope:src/other.ts` with `status=fail`, `blocking=true`, the
  source path, and a next action that points back to PLAN scope declaration or
  `scope_contract_acknowledge`.
- Registered lifecycle artifacts are provenance, not product scope drift. A
  current-story summary artifact is represented by
  `scope.lifecycle_artifact:B-scope:summary.json` with `status=pass` and
  `blocking=false`; it still cannot satisfy summary, delivery, review,
  validation, or DONE gates by itself.
- Registered runtime artifacts are accepted only through the runtime artifact
  registry row family `scope.runtime_artifact:*`. Unknown `.lattice`, `.lattice`,
  story metadata, source, or fixture paths continue to fall through normal scope
  enforcement and fail closed when undeclared.
- A valid DEV/REVIEW acknowledgement does not convert a scope expansion into a
  silent pass. The acknowledged `scope.out_of_scope:*` row remains `status=warn`,
  `blocking=false`, and reviewer-visible so later gates can require acceptance.
- Guard behavior reports the real host protection level: `native-pretool` only
  when a verified pre-tool hook exists, `wrapped-preapply` only in a dispatch
  pre-apply context, and `watcher-fallback` otherwise.

Local-assurance Layer 4/customer key work remains out of scope for B-997b.
Remote receipts, retired server-backed proof, baseline unlock suites,
renderer/scheduler changes, customerKeyRef behavior, and unrelated app/runtime
work remain in M4-M12 or separate follow-up stories.

### M1. Canonical Scope Boundary Model

Track: hard scope boundaries

Wave 1 status: shipped by B-997b for canonical row-shaped changed-file scope
decisions and fail-closed unknown categories. Later stories may harden policy
versioning and cross-surface rendering, but must consume this row contract.

Purpose: make the story's allowed and excluded material changes explicit before
implementation starts.

Deliverables:

- Canonical scope boundary schema for allowed creates, allowed modifies,
  allowed tests, protected files, explicit excludes, related docs, and
  authority/runtime exclusions.
- Execution boundary schema that distinguishes product code, docs, lifecycle
  metadata, runtime artifacts, generated artifacts, fixtures, and external
  authority/server work.
- PLAN-time guidance for expressing exclusions such as Authority, Layer 4,
  customerKeyRef, fixtures, direct story JSON, or runtime code.
- A single classifier table that future scope checks, guard sessions, and
  review messages consume.

Gate placement:

- INIT_CHECK must fail when required scope boundary artifacts are missing,
  stale, or contradicted by checklist wording.
- PLAN/story_review must confirm the scope reviewer can explain both included
  and excluded work.
- DEV/REVIEW gates must compare the diff against the frozen scope contract.

Required tests:

- Positive: a declared doc-only story can create the declared doc and update
  NAV.
- Positive: a declared source story can modify only the allowed source files
  and related docs.
- Negative: an undeclared runtime source edit blocks.
- Negative: an arbitrary metadata JSON file under a runtime-like directory
  blocks unless registered.
- Negative: a direct story JSON or fixture edit blocks unless the story's
  explicit fixture maintenance policy allows the operation through the CLI.

Expected evidence:

- Schema fixture or focused smoke proving each path class.
- Process event or artifact hash showing the boundary was frozen before DEV.
- Reviewer pass confirming the boundary is readable by a human operator.

Blockers:

- Scope model exempts a whole directory such as `.lattice/`, `.lattice/`, or
  `docs/` without filename-aware classification.
- Scope gate and renderer duplicate rules instead of sharing one classifier.
- Missing exclusions are treated as advisory for high-risk stories.

DONE criteria:

- Every material changed path is explainable by one scope category.
- Unknown categories fail closed.
- Operators can see the next action when a path is out of scope.

### M2. Scope Guard And Lifecycle Artifact Hardening

Track: hard scope boundaries

Wave 1 status: shipped by B-997b for lifecycle/runtime artifact classification,
guard capability labels, and scope gate rows. Later stories may add broader
oracle rendering, but must not reintroduce blanket directory exemptions.

Purpose: make scope violations visible and blocking across hosts while
truthfully reporting each host's protection level.

Deliverables:

- Guard session behavior aligned with host capability:
  `active` only when a real pre-tool hook exists, `watcher-fallback` otherwise.
- Lifecycle artifact classifier that recognizes only registered story-scoped
  filenames and relative evidence paths.
- Runtime artifact classifier backed by the runtime artifact registry, not a
  blanket directory exemption.
- Scope gate rows with stable ids, statuses, details, hints, sources, and
  blocking flags.

Gate placement:

- `story_advance` gates re-run guard checks before leaving DEV, REVIEW, TEST,
  or DONE-sensitive states.
- `doctor` reports active guard sessions and hook mismatch.
- DONE pre-check includes any scope violation row before suggesting merge.

Required tests:

- Active hook missing: report watcher-level or active-misconfigured state
  without claiming prewrite interception.
- Watcher fallback violation: forbidden file appears in diff, check records it,
  lifecycle advancement blocks.
- Lifecycle artifact positive: registered delivery/summary/review artifacts do
  not create product scope violations.
- Lifecycle artifact negative: nearby arbitrary files such as unregistered
  `evidence/notes.md` or unknown metadata files still block.
- Renderer contract: status/session_brief displays rows from the oracle rather
  than reimplementing scope logic.

Expected evidence:

- Guard session JSON or process event bound to story id, host provider,
  material hash, and violation list.
- Focused smoke output proving positive and negative classifier cases.
- `doctor` output or JSON showing hook status.

Blockers:

- Codex/Gemini/headless flows are reported as prewrite-blocking when they are
  watcher fallback.
- Lifecycle artifact classification becomes a substitute for gate receipts.
- Clearing a violation requires editing metadata by hand instead of removing the
  file or acknowledging a real scope expansion.

DONE criteria:

- The same diff receives the same pass/block classification regardless of host.
- Protection timing is accurately reported.
- A story cannot proceed while current guard violations remain.

### M3. Explicit Scope Drift, Repair, And Fallback Paths

Track: hard scope boundaries

Wave 1 status: shipped by B-997b for DEV/REVIEW acknowledgement visibility and
lower-assurance fallback labeling. Later stories may add reviewer automation or
quorum integration, but acknowledgement remains repair evidence, not a PLAN
scope replacement.

Purpose: allow necessary mid-flight changes without converting exceptional
repair into invisible normal behavior.

Deliverables:

- DEV/REVIEW scope acknowledgement command for necessary later-phase scope
  expansion, distinct from PLAN scope review.
- Repair command patterns that require explicit reason, phase policy, dry-run
  output where practical, and audit events.
- Fallback policy for environments that cannot spawn a reviewer or second host,
  with visible lower assurance.
- Reviewer prompts and handler checks that forbid self-signing reviewer-only
  evidence by the main implementation agent.

Gate placement:

- PLAN `scope_check_save` remains PLAN reviewer evidence and is not replaced by
  later `scope_contract_acknowledge`.
- DEV/REVIEW may record later scope acknowledgement only when the story truly
  changes scope and the reason is visible.
- TEST/DONE consume the current scope contract plus acknowledgement state.

Required tests:

- Late scope expansion without acknowledgement blocks.
- Late scope expansion with valid acknowledgement becomes review-visible and
  still requires reviewer acceptance.
- Missing reviewer evidence cannot be self-signed by an implementer.
- Repair path refuses terminal stories and malformed evidence refs.
- Fallback mode output is distinguishable from independent reviewer evidence.

Expected evidence:

- Audit event with story id, phase, reason, operator/session, head hash,
  material hash, and affected paths/items.
- Reviewer pass or finding over the acknowledged expansion.
- Negative-control transcript showing self-signing is rejected.

Blockers:

- A fallback silently produces the same assurance label as independent review.
- A repair command overwrites authored intent or scope without explicit replace
  semantics.
- A later-phase acknowledgement is used to avoid returning to PLAN when the
  scope change is broad enough to invalidate the plan.

DONE criteria:

- Every exceptional scope movement has a named command, reason, and audit trail.
- Normal stories still follow PLAN scope review before DEV.
- Repair and fallback paths do not weaken future story discipline.

### M4. Process Fact Registry Coverage

Track: mechanical verification and evidence chain

Follow-up status: M4 starts the post-wave-1 roadmap and is not part of B-997b.

Purpose: ensure every gate-consumed fact has a typed registry entry and a
contract verifier, so prompt wording cannot drift away from runtime behavior.

Deliverables:

- Registry entries for any new or modified process facts introduced by M1-M12.
- Synchronized `COMMAND_POLICIES`, process fact levels, reviewer lane
  definitions, artifact semantics, and required semantic facts.
- Static verifier updates that fail with specific messages for missing registry
  entries, mismatched levels, or unregistered gate artifacts.
- Clear boundary between process facts, runtime environment facts, and runtime
  artifact paths.

Gate placement:

- Build/test preflight for any implementation story touching gates, handlers,
  reviewer lanes, validation, receipts, or lifecycle artifacts.
- REVIEW must inspect registry and verifier diffs for process-framework work.

Required tests:

- `node scripts/verify-process-fact-contract.mjs` or successor focused verifier.
- Runtime fact verifier when runtime/environment facts are touched.
- Runtime artifact verifier when artifact path classifiers change.
- Negative: a new gate-consumed command or artifact without registry coverage
  fails the verifier.

Expected evidence:

- Verifier output stored in `verificationEvidence` for each future
  implementation checklist item.
- Source refs to the registry rows and the consuming gate.
- Review pass from coverage lane confirming no process fact was prose-only.

Blockers:

- A new gate consumes a JSON file that is not registered.
- A prompt says a reviewer must do something but handler/gate accepts missing,
  malformed, unsigned, or stale data.
- Runtime artifacts are mixed into process fact registry.

DONE criteria:

- Every new process fact has prompt guidance, runtime validation, and static
  contract coverage.
- Registry failure messages point at the missing or mismatched fact directly.
- No gate relies on free-form text such as "checked" or "looks good".

### M5. Verification Context Pack And Evidence Envelope Standardization

Track: mechanical verification and evidence chain

Purpose: give reviewers and validators the same bounded, digest-backed context
and require evidence to cover the refs it claims to prove.

Deliverables:

- Context pack creation and expansion policy for changed files, hunks, symbols,
  checklist ids, verification refs, oracle refs, commands, risk tags, limits,
  and parent digest.
- Evidence envelope fields for command, output digest, artifact digest, story
  id, item id, intent refs, material hash, head hash, producer, timestamp, and
  covered refs.
- Reviewer prompt requirements to inspect the context pack or explicitly request
  an expansion with a reason.
- Authority-facing mapping for context pack id/digest and evidence envelope
  fields where a future Authority story uses them.

Gate placement:

- REVIEW consumes reviewer-run evidence that names the context pack digest or
  equivalent material binding.
- TEST consumes verification evidence and validation evidence bound to current
  material.
- Authority-facing gates consume receipt/evidence refs only in future Authority
  implementation stories.

Required tests:

- Context pack includes deletions with readable removed-line context.
- Context expansion requires `expansionReason` and parent digest.
- Evidence without required covered refs is insufficient.
- Stale material hash makes previously valid evidence stale.
- Reviewer run over wrong head/material is rejected or marked stale.

Expected evidence:

- Context pack digest and evidence envelope digest in process events or
  validation output.
- Test command output proving stale and missing coverage cases.
- Reviewer pass with context pack refs.

Blockers:

- Reviewer can pass without inspecting the diff or acknowledging the bounded
  context.
- Evidence envelope omits material binding.
- Expansion bypasses token/context limits instead of forming a parent-linked
  chain.

DONE criteria:

- Verifier evidence is traceable to exactly what was reviewed or tested.
- Stale, partial, or unbound evidence cannot satisfy the future gate.
- Context pack behavior remains host-neutral.

### M6. Gate Oracle, Freshness, And Negative-Control Matrix

Track: mechanical verification and evidence chain

Purpose: make lifecycle gates and status renderers consume one oracle result,
and prove fail-closed behavior with expected-block negative controls.

Deliverables:

- Stable row contract for gate oracle output: id, status, detail, hint, source,
  blocking, and freshness metadata.
- Negative-control matrix covering scope bypass, stale evidence, missing
  verification intent, malformed evidence refs, fake review pass, stale
  reviewer run, fake receipt, wrong material, wrong project, local-only
  authority, and duplicate host identity.
- `EXPECTED_BLOCK` result shape for safety cases that should block rather than
  pass.
- Policy that renderers may not duplicate gate rules.

Gate placement:

- REVIEW uses oracle rows for reviewer/pass/finding readiness.
- TEST uses oracle rows for validation and verification coverage.
- DONE uses oracle rows for summary, delivery, freshness, review escalation,
  main sync, dirty state, and scope.

Required tests:

- Positive: all required evidence fresh yields pass rows.
- Negative: each matrix case fails closed with the expected row id.
- Renderer: `session_brief`, `status`, `next`, and DONE pre-check display the
  same row result.
- No false pass: a local transcript cannot set Authority status.

Minimum validation commands and expected rows:

| Command | Expected artifact or row ids |
|---|---|
| `git diff --name-only main...HEAD` | Material input list for the matrix run; runtime/story artifacts must be classified through registries, not blanket path exemptions. |
| `git diff --check` | Clean documentation/source diff before matrix evidence is accepted. |
| `npm --prefix packages/main run build` | Required for M6 implementation stories that touch CLI runtime inputs; build output is referenced by `M6.build.runtime-fresh`. |
| `lattice validate --story=<storyId>` | Validation evidence rows `M6.validation.fresh`, `M6.validation.stale-evidence`, and `M6.validation.expected-blocks-recorded`. |
| `lattice review_escalation_status --storyId=<storyId>` | Read-only projection row `M6.review-escalation.local-only-not-authority`; must not consume or create Authority receipt facts. |
| `node packages/main/dist/tasks/authority-gate-receipts-smoke.js` | Receipt/ref eligibility rows `M6.receipt.fake-blocked`, `M6.receipt.wrong-story-blocked`, `M6.receipt.wrong-material-blocked`, `M6.receipt.stale-blocked`, `M6.receipt.future-blocked`, and `M6.receipt.tamper-blocked`. |
| `node packages/main/dist/tasks/authority-gate-consumption-smoke.js` | Gate consumption rows `M6.receipt.eligible-consumed`, `M6.receipt.eligible-not-consumed`, `M6.receipt.local-transcript-blocked`, `M6.receipt.stale-blocked`, and `M6.receipt.wrong-material-blocked`. |
| `node packages/main/dist/tasks/authority-completion-smoke.js` | DONE projection rows `M6.receipt.fake-blocked`, `M6.receipt.wrong-story-blocked`, `M6.receipt.stale-blocked`, `M6.receipt.future-blocked`, and `M6.receipt.tamper-blocked`; local/non-Authority completion must remain non-Authority status only. |

Expected evidence:

- Machine-readable test matrix report.
- `verificationEvidence` records for each expected block.
- Reviewer finding/pass evidence confirming the matrix covers edge and
  adversarial cases.
- The matrix report must name row ids rather than only free-form prose. A
  seeded `EXPECTED_BLOCK` counts as success only when the row id and blocked
  reason match the suite definition.

Blockers:

- Gate and renderer disagree.
- An expected block is converted into PASS for convenience.
- Negative controls exist only in prose and cannot be replayed.

DONE criteria:

- Every high-risk future gate has at least one positive control and one
  negative control.
- Expected-block outcomes name why they blocked.
- A false DONE seeded case remains blocked.

### M7. Baseline Suite Formalization

Track: mechanical verification and evidence chain

Purpose: align future baseline work with explicit capability boundaries,
success-rate math, and negative-control expectations.

Deliverables:

- Baseline taxonomy for Development, Engineering, Loop Engineering / UDM, and
  Production Safety.
- Outcome enum policy: `PASS`, `FAIL`, `EXPECTED_BLOCK`, `ESCALATED`, and suite
  `BLOCKED` where appropriate.
- Required artifact schemas for baseline inputs, story/checklist, planned
  steps, evidence index, gate results, host verdicts, receipts, final reports,
  and success-rate reports.
- Success-rate calculation policy including false DONE count and Wilson lower
  bound where sample sizes matter.
- Claim boundary templates that state exactly what the baseline does and does
  not prove.

Gate placement:

- Future baseline implementation stories may use local diagnostic runs for
  preflight, but formal unlock claims require the defined proof chain.
- REVIEW verifies the baseline report does not broaden the claim.
- DONE consumes only fresh baseline evidence for the selected target.

Required tests:

- Development baseline: simple task PASS with scope/evidence/review.
- Engineering baseline: multi-file, bugfix, regression, risk-sensitive
  security/data/frontend cases as applicable.
- Loop Engineering baseline: planner, executor, repair loop, review loop,
  evidence gate, budget stop, human handoff, no false DONE.
- Production Safety baseline: live Authority, customer key, actor/session,
  evidence binding, receipt, lifecycle consumption, fake/stale/local-only
  negative controls.
- Report math: false DONE count greater than zero forces suite failure.

Expected evidence:

- Per-baseline final report with head hash, material hash, expected outcome,
  actual outcome, evidence refs, host verdict refs, receipt refs where required,
  falseDone=false, and claim target.
- Suite report with computed rates, exclusions, and blocked reasons.

Blockers:

- Baseline report claims arbitrary capability from a narrow sample.
- `INVALID` exclusions lack setup-failure proof.
- Local-only diagnostic output is aggregated as formal proof.
- Expected blocks are accepted without checking the actual block reason.

DONE criteria:

- Baseline implementation stories can prove or block selected classes without
  overclaiming.
- Capability unlocks remain locked unless their exact suite proof exists.
- Negative-control expectations are explicit before execution starts.

### M8. Host Identity, Review-Run, And 3x2 Quorum Strengthening

Track: collaboration and preflight controls

Purpose: make independent review evidence meaningful and prevent duplicate,
stale, or self-certified host verdicts from satisfying high-risk final gates.

Mechanical trigger predicate:

```text
requires3x2 =
  firstReviewRoundCountableProblems >= 2
  || explicitlyConfiguredHighRiskPolicyRequires3x2
```

`firstReviewRoundCountableProblems` is the count of first lifecycle REVIEW
round findings that satisfy the countable-problem definition from
`three-round-two-host-review-escalation-execution-plan.md`: reviewer-lane,
`critical|high|medium`, verified or legacy-missing `evidenceState`, and not
suspected, disproven, low, pass-only, non-reviewer, or later-round feedback.

`explicitlyConfiguredHighRiskPolicyRequires3x2` may be true only when a
structured policy/fact exists before the DONE evaluator consumes it. The fact
must be registry-backed or otherwise machine-verifiable and must bind:

- `policyVersion`;
- story id;
- milestone id or risk class;
- source policy ref;
- effective rollout stage;
- whether degraded single-host fallback is allowed for that risk class;
- material/head freshness expectations;
- issuer/approver identity and timestamp.

Transcript text, reviewer prose, decision-doc prose, or a changed file path by
itself cannot set this boolean. A policy change introduced after a story has
already passed PLAN follows the in-flight story rules in M11, as staged by
`Rollout Strategy` / `Milestone-To-Rollout Stage Crosswalk`: it may be advisory,
require explicit opt-in/replan, or require an audited emergency operator
decision, but it must not silently mutate the DONE requirement.

Deliverables:

- Shared host independence predicate covering host id, provider, session id,
  key id or identity digest, verdict id, run/wave id, prompt digest, artifact
  digest, head hash, material hash, validation digest, signature, and issue
  time.
- Review-run binding policy for reviewer lanes and coverage reviewer lanes.
- 3-round 2-host quorum artifact or status projection for escalated stories and
  high-risk process-framework milestones.
- Degraded single-host fallback fields: eligibility, reason, evidence refs or
  approval ref, fresh material binding, and lower-assurance labels.
- Local counted verdict predicate requiring host/session/key/material/
  validation/prompt binding and a valid canonical payload signature over the
  canonical verdict payload. Registry-backed identity/key material may verify
  signer/key provenance for that signature, but it cannot substitute for the
  signature or the signed material binding.

Gate placement:

- REVIEW remains responsible for ordinary findings and review passes.
- TEST refreshes validation evidence and exposes escalation status.
- DONE is the hard 3x2 enforcement point when escalation or high-risk policy
  requires it.

Required tests:

- Duplicate host id in a round is rejected.
- Shared session id is rejected.
- Shared key/identity digest is rejected.
- Missing signed material binding is rejected even when registry-backed
  identity/key material is present.
- Stale validation digest is rejected after TEST changes material.
- Degraded fallback cannot be reported as full two-host independence.
- Local host verdict cannot set Authority facts.
- Authority-backed receipt or Authority runner identity cannot set local
  `requires3x2`, `quorumResult`, `reviewEscalationComplete`, DONE, or degraded
  fallback fields. It can be consumed only through the lifecycle receipt
  predicate for Authority-backed gates.

Minimum validation commands and expected rows:

| Command | Expected artifact or row ids |
|---|---|
| `git diff --name-only main...HEAD` | Material input list used to decide whether M8 runtime build checks apply. |
| `git diff --check` | Clean diff before host-verdict artifacts are accepted. |
| `npm --prefix packages/main run build` | Required for M8 implementation stories that touch CLI runtime inputs; referenced by `M8.build.runtime-fresh`. |
| `lattice validate --story=<storyId>` | Current validation digest for counted verdicts; rows `M8.validation.current` and `M8.validation.stale-verdict-ignored`. |
| `lattice review_escalation_status --storyId=<storyId>` | Rows `M8.requires3x2.first-round-threshold`, `M8.requires3x2.explicit-high-risk-policy`, `M8.quorum.pass-full-3x2`, `M8.quorum.pass-degraded-3x1`, `M8.quorum.blocked`, and local diagnostic `voluntaryLocalRounds` when verdicts exist but escalation is not required. |
| `lattice autopilot_review_status --storyId=<storyId>` | Host-verdict inventory rows `M8.verdict.counted`, `M8.verdict.ignored-stale`, `M8.verdict.ignored-duplicate-host`, `M8.verdict.ignored-same-session`, `M8.verdict.ignored-same-key`, `M8.verdict.ignored-missing-signature`, and `M8.verdict.ignored-prompt-unbound`; local all-runs/latest-runs summaries are diagnostic visibility only. |
| `lattice decision_doc_quorum_check --storyId=<storyId>` | Diagnostic-only row `M8.decision-doc.diagnostic-only`; direct decision-doc edits do not set `requires3x2` unless the threshold or explicit policy predicate is true. |

Expected evidence:

- Host verdict events or artifacts with signed canonical payload digests.
- Quorum status showing full, degraded, or blocked result.
- Ignored-verdict reasons for stale, duplicate, failed, blocked, missing, or
  non-independent verdicts.
- Stale-material DONE runbook text that names stale local host verdicts and
  shows the local commands to rerun validation, refresh stale verification
  evidence, and resubmit local host verdicts over the current material hash.
- Policy-version binding for any explicit high-risk 3x2 requirement.

Blockers:

- Independence is inferred from host name alone.
- Fallback is silently inferred from missing host evidence.
- A single host can satisfy an independent-host requirement without explicit
  degraded policy.

DONE criteria:

- Full 3x2 means three fresh rounds with two independent PASS hosts per round.
- Degraded 3x1 is labeled lower assurance and accepted only where policy allows.
- Review escalation remains threshold-triggered, not documentation-triggered.
- Local all-runs/latest-runs, voluntary round summaries, and stale-material
  runbooks are diagnostic UX only; they do not create remote proof, Authority
  receipt evidence, or production/DONE completion claims.

### M9. Preflight Command Center

Track: collaboration and preflight controls

Purpose: make `session_brief`, `status`, `next`, and related surfaces show the
actual gate state and next action without relying on agent memory.

Deliverables:

- Shared preflight projection from lifecycle state, owner lease, scope rows,
  guard rows, review rows, validation rows, escalation rows, baseline rows, and
  main sync/dirty state.
- Phase-aware next-action renderer that never says validation pass means DONE
  when DONE rows still block.
- Story ownership block that distinguishes owner, foreign active owner, stale
  lease, takeover available, and read-only-only contexts.
- Advisory vs blocking separation for docs, relatedDocs, parked backlog, and
  parallel-wave guidance.

Gate placement:

- Read-only surfaces do not mutate story state.
- Mutating surfaces continue to acquire owner lease or main lock before writes.
- Preflight output is advisory unless it is rendering a gate oracle blocking
  row from the underlying gate.

Required tests:

- DEV pass hints commit + REVIEW, not TEST/DONE.
- REVIEW pass hints TEST only after blockers resolve.
- TEST validation pass still shows any DONE pre-check blockers.
- Foreign active lease produces read-only/wait guidance.
- Stale lease suggests takeover, not silent mutation.
- B-META/shared audit state does not suggest story advancement.

Expected evidence:

- Snapshot or smoke output for each phase.
- Owner-lease fixture output for owner, active foreign, and stale foreign cases.
- Oracle row id parity between status surfaces.

Blockers:

- Renderer encodes its own gate rules.
- Read-only status command writes lifecycle artifacts.
- Preflight hides a blocking row behind a green summary.

DONE criteria:

- Operators can recover context from one command.
- Next action is phase-aware and evidence-aware.
- Preflight cannot accidentally advance lifecycle or claim completion.

### M10. Parallel Collaboration Scheduling

Track: collaboration and preflight controls

Purpose: allow safe parallel work while keeping scheduling guidance separate
from lifecycle, review, validation, and Authority evidence.

Deliverables:

- Parallel wave integration that reads active story refs, dependencies,
  hotspots, changed-file projections, owner leases, host capabilities, and
  evidence lineage.
- Dispatch recommendations that say `implementer`, `planner`, or `blocked`
  without auto-spawning runners.
- Merge queue guidance that accounts for dependencies, shared hotspots, main
  write lock, and process-framework combination review needs.
- Read-only advisory reviewer mode for external reviewers who must not acquire
  owner leases or write lifecycle evidence.

Gate placement:

- Parallel wave commands remain L0/read-only planning unless explicitly
  writing caller-requested local output.
- Story-scoped mutating commands still require story owner lease.
- Main/shared mutating commands still require main write lock.
- Process-framework parallel stories trigger merged-state combination review
  after merge through normal story flow.

Required tests:

- Parallel plan degrades stories with active dependencies.
- Hotspot overlap blocks or degrades parallel DEV recommendation.
- Dirty worktree projection excludes only registered runtime/story metadata,
  not arbitrary files.
- Read-only reviewer mode rejects mutating commands before owner lease or hooks.
- Dispatch output keeps `spawned=false` and requires runner confirmation.

Expected evidence:

- Parallel wave/report JSON with authority fields set to non-authoritative
  values.
- Host capability probe evidence when used for scheduling.
- Combination review record for applicable process-framework merges.

Blockers:

- Wave artifact is consumed as DONE, receipt, or production evidence.
- Dispatch auto-spawns a runner without explicit runner confirmation.
- Parallel merge guidance bypasses lifecycle gates.

DONE criteria:

- Parallel work is safer to schedule but not easier to overclaim.
- Scheduling output names blockers and degradations.
- Mutating authority remains with lifecycle commands, owner leases, and locks.

### M11. Rollout, Migration, And Operator Guidance

Track: all

Purpose: introduce strengthened controls without breaking existing readable
stories, legacy migrations, or low-risk documentation work.

Deliverables:

- Rollout stages for docs-only, diagnostic-only, advisory, fail-closed in new
  stories, and migration/backfill for legacy stories.
- Milestone-to-rollout stage crosswalk that names `policyVersion`,
  enforcement mode, in-flight story treatment, and expected operator-visible
  evidence.
- Compatibility policy for legacy missing fields, old story metadata, old host
  verdicts, and historical baseline artifacts.
- False-positive rollback/de-escalation policy for advisory rows, local review
  escalation, and new blockers.
- Operator runbooks for common blocked states: out-of-scope path, stale
  evidence, stale-material local host verdicts, missing verification intent,
  missing scope check, foreign lease, main lock contention, missing second host,
  baseline expected block, and fake receipt.
- Staged runbook and repair dry-run prerequisites before any new blocker moves
  from advisory to fail-closed.
- Audited emergency bypass for self-hosting over-block, limited to local
  lifecycle progress and never usable for Authority, receipt, or production
  claims.
- NAV and docs updates for every new decision or contract.

Gate placement:

- Migration commands must be explicit, audited, phase-aware, and dry-run where
  practical.
- Legacy compatibility should preserve readability but must not create new pass
  conditions that bypass current gates.
- Rollout stories that touch process facts or lifecycle gates require stronger
  review before DONE.

Required tests:

- Legacy story remains readable.
- Legacy missing field is normalized only where the existing compatibility rule
  says so.
- New story fails closed under the strengthened policy.
- Migration dry-run reports proposed changes without writing.
- Operator runbook examples match current command help.
- False-positive de-escalation preserves the original row and writes an audit
  reason instead of deleting the evidence.
- Emergency bypass expires by policy version or time window and cannot set
  `authorityDone`, `fullAuthorityDone`, `productionDone`, or `receiptVerified`.

Expected evidence:

- Migration report, dry-run output, or compatibility matrix.
- User-facing command transcript for each runbook path.
- Stale-material recovery transcript showing
  `lattice validate --story=<storyId> --json`,
  `lattice verification_evidence_refresh_stale --storyId=<storyId> --dryRun`,
  and fresh `lattice autopilot_review_submit ... --materialDigest=<current-materialHash>`
  without suggesting a stale-material bypass.
- Reviewer pass confirming no overclaim or authority boundary drift.
- Policy-version binding report showing the active rollout stage and treatment
  for in-flight stories.
- Emergency bypass audit event when and only when self-hosting over-block forces
  a local temporary unblock.

Blockers:

- Migration silently edits story JSON or fixture files.
- Rollout breaks old stories without a repair path.
- Docs describe commands or schemas that do not exist in the selected release.
- A policy-version change silently changes DONE requirements for stories already
  past PLAN/DEV/REVIEW without advisory output, explicit opt-in, or audited
  operator decision.
- A repair command has no dry-run path before fail-closed enforcement.

DONE criteria:

- Existing operators can understand what changed and what did not.
- Legacy exceptions are visible and bounded.
- Future stories know which rollout stage they are implementing.
- Any temporary bypass is visible, scoped, expiring, and excluded from Authority
  or production claims.

### M12. Cross-Track Certification And Handoff

Track: all

Purpose: prove that the strengthened system works as a system, not as isolated
locally-correct pieces.

Deliverables:

- Cross-track scenario matrix that combines scope boundary, evidence chain,
  review quorum, baseline result, owner lease, and preflight output.
- Final handoff package listing changed contracts, commands, gates, tests,
  baselines, known limitations, and follow-up stories.
- User-value acceptance transcript explaining what an operator now sees and how
  to use it.
- Final claim boundary that states exactly which controls are implemented and
  which remain future work.

Gate placement:

- TEST runs the cross-track validation suite.
- REVIEW checks interactions among scope, evidence, collaboration, and renderer
  behavior.
- DONE checks user-value acceptance, delivery, freshness, review escalation, and
  main sync.

Required tests:

- Happy path: scoped story completes through REVIEW, TEST, and DONE with fresh
  evidence and correct preflight.
- Scope adversarial: undeclared source change blocks before review or DONE.
- Evidence adversarial: stale or missing evidence blocks.
- Collaboration adversarial: non-owner mutation blocks.
- Quorum adversarial: duplicate host/session/key cannot satisfy 3x2.
- Baseline adversarial: seeded false DONE remains `EXPECTED_BLOCK` or `FAIL`.

Minimum validation commands and expected rows:

| Command | Expected artifact or row ids |
|---|---|
| `git diff --name-only main...HEAD` | Final material inventory, attached to `M12.material.final-inventory`. |
| `git diff --check` | Final whitespace/doc hygiene row `M12.diff.clean`. |
| `npm --prefix packages/main run build` | Required for any cross-track certification that touched CLI runtime inputs; row `M12.build.runtime-fresh`. |
| `lattice validate --story=<storyId>` | Final validation evidence rows `M12.validation.pass`, `M12.validation.stale-block`, and `M12.validation.coverage-complete`; for B-b5c0 this pairs with `review_escalation_status` to expect `M12.receipt.not-authority-required`, not an Authority receipt. |
| `lattice review_escalation_status --storyId=<storyId>` | Final local review assurance rows `M12.review.full-3x2`, `M12.review.degraded-3x1`, or `M12.review.not-required`; for non-Authority stories this status artifact is the source of `M12.receipt.not-authority-required`. |
| `lattice autopilot_review_status --storyId=<storyId>` | Host-verdict inventory row `M12.host-verdicts.bound-and-fresh`; ignored reasons must match M8. |
| `lattice decision_doc_quorum_check --storyId=<storyId>` | Diagnostic row `M12.decision-doc.diagnostic-only` when decision docs changed; it must not contradict `review_escalation_status`. |
| `node packages/main/dist/tasks/authority-gate-receipts-smoke.js` | Authority-required receipt/ref verification rows `M12.receipt.consumed`, `M12.receipt.stale-block`, and `M12.receipt.wrong-material-block`; not used to satisfy B-b5c0 because B-b5c0 is not Authority-required. |
| `node packages/main/dist/tasks/authority-gate-consumption-smoke.js` | Authority-required gate-consumption rows `M12.receipt.consumed`, `M12.receipt.stale-block`, and `M12.receipt.not-eligible-block`; B-b5c0 instead expects `M12.receipt.not-authority-required` from `review_escalation_status`/validate. |

Expected evidence:

- Cross-track suite report.
- Host verdict summary for high-risk implementation stories.
- User-value summary and delivery check refs.
- Final handoff document or report.
- Policy-version and rollout-stage summary proving the final certification used
  the intended enforcement mode.

Blockers:

- Two locally correct milestones combine into a global gate hole.
- Final summary omits what the user can actually do.
- A repair after final review changes material without fresh validation and
  fresh host verdicts.

DONE criteria:

- Cross-track proof passes or blocks honestly.
- No seeded false DONE reaches DONE.
- The final claim is limited to implemented, tested, and fresh controls.

## Sequencing

Recommended order:

1. **M0 first**: keep this roadmap and source mapping stable.
2. **M1-M3 before broad implementation**: scope contracts and repair/fallback
   paths must be clear before teams change evidence and collaboration gates.
3. **M4 before any new gate fact**: process fact registry coverage must precede
   gate-consuming implementation.
4. **M5-M6 before baselines and quorum hardening**: evidence shape, context
   binding, oracle rows, and negative controls are prerequisites.
5. **M7 after M6**: baseline suites should consume the same expected-block and
   evidence-freshness concepts.
6. **M8 after M5-M6**: host verdicts and 3x2 quorum need evidence and
   freshness contracts.
7. **M9 after the first oracle rows exist**: preflight should render canonical
   rows rather than invent rules.
8. **M10 after M1, M8, and M9**: scheduling can safely use scope, review
   assurance, and preflight projections. M8 is explicit because M10 may render
   host capability and reviewer-mode guidance, but its output remains
   non-authoritative.
9. **M11 begins at M0 and finalizes after M1-M10**: runbooks, compatibility
   notes, and dry-runs can be drafted early, but fail-closed rollout cannot
   advance ahead of the milestones it enforces.
10. **M12 last**: cross-track certification should run only after material
   implementation has settled.

Serial dependencies:

- M4 is a hard prerequisite for any milestone that introduces new gate-consumed
  process facts.
- M6 is a hard prerequisite for any final claim that depends on fail-closed
  negative controls.
- M8 is a hard prerequisite for high-risk final 3x2 claims.
- M12 must rerun if any material fix lands after final host validation.

## Parallelization Rules

Parallel implementation is allowed only when it preserves ownership,
dependencies, and write-scope separation.

| Parallel area | Allowed concurrency | Join condition |
|---|---|---|
| M1 scope schema and docs | One schema owner plus one docs/reviewer lane | Shared schema names frozen before gate code begins. |
| M2 guard/classifier tests | Host-specific test owners may work in parallel | Classifier table is shared; no host invents its own category names. |
| M4 registry/verifier | One registry owner only | Other milestones wait for the registry contract before adding facts. |
| M5 evidence/context pack | Context pack and envelope owners may work in parallel | Digest and covered-ref fields frozen before integration. |
| M6 negative controls | Multiple test owners may author cases | All cases report through one oracle row contract. |
| M7 baselines | Layer-specific owners may prepare suites | Outcome enums and report schema frozen first. |
| M8 host quorum | Host verdict producer and evaluator owners may work in parallel | Independence predicate and signature payload fields frozen first. |
| M9 preflight | Renderer owners may work in parallel | Renderers consume only canonical oracle rows. |
| M10 parallel wave | Scheduling owner may work while lifecycle work continues | Output remains read-only/non-authoritative. |

Rules for all parallel work:

- Each agent declares milestone, files, commands, and evidence before editing.
- No two agents edit the same shared predicate, schema, or registry without one
  named owner.
- Story-scoped mutations require the story owner lease.
- Main/shared mutations require the main write lock.
- Advisory reviewers use read-only mode and do not acquire leases.
- Parallel wave output is scheduling guidance only.
- If two process-framework stories merge in the same window, run a read-only
  merged-state combination review before claiming the combined system safe.

## 3-Round 2-Host Validation Policy

This policy applies to future implementation stories under this roadmap only
through the M8 mechanical predicate:

```text
requires3x2 =
  firstReviewRoundCountableProblems >= 2
  || explicitlyConfiguredHighRiskPolicyRequires3x2
```

The following risk classes are candidates for
`explicitlyConfiguredHighRiskPolicyRequires3x2`, but they do not set it merely
by appearing in prose or in a changed-file list. A story requires 3x2 through
the high-risk policy branch only when the project/story policy records a
registry-backed, policy-versioned fact for the story, milestone, or risk class:

- lifecycle phase gates or state transitions;
- process fact registry, command policy, reviewer lane, review pass/finding,
  delivery, validation, summary, or DONE semantics;
- Authority receipt, production safety, or receipt-consumption behavior;
- host independence, 3x2 quorum, degraded fallback, or review escalation;
- broad scope guard/classifier behavior;
- baseline unlock claim evaluators or false-DONE controls.

Direct documentation or decision-doc edits are diagnostic context, not an
automatic trigger. `decision_doc_quorum_check` may report that context, but the
hard DONE requirement comes from `review_escalation_status` and the predicate
above.

Default shape:

```text
3 bounded rounds
x 2 independent PASS hosts per round
over the same fresh anchors
before final high-risk DONE or final capability claim
```

Fresh anchors per round:

- story id and milestone id;
- changed files and relevant source refs;
- checklist and verification intent;
- current head hash and material hash;
- relevant context pack digest;
- commands/tests run and their output refs;
- validation evidence and baseline report refs when available;
- receipt refs when Authority is in scope;
- host verdict refs from previous rounds where relevant;
- known blockers, repairs, and stale evidence state.

Round focus:

1. **Round 1: scope and product correctness**. Does the implementation solve
   the real gap and stay within the milestone boundary?
2. **Round 2: mechanical alignment**. Do handler, registry, gate, evidence,
   tests, docs, and prompts agree?
3. **Round 3: final closure**. Are validation, negative controls, host verdicts,
   baseline results, and final claim wording fresh and consistent?

Host independence minimum for counted full 3x2 verdicts:

- distinct host id;
- distinct session id;
- distinct key id or identity digest;
- signed canonical verdict payload with a verified canonical payload signature;
- registry-backed identity/key material may verify signer/key provenance for
  that signature, but cannot replace the signature or signed material binding;
- same current head, material, validation, and prompt binding;
- PASS decision;
- no duplicate verdict id.

Counted local verdicts are structured process evidence. A transcript, prose
review, unbound local identity, or Authority receipt ref cannot be counted as a
local host verdict unless a local host-verdict artifact also satisfies the
predicate above. Authority-backed receipts and Authority runner identities are
consumed only by the lifecycle receipt-consumption predicate; they do not set
local completion, quorum, fallback, `authorityDone`, `fullAuthorityDone`,
`productionDone`, or `receiptVerified` fields.

Degraded single-host fallback:

- allowed only when project policy permits it and eligibility is explicit:
  `single-host-environment`, `temporary-host-unavailability`, or
  `explicit-human-approval`;
- requires reason plus evidence refs or approval ref;
- requires three fresh rounds with at least one PASS host;
- must report `assuranceLevel=degraded-single-host`;
- must not satisfy checks that require independent two-host proof;
- must never imply Authority receipt completion.

Documentation-only changes:

- Routine typo, annotation, wording, or NAV-only changes follow ordinary REVIEW
  unless the first REVIEW round triggers escalation or the story is explicitly
  classified as high-risk process-framework work.
- Decision documents that define future gate/process behavior should still
  receive strong review before downstream implementation relies on them.

## Baseline And Negative-Control Expectations

This roadmap expects future implementation stories to prove both positive
capability and fail-closed safety. The following expectations are not proof from
B-8b07 or B-b5c0; they are acceptance targets for later stories.

### Baseline PASS Expectations

| Suite area | Expected future PASS proof |
|---|---|
| Development baseline | A scoped story can plan, implement, record verification evidence, review, validate, summarize user value, and reach DONE without false evidence. |
| Engineering baseline | Realistic multi-file, existing-repo, bugfix, regression, data/security/frontend, and longer-running engineering tasks pass with scope, review, and evidence. |
| Loop Engineering / UDM baseline | Planner, planned steps, executor, repair loop, review reflection, evidence gate, budget stop, human handoff, multi-host review, and no-false-DONE scenarios behave as specified. |
| Production Safety baseline | Live Authority readiness, customer key, actor/session, evidence binding, receipt verification, lifecycle consumption, soak policy, and multi-host final certification pass for tested classes. |

### Negative-Control Expected Blocks

| Negative control | Expected future outcome |
|---|---|
| Undeclared source edit | Blocks scope gate with path and scope reason. |
| Unknown runtime/story metadata file | Blocks unless registered as runtime or lifecycle artifact. |
| Missing PLAN scope check | Blocks PLAN review and points to reviewer-written `scope_check_save`, not self-signing. |
| Missing `verificationIntent` | Blocks review/validation; repair hint appears only when legacy evidence exists. |
| Malformed `intentRef` | Repair/evidence path fails closed and leaves story unchanged. |
| Stale verification evidence | `lattice validate` reports allPass false or stale coverage; DONE blocks until refreshed after rerun. |
| Fake review pass | Handler normalizes only pass-only inputs or rejects ambiguous evidence; gate requires fresh signed reviewer run. |
| Duplicate host/session/key | Does not count toward independent quorum. |
| Missing second host | Blocks full 3x2 unless explicit degraded fallback is allowed and labeled. |
| Fake, stale, wrong-run, wrong-project, wrong-material receipt | Production/Authority gate blocks. |
| Local transcript as production proof | Blocks; local host output remains review evidence only. |
| Expected PASS scenario exhausts repair budget | Reports `FAIL` or suite `BLOCKED`, never DONE. |
| Expected block scenario blocks for the wrong reason | Reports `FAIL` or `BLOCKED`, not `EXPECTED_BLOCK`. |
| False DONE seeded trap | Must remain blocked and count against the suite if it reaches DONE. |

## Rollout Strategy

Rollout should be staged to avoid breaking active stories while still failing
closed for new high-risk work.

### Milestone-To-Rollout Stage Crosswalk

Every enforcement artifact introduced by M1-M12 must record the rollout
`policyVersion` it was evaluated under. A row may be rendered by an older
policy for compatibility, but a gate may enforce it only when the row's policy
version is accepted by the current gate and the story's in-flight treatment
allows enforcement.

| Stage | Milestones | Policy version binding | Enforcement mode | In-flight story treatment | Operator-visible evidence |
|---|---|---|---|---|---|
| 0 Documentation And Classification | M0; M11 drafts | `lattice-strengthening-roadmap.v0-docs` | Documentation only | No existing story requirements change. | `git diff --name-only main...HEAD`, `git diff --check`, source/status mapping. |
| 1 Read-Only Diagnostics | M1-M4 prototypes; M9 read-only projections; M11 runbook drafts | `lattice-strengthening-roadmap.v1-diagnostic` | Read-only/advisory | Stories already past PLAN receive diagnostics only unless they opt in. Stories before PLAN may use the new guidance. | `session_brief`, `status`, `doctor`, dry-run reports, registry verifier output. |
| 2 Advisory Gate Rows | M2, M4-M6, M8 diagnostics, M10 scheduling projections | `lattice-strengthening-roadmap.v2-advisory` | Advisory rows; no new blockers | DEV/REVIEW/TEST stories show rows and remediation. DONE should not be newly blocked unless an older gate already blocks. | Oracle rows with `blocking=false`, `review_escalation_status`, `autopilot_review_status`, `decision_doc_quorum_check`. |
| 3 Fail-Closed For New Stories | Tested M1-M8 rows; M9 renderers | `lattice-strengthening-roadmap.v3-new-story-enforce` | Fail-closed for stories created after policy activation and explicitly opted-in high-risk milestones | In-flight stories continue under their creation policy unless they replan, opt in, or an audited emergency/operator decision changes treatment. | Gate rows with `blocking=true`, validation evidence, policy-version report. |
| 4 Legacy Migration And Compatibility Tightening | M3 repairs; M6 negative controls; M8 identity migration; M11 repairs | `lattice-strengthening-roadmap.v4-legacy-tighten` | Audited migration plus selected blockers after dry-run success | Legacy stories get dry-run repair reports first; mutation requires explicit command, reason, owner lease, and policy version. Completed DONE stories are not reopened. | Migration dry-run report, repair audit event, stale/compatibility matrix. |
| 5 Formal Baseline And Capability Claims | M7 and M12 after required implementation milestones land | `lattice-strengthening-roadmap.v5-certification` | Formal proof and claim boundary | Only fresh implementation stories participate; old diagnostics are inputs, not proof. | Baseline reports, cross-track certification, host verdict summary, receipt refs where required. |

Policy-version binding rules:

- A gate-consuming row must carry `policyVersion`, `rolloutStage`, story id,
  material/head hash, producer, timestamp, and row id.
- A newer policy may read older rows for explanation, but enforcement requires
  either an accepted compatibility mapping or regenerated rows under the current
  policy.
- If policy changes while a story is in PLAN, the story should re-run the
  PLAN/review step before DEV. If it changes in DEV/REVIEW/TEST, the default is
  advisory until the story opts in, replans, or records an audited operator
  decision. If it changes after DONE, do not reopen the story retroactively.
- `explicitlyConfiguredHighRiskPolicyRequires3x2` is true only when this
  policy-versioned fact exists; changed-file classification or prose cannot set
  it.

False-positive rollback and de-escalation:

- Do not delete the original blocker row. Record a `deescalated` or
  `false-positive` disposition with reason, evidence refs, operator/reviewer,
  timestamp, `policyVersion`, and current material binding.
- De-escalation may unblock local lifecycle only when the consuming gate has an
  explicit de-escalation predicate. It cannot make stale evidence fresh, cannot
  convert degraded 3x1 into full 3x2, and cannot set Authority receipt
  completion fields.
- When a row blocks because of a newly over-broad policy, first roll back to
  Stage 2 advisory for that row id or pin the affected story to its prior
  accepted policy version. Then fix the policy and add a negative-control test
  before re-enabling fail-closed mode.

M11 staged runbook and repair prerequisite:

- Before Stage 3/4 fail-closed enforcement, every new blocker class must have a
  runbook entry with the command to inspect it, the command to repair it if a
  repair exists, the expected dry-run output, and the expected audit event.
- The stale-material local diagnostics runbook must inspect local verdict
  inventory with `autopilot_review_status`, refresh validation/evidence with
  `lattice validate --story=<storyId> --json` and
  `verification_evidence_refresh_stale`, and resubmit local host verdicts over
  the current material hash. It must not describe remote proof or completion
  capability.
- Repair commands must support dry-run where practical. The dry-run must print
  proposed file/artifact changes and row ids without writing story JSON,
  fixtures, runtime code, or lifecycle evidence.
- A blocker cannot move from advisory to fail-closed until its runbook examples
  match current command help and at least one dry-run transcript has been
  reviewed.

Audited emergency bypass for self-hosting over-block:

- Use only when Proofbound's strengthened local gate blocks the story that is
  required to fix that same gate and no normal replan/repair path can proceed.
- Requires explicit human/operator reason, owner lease for story-scoped writes,
  main write lock for main/shared writes, current material/head hash, affected
  row ids, expiry by time or `policyVersion`, and reviewer visibility.
- The bypass may downgrade a local row from fail-closed to advisory for the
  named story and policy version only. It must not bypass git cleanliness,
  main-lock serialization, evidence freshness, receipt verification, or final
  claim boundaries.
- The bypass can never set `authorityDone`, `fullAuthorityDone`,
  `productionDone`, `receiptVerified`, `strongEvidenceConsumed`, full 3x2, or
  baseline PASS. It must be surfaced in final acceptance as a limitation.

### Stage 0. Documentation And Classification

- Land this roadmap.
- Register related decision docs in NAV as needed.
- Mark all future behavior as planned unless code and tests land in a later
  story.

Exit criteria:

- Operators can identify which milestone owns a gap.
- No runtime behavior is claimed.

### Stage 1. Read-Only Diagnostics

- Add or improve status commands, doctors, dry-runs, and reports.
- Do not block lifecycle yet except where an existing gate already blocks.
- Gather examples of confusing output and missing source refs.

Exit criteria:

- Diagnostics identify scope, evidence, host, baseline, and preflight gaps
  without mutating story state.
- No diagnostic creates authority or DONE evidence.

### Stage 2. Advisory Gate Rows

- Feed diagnostics into canonical oracle rows.
- Render rows in `session_brief`, `status`, and DONE pre-check.
- Keep new rows advisory until positive/negative tests exist.

Exit criteria:

- Operators see the upcoming blocker and its remediation.
- Renderer parity tests pass.

### Stage 3. Fail-Closed For New Stories

- Turn tested rows into blockers for newly created stories or explicitly opted
  in high-risk milestones.
- Preserve legacy readability.
- Provide explicit repair/migration paths for old metadata shapes.

Exit criteria:

- New stories cannot bypass the strengthened gate.
- Legacy stories can be repaired through audited commands, not manual JSON.

### Stage 4. Legacy Migration And Compatibility Tightening

- Offer dry-run migration reports.
- Require explicit operator reason for mutating repair outside PLAN.
- Tighten compatibility once repair paths are proven.

Exit criteria:

- Active legacy stories have a safe path forward.
- Compatibility does not create new pass conditions.

### Stage 5. Formal Baseline And Capability Claims

- Run baseline suites over frozen targets.
- Compute success rates and false-DONE counts.
- Require fresh host verdicts and receipt refs where the suite demands them.

Exit criteria:

- Claims name only the suites/classes that passed.
- Expected-block and negative-control outcomes are visible.

## Risks And Mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Scope model becomes too broad | Out-of-scope changes appear legitimate. | Filename-aware classifiers, negative controls, reviewer source refs. |
| Scope model becomes too noisy | Safe lifecycle artifacts block normal work. | Registered lifecycle/runtime artifact sets plus focused positives. |
| Process facts drift between prompt and handler | Reviewers think a fact is required but gates accept missing data. | M4 registry and static contract verifier before gate changes land. |
| Evidence chain is too expensive | Agents skip context/evidence steps or overfit to broad full-suite tests. | Bounded context packs, targeted commands, preflight dry-runs, staged rollout. |
| Negative controls are treated as failures | Safety blocks get repaired into false PASS. | Outcome enum and suite definitions distinguish `EXPECTED_BLOCK`. |
| 3x2 review blocks local progress when a host is unavailable | Stories stall indefinitely. | Explicit degraded single-host fallback with lower-assurance label and policy gate. |
| Degraded fallback becomes normal | Lower assurance is reported as full proof. | Stable `degraded-single-host` fields and tests rejecting full-3x2 wording. |
| Parallel work creates stacked gate holes | Independently correct stories combine into a bypass. | Shared schema owners, dependency joins, merged-state combination review. |
| Baseline claims outrun evidence | Proofbound appears more capable than tested. | Success-rate math, false-DONE count, claim boundary templates. |
| Authority terminology leaks into local evidence | Host transcripts or local statuses imply production proof. | Local host evidence remains review evidence; receipt-backed facts are separate. |
| Migration mutates user metadata unexpectedly | Trust and auditability degrade. | Dry-run first, explicit reason, owner lease, no direct story JSON edits. |

## Final Acceptance Template

Future implementation stories under this roadmap should close with a structured
acceptance summary like this:

```text
Story:
Milestone(s):
Track(s):
Status:
Current implementation status: shipped / harden-existing / partial / planned / greenfield
Policy version / rollout stage:
Implemented controls:
Not implemented / deferred:

Scope boundary:
- Allowed files:
- Excluded files:
- Lifecycle/runtime artifact policy checked:
- Scope changes acknowledged:

Verification and evidence:
- verificationIntent refs covered:
- Commands/tests:
- Context pack / evidence envelope refs:
- Material hash / head hash:
- Negative controls:
- Stale evidence check:

Review and collaboration:
- Reviewer runs:
- Findings resolved:
- 3x2 required? yes/no:
- requires3x2 predicate input:
- 3x2 result or degraded fallback:
- Owner lease / main lock considerations:
- Parallel/combination review considerations:

Baseline / capability:
- Baseline suites run:
- PASS / EXPECTED_BLOCK / FAIL / BLOCKED counts:
- False DONE count:
- Claim boundary:
- Authority receipt refs, if any:

User-value acceptance:
- Expected outcome:
- Actual transcript or observable behavior:
- Outcome diff:
- Acceptance verdict:

Final claim:
- What can be claimed:
- What cannot be claimed:
- Freshness caveats:
```

Acceptance for this B-b5c0 audit repair specifically:

```text
The roadmap document is repaired in place.
No runtime code, NAV, fixtures, hooks, or source files are changed by the
B-b5c0 commit.
The material/product diff changes only this roadmap document.
B-b5c0 lifecycle metadata may be present as story-scoped provenance.
The document is explicit that it is a plan, not implemented runtime behavior.
It maps source documents to roadmap decisions, including the Authority receipt
contract and lifecycle gate receipt consumption documents as primary sources.
It includes a current implementation status axis and does not describe shipped
INIT scope, owner/main-lock/session_brief, parallel wave, or registry surfaces
as net-new behavior.
It decomposes hard scope boundaries, mechanical evidence, and collaboration
preflight into milestones with deliverables, gates, tests, evidence, blockers,
and DONE criteria.
It defines the 3x2 predicate, counted local verdict binding requirements,
minimal validation commands/artifact rows for M0/M6/M8/M12, rollout crosswalk,
policy-version binding, in-flight treatment, false-positive de-escalation, M11
dry-run prerequisites, and audited self-hosting emergency bypass.
It preserves the boundary that B-b5c0 does not claim `authorityDone`,
`fullAuthorityDone`, `productionDone`, `receiptVerified`, full Authority, or
baseline/prod capability unlock.
```
