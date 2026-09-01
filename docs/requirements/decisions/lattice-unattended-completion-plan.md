# Proof-or-Stop Unattended Completion Plan

## Status

Execution plan. This document turns the remaining Proof-or-Stop unattended
development gaps into implementation milestones, required evidence, and DONE
criteria.

This plan complements:

- `lattice-authority-live-integration.md`
- `lattice-authority-customer-api-key-access.md`

It does not replace those documents. It defines the work required to make the
documented capabilities real.

## Core Principles

Every milestone, planner prompt, executor prompt, reviewer prompt, and final
host-check prompt must carry these principles:

1. don't optimize for the sake of optimization
2. don't optimize arbitrarily
3. only fix real correctness issues
4. preserve consistency of logic

Operational meaning:

- add only the machinery required to close a documented correctness gap;
- do not introduce speculative architecture, UX, provider, storage, or security
  changes outside the milestone;
- if an improvement is useful but not required for correctness, create a
  follow-up Story instead of including it in the current DONE claim;
- a host reviewer may block only on real correctness issues, missing evidence,
  stale evidence, security boundary failures, broken parity, or unimplemented
  milestone requirements.

## Current Gap Summary

| Area | Current state | Required completion |
|---|---|---|
| plannedSteps contract | Contract and smoke tests exist. | Production executor consumes typed steps for real jobs and reports structured evidence per step. |
| Proof-or-Stop Authority mode | CLI/contracts/local tests exist. | Python Authority live loop passes on `http://localhost:6789/` with real customer API key and signed actors. |
| Customer API key access | Requirements and config contract exist. | Server stores hashed keys, validates scopes, rejects missing/invalid/revoked/expired keys, and supports rotation tests. |
| Actor / runner signatures | Boundary is defined. | Actor enrollment and signed mutating APIs are verified against the live server. |
| Evidence upload | API shape and client path exist. | Live evidence is persisted, bound to job/run/step/material hash, and referenced by gate receipts. |
| Gate decision receipt | Contract exists. | Live server signs native receipts and CLI verifies signature plus binding fields before authority DONE. |
| Executor loop | Partially implemented. | Runner can claim, execute, upload evidence, evaluate gate, repair/retry, stop, release, and summarize. |
| Story Planner | Planned/smoke only. | Natural-language input produces a usable Story draft, checklist, and verification intent. |
| Job Planner | Planned/partial. | Story/checklist/verification intent produce typed `plannedSteps[]` with providers, cwd, timeouts, evidence, retries, and gates. |
| Planner interaction modes | Requirements exist. | CLI exposes autonomous, interview, decision-gated, and source-aligned redevelopment workflows. |
| Source-aligned redevelopment | Requirements exist. | Old/new projects are mapped, rebuilt, and verified through parity evidence. |
| Cross-language manifest | Not complete. | Source modules, target modules, APIs, commands, fixtures, and unsupported gaps are represented in a typed manifest. |
| Target-runnable parity | Not complete. | Old and target implementations run against the same fixtures and produce comparable outputs. |
| Gap / block rules | Requirements exist. | Executor and gates block on unclosed equivalence gaps and cannot claim DONE with unresolved gaps. |
| Host agent orchestration | Gate requirement exists. | CLI can orchestrate or ingest three bounded review waves from 2+ independent hosts and attach verdict evidence. |

## Completion Milestones

### M1. Scope Freeze And Process Guard

Goal: make this plan mechanically actionable without creating unrelated work.

Deliverables:

- register this plan in requirements navigation;
- add a checklist/story template for this completion track;
- define a `no_arbitrary_optimization` prompt clause reused by planner,
  executor, and host reviewers;
- add a follow-up Story rule for non-correctness improvements.

Acceptance:

- reviewers can identify whether a proposed change belongs to this plan;
- unrelated optimization proposals are routed to follow-up Stories;
- milestone evidence references this document and one of M2-M16.

Blockers:

- a task cannot name the milestone it closes;
- a change expands scope without a correctness reason.

### M2. Production plannedSteps Executor Contract

Goal: make typed `plannedSteps[]` executable, not only descriptive.

Deliverables:

- canonical step types for shell command, test command, provider task, file
  artifact inspection, evidence upload, gate evaluation, host review, and
  release;
- schema fields for `cwd`, timeout, allowed tools, retry policy, evidence
  requirements, material hash expectation, and failure handling;
- validation that rejects placeholder steps, missing cwd, missing timeout, and
  missing evidence policy;
- executor dry-run output that shows exact steps before execution.

Acceptance:

- unit tests reject invalid step plans;
- smoke tests execute a small real plan and collect per-step evidence;
- a step failure produces structured blocked output instead of silent success.

Blockers:

- free-form prose steps are accepted as executable work;
- a step can pass without required evidence.

### M3. Python Proof-or-Stop Authority Live Baseline

Goal: prove the CLI talks to a real local Python Proof-or-Stop Authority server.

Deliverables:

- Python Authority source is the existing local server project at
  `/Users/jek/Documents/Work/Proof-or-Stop/cord-team` unless a later Story explicitly
  replaces the server source;
- documented startup command for Python Proof-or-Stop Authority on
  `http://localhost:6789/`;
- canonical local `.proof-or-stop/authority.md` profile;
- generated local test customer API key, actor key, runner id, project id, and
  pinned server public key;
- live test command that fails if the server is missing or responses are mocked.

Acceptance:

- `test:authority-live-python` runs against `http://localhost:6789/`;
- output is not skipped;
- policy discovery, runner registration, job claim/release, and server key
  pinning pass.

Blockers:

- `/Users/jek/Documents/Work/Proof-or-Stop/cord-team` cannot start a Python Authority
  server and no replacement source is named;
- tests use stubs while claiming live evidence;
- server public key is not pinned or verified.

### M4. Customer API Key Server Enforcement

Goal: make customer authorization real for hosted Authority access.

Deliverables:

- server-side customer API key model with raw-key one-time display and hash-only
  storage;
- scopes for customer, workspace, project, actor roles, and allowed API groups;
- rejection paths for missing, invalid, revoked, expired, out-of-scope, and
  rotated keys;
- redaction tests for inline key values and key-like diagnostics.

Acceptance:

- mutating production endpoints reject requests without a valid customer key;
- actor registration cannot occur with only an actor signature;
- raw customer API keys never appear in server events, evidence, receipts, or
  diagnostic output.

Blockers:

- raw customer key is persisted server-side;
- actor enrollment bypasses customer authorization.

### M5. Actor Enrollment And Runner Identity

Goal: separate customer authorization from signed executor identity.

Deliverables:

- `POST /v1/actors/{actorId}/keys` enrollment requiring customer API key and
  project/role scope;
- runner identity binding for `runnerId`, `projectId`, `actorId`, and
  `actorRole`;
- signed mutating envelope verification for job, run, evidence, gate, heartbeat,
  and release APIs;
- replay protection using nonce/timestamp/digest binding.

Acceptance:

- live tests prove missing actor signature is rejected;
- live tests prove wrong actor, wrong project, wrong role, stale timestamp, and
  replayed envelope are rejected;
- valid customer key plus valid actor signature succeeds.

Blockers:

- bearer customer key alone can mutate signed resources;
- actor signature alone can mutate tenant-scoped resources.

### M6. Live Evidence Persistence And Binding

Goal: make evidence auditable and tied to the exact job/run/step.

Deliverables:

- evidence upload and batch upload endpoints;
- evidence schema for command, output digest, artifact digest, material hash,
  step id, run id, job id, actor id, and timestamp;
- server persistence with query-by-job/run;
- redaction and maximum-size behavior.

Acceptance:

- live tests upload evidence and retrieve evidence references;
- gate evaluation consumes evidence refs, not raw unverifiable prose;
- stale material hash evidence blocks gate approval.

Blockers:

- evidence can be attached to the wrong job/run;
- gate evaluation accepts missing or stale evidence.

### M7. Native Gate Decision Receipt

Goal: make authority DONE depend on a server-signed receipt.

Deliverables:

- server-side gate evaluation endpoint;
- native `gate_decision` receipt signed by the Authority server;
- receipt fields for job id, run id, project id, material hash, evidence refs,
  policy version, decision digest, and timestamp;
- CLI receipt verification against the pinned server public key.

Acceptance:

- CLI rejects unsigned, tampered, stale, wrong-project, wrong-run, and
  wrong-material receipts;
- CLI accepts a valid live receipt and exposes `authorityDone`;
- `fullAuthorityDone` remains false until final review waves pass.

Blockers:

- local text can replace the native receipt;
- server receipt does not bind material hash and evidence refs.

### M8. Executor Loop Productionization

Goal: complete the unattended job loop.

Deliverables:

- runner claim loop;
- planned step execution;
- evidence upload per step;
- gate evaluation request;
- receipt verification;
- release/complete policy;
- automatic failure classification;
- bounded retry and repair loop;
- stop condition and final summary.

Acceptance:

- executor can run a real small job to local DONE;
- executor can run the same job through Authority mode to authority DONE;
- failed validation returns to repair steps and retries within policy;
- exhausted retry budget produces blocked summary, not false DONE.

Blockers:

- a failed step is skipped without explicit policy;
- retry loop is unbounded;
- final summary omits failed or skipped steps.

### M9. Story Planner

Goal: turn natural language into a Story candidate with verifiable intent.

Deliverables:

- input support for one sentence, paragraph, or requirements document;
- scope inference and ambiguity detection;
- Story draft with background, constraints, non-goals, checklist, and
  verification intent;
- autonomous, interview, and decision-gated planning branches.

Acceptance:

- planner generates a Story that can enter Job Planner without manual rewriting;
- interview mode asks 5-10 concrete questions before plan confirmation;
- decision-gated mode pauses only on defined high-impact decisions;
- autonomous mode continues unless ambiguity exceeds policy thresholds.

Blockers:

- planner emits placeholder checklist items;
- planner expands scope without evidence.

### M10. Job Planner

Goal: convert Story/checklist/verification intent into executable jobs.

Deliverables:

- typed `plannedSteps[]` generation;
- provider assignment;
- cwd and tool bounds;
- timeout and retry policy;
- validation commands;
- evidence requirements;
- gate criteria;
- expected review wave policy.

Acceptance:

- generated jobs pass plannedSteps schema validation;
- job plan contains no placeholders;
- every checklist item maps to at least one validation/evidence step;
- job plan can be executed by the M8 executor.

Blockers:

- job plan contains prose-only instructions;
- validation intent is not represented in executable steps.

### M11. Planner Interaction Modes

Goal: expose the required user-facing development modes.

Deliverables:

- `autonomous`: no confirmation unless risk/ambiguity policy requires host
  decision;
- `interview`: 5-10 focused questions, one plan confirmation, then unattended
  execution;
- `decision-gated`: automatic normal implementation, pause only for major
  decisions;
- `source-aligned-redevelopment`: source project plus target language workflow.

Acceptance:

- CLI exposes mode selection;
- mode choice is written to Story/job evidence;
- mode policy controls planner behavior and interruption behavior;
- major decisions are recorded as structured decision evidence.

Blockers:

- mode is only prose and not persisted;
- decision-gated mode pauses for routine implementation choices.

### M12. Source-Aligned Redevelopment Workflow

Goal: support rewriting an existing project while preserving behavior.

Deliverables:

- source repository inventory;
- source entrypoints, APIs, commands, fixtures, configuration, and artifacts;
- target language/project scaffold;
- behavior manifest;
- parity test plan;
- gap/block report;
- final redevelopment summary.

Acceptance:

- a representative TypeScript-to-Python fixture is rebuilt and parity-tested;
- source and target commands can run side by side;
- unsupported behavior is blocked or explicitly marked as a gap;
- no final DONE is allowed with unresolved required gaps.

Blockers:

- target implementation is judged only by code similarity;
- source behavior is not captured through runnable evidence.

### M13. Cross-Language Manifest

Goal: abstract redevelopment across target languages.

Deliverables:

- typed manifest for source modules, target modules, APIs, commands, data
  formats, environment variables, fixtures, and parity expectations;
- language adapter slots for Python, Rust, Go, Swift, Kotlin, and future
  languages;
- mapping statuses: mapped, transformed, intentionally omitted, unsupported,
  blocked;
- manifest validation.

Acceptance:

- manifest can represent TypeScript-to-Python and at least one second target
  language fixture;
- unmapped required source modules block redevelopment DONE;
- manifest is attached to final evidence.

Blockers:

- mapping is stored only in free-form notes;
- unsupported behavior is silently omitted.

### M14. Target-Runnable Parity

Goal: prove target behavior through executable comparison.

Deliverables:

- parity fixture format;
- old/new command runner;
- API response comparator;
- stdout/stderr comparator;
- file artifact comparator;
- tolerated-difference policy;
- parity report.

Acceptance:

- old and new implementations run the same fixtures;
- comparator reports pass/fail with source refs;
- mismatch blocks redevelopment DONE unless explicitly waived through a
  structured decision;
- fixture coverage includes happy, edge, and adversarial cases.

Blockers:

- parity is based only on screenshots or subjective review;
- tolerated differences are not declared.

### M15. Gap / Block Hard Gates

Goal: prevent false DONE when equivalence or authority evidence is incomplete.

Deliverables:

- gate predicates for unresolved redevelopment gaps;
- gate predicates for missing live Authority evidence;
- gate predicates for stale receipt/evidence/review wave;
- blocked summaries with next required action.

Acceptance:

- unresolved required gap blocks DONE;
- missing live Authority receipt blocks authority DONE;
- stale review wave blocks full authority DONE;
- blocked output names the exact missing evidence.

Blockers:

- final DONE is possible with unresolved required gaps;
- blocked output is vague or non-actionable.

### M16. Host Agent Orchestration And Final Certification

Goal: automate or strictly ingest the required final multi-host review.

Deliverables:

- host review wave model;
- minimum three bounded waves before final DONE;
- at least two independent hosts per wave;
- preferred third host support when Gemini is available;
- prompt digest containing the four core principles, computed from the canonical
  final host-check prompt contract;
- verdict ingestion, reconciliation, and stale-anchor detection.

Acceptance:

- one satisfied wave plus receipt does not produce `fullAuthorityDone`;
- three satisfied waves plus verified receipt can produce `fullAuthorityDone`;
- any material repair forces fresh validation, fresh receipt in Authority mode,
  and fresh review waves;
- final summary includes `requiredReviewWaveCount`,
  `satisfiedReviewWaveCount`, and `reviewWaveRefs`.
- `preserve consistency of logic` is part of the canonical final host-check
  prompt digest, not only reviewer prose.

Blockers:

- reviewers inspect different anchors in the same wave;
- stale verdicts are reused after repair;
- a host blocks on non-correctness optimization preferences.

## End-To-End Completion Matrix

| Scenario | Required proof |
|---|---|
| Non-authority local unattended development | Natural language input creates Story/job, executor runs plannedSteps, local validation passes, final three-wave host check passes, local DONE is claimed. |
| Authority unattended development | Same as local, plus live Python Authority customer key validation, actor signature verification, evidence upload, gate receipt verification, and full authority DONE. |
| Customer key failure | Missing/invalid/revoked/expired/out-of-scope customer key is rejected before mutating operations. |
| Actor signature failure | Missing/wrong/stale/replayed actor signature is rejected even with valid customer key. |
| Evidence staleness | Material hash change makes prior evidence, receipt, and review wave stale. |
| Executor failure | Failed step enters repair/retry or blocked state, never silent DONE. |
| Story Planner | One sentence, paragraph, and document inputs produce valid Story/checklist/verification intent. |
| Job Planner | Story/checklist/verification intent produce executable plannedSteps with no placeholders. |
| Source-aligned redevelopment | A TypeScript fixture is rebuilt into Python and passes runnable parity checks. |
| Cross-language abstraction | Manifest supports at least TypeScript-to-Python plus one additional target-language fixture. |
| Host final certification | Three review waves, 2+ independent hosts per wave, same anchors, four principles in prompts, stale verdict detection. |

## Required Test Suites

Minimum test commands or equivalent tasks:

- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:planner-unattended-smoke`
- `npm --prefix packages/main run test:authority-job-loop`
- `npm --prefix packages/main run test:authority-completion`
- `npm --prefix packages/main run test:multi-host-authority-smoke`
- `npm --prefix packages/main run test:natural-language-to-done-smoke`
- `npm --prefix packages/main run test:authority-enforce-matrix`
- `npm --prefix packages/main run test:authority-status-smoke`
- `npm --prefix packages/main run test:authority-enforce-runner`
- `npm --prefix packages/main run test:authority-live-python`
- redevelopment fixture test for TypeScript-to-Python parity
- cross-language manifest validation test
- host-orchestration ingestion/reconciliation test

If a command is not available yet, its milestone must create it or explicitly
replace it with a narrower command that proves the same correctness boundary.

## Implementation Order

1. M1-M2: freeze scope and make plannedSteps executable.
2. M3-M7: make Authority live access, customer authorization, actor signature,
   evidence, and receipt real.
3. M8: complete executor loop. M8 depends on completed M2 contracts and the
   M3-M7 Authority/evidence/receipt path.
4. M9-M11: finish planner and interaction modes.
5. M12-M15: finish source-aligned redevelopment, cross-language manifest,
   parity, and gap/block gates.
6. M16: finish host orchestration and final certification.
7. Run the end-to-end completion matrix.

This order is intentional. Planner and redevelopment work should not claim DONE
before the executor and Authority evidence path can prove real outcomes.

## Parallel Work Tracks

Parallel execution is allowed only when write scopes do not collide.

| Track | Milestones | Primary files / areas | Parallelism |
|---|---|---|---|
| Phase 1 contracts | M1-M2 | process guard, plannedSteps schema/contracts | 2 agents |
| Authority server/client | M3-M7 | Authority server, authority client, key config, evidence, receipt verification | 3-4 agents after M3 baseline is proven |
| Executor | M8, M15 | runner loop, repair/retry/stop/release, completion gates | 2 agents; M8 depends on M2 and M3-M7 |
| Planner | M9-M11 | story planner, job planner, CLI mode UX | 3 agents; M10 depends on stable M2 schema |
| Redevelopment | M12-M14 | manifest, parity runner, fixtures, comparators | 3 agents; M14 depends on M13 manifest types |
| Host certification | M16 | host verdict ingestion, reconciliation, stale anchors | 2 agents; depends on M7 and M15 |

Agents must declare their milestone, write scope, and verification command before
editing. Agents must not create overlapping abstractions for the same milestone.
Audit / validation is not a free-floating parallel implementation track. It is a
phase gate after each implementation phase, with fresh tests and evidence before
the next dependent phase starts.

## Final DONE Criteria

The completion track is DONE only when all are true:

1. M1-M16 deliverables are implemented or explicitly marked as blocked with a
   real external blocker.
2. Local non-authority unattended development passes end to end.
3. Authority unattended development passes end to end against the Python
   Authority server on `http://localhost:6789/`.
4. Customer API key and actor signature failure cases are proven.
5. Evidence upload and native receipt verification are proven live.
6. Executor failure, repair, retry, stop, release, and summary behavior is
   proven.
7. Story Planner and Job Planner produce executable jobs from natural language.
8. Source-aligned redevelopment proves TypeScript-to-Python parity with runnable
   fixtures.
9. Cross-language manifest proves at least one additional target-language shape.
10. All unresolved required gaps block DONE.
11. Final certification completes three bounded review waves with 2+
    independent hosts per wave.
12. Every final host-check prompt includes the four core principles.
13. No final fix is made for arbitrary optimization; only real correctness
    issues are repaired.

## Explicit Non-Goals

- Do not redesign the whole CLI UX beyond what M11 requires.
- Do not build a generic SaaS admin console unless required for customer key
  correctness.
- Do not support every programming language before proving the manifest
  abstraction with concrete fixtures.
- Do not use mocked Authority responses as final live evidence.
- Do not claim redevelopment parity from visual or subjective similarity alone.
- Do not let host reviewers block on style preferences, speculative architecture
  changes, or optional optimization.
