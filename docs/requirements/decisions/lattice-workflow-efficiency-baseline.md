# Proof-or-Stop Workflow Efficiency Baseline

Date: 2026-06-23
Baseline registration story: B-4bd7

## Purpose

This document defines the baseline protocol for the six workflow-efficiency
issues observed during the B-e9cb Authority/provider-host story. The baseline is
not an optimization story by itself. It freezes what must be measured before and
after future changes so a later story can prove that it fixed a real process
problem instead of merely changing the workflow shape.

The frozen historical baseline is `experiments/baselines/lattice-workflow-efficiency-baseline-v1.json`.

Future optimization stories should compare their result against that file and
update only a new derived result file, not rewrite the original baseline.

## Source Incident

The source incident is the B-e9cb Authority/provider-host development run from
2026-06-23. The run completed, but the retrospective identified six repeatable
workflow costs:

1. Full `proof-or-stop validate` was expensive enough that a 240000 ms timeout could
   create false failure pressure.
2. Proof metadata spoofing checks found real correctness issues late because the
   reviewer checklist did not explicitly require checking both job metadata and
   linked run metadata.
3. The Codex adapter evidence gate was triggered by ordinary provider text that
   mentioned "Codex", instead of being limited to adapter surfaces.
4. A late `main` merge exposed conflicts after substantial story work had
   already accumulated.
5. A delivery-check pass could remain visible after the material head it reviewed
   was no longer current.
6. DONE summary output could preserve stale test counts instead of deriving from
   the newest test evidence.

These are workflow correctness and efficiency observations. They are not a
license to optimize arbitrary code paths or broaden product behavior.

## Philosophical Boundaries

Every follow-up using this baseline must preserve these constraints:

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness issues.
4. Preserve consistency of logic.

This means each follow-up change needs a measurable before/after comparison and
a correctness rationale. A lower wall-clock time alone is not enough if the
change weakens review, evidence freshness, delivery gates, or DONE semantics.

## Baseline Dimensions

### Validate Cost And Timeout Risk

Measure:

- final full validate command and duration;
- whether any validate run timed out at the configured timeout;
- configured timeout at the time of the run;
- whether the story used focused checks before the final full validate.

Target:

- no false timeout failure for the normal full validation envelope;
- focused suites are used during development and review;
- full validate is still run before completion when required.

### Proof Metadata Review Coverage

Measure:

- whether reviewer guidance requires checking server-authored proof keys in both
  job metadata and linked run metadata;
- whether late review rounds found proof metadata spoofing issues.

Target:

- reviewer checklist and tests cover both job metadata and linked run metadata in
  the first review cycle;
- forged client-controlled proof metadata cannot satisfy a server-authored proof
  requirement.

### Codex Adapter Evidence Gate Scope

Measure:

- whether ordinary provider text containing "Codex" triggers the Codex adapter
  evidence gate;
- whether actual Codex adapter surfaces still trigger the gate.

Target:

- provider-only text does not trigger adapter evidence;
- actual adapter surfaces still require `proof-or-stop codex verify`.

### Main Merge Readiness

Measure:

- whether the story branch was synced with `main` before REVIEW;
- whether conflicts were first discovered only near DONE.

Target:

- long-running stories run a pre-REVIEW main sync check;
- conflicts are found before final evidence and delivery closure.

### Delivery-Check Freshness

Measure:

- whether delivery-check evidence remains accepted after head or material hash
  changes;
- whether the stale state is surfaced as blocking before DONE.

Target:

- stale delivery-check evidence is forced stale and cannot be treated as a fresh
  pass.

### DONE Summary Freshness

Measure:

- whether DONE summary derives test counts from the newest test evidence;
- whether stale counts remain visible after later validation evidence exists.

Target:

- DONE summary uses the latest current-head test evidence;
- stale counts are blocked or automatically refreshed before the DONE claim.

## Machine Baseline Schema

The baseline JSON is intentionally small and stable:

- `schemaVersion`: schema identifier for this baseline family.
- `baselineId`: immutable baseline name.
- `createdAt`: timestamp when this baseline record was created.
- `registrationStory`: story that registered this immutable baseline.
- `sourceIncident`: human and commit anchors for the observed run.
- `observedBefore`: the measured pre-fix or pre-policy behavior.
- `targetAfter`: expected behavior after focused follow-up fixes.
- `futureComparisonRules`: rules that every follow-up comparison must honor.

The original baseline file should not be rewritten after follow-up stories land.
If a follow-up needs to publish results, create a separate result artifact under
`experiments/baselines/` and reference this baseline by `baselineId`.

## Non-Goals

- Do not implement the six fixes in the baseline story.
- Do not change Authority Server business logic.
- Do not deploy, push, or publish remote branches.
- Do not treat local/non-authority evidence as Authority proof.
- Do not weaken review, delivery-check, validate, or DONE gates to improve time.

## Acceptance For The Baseline Story

A baseline story is complete when:

1. this decision document exists and identifies the baseline JSON path;
2. the baseline JSON parses as valid JSON;
3. the baseline JSON contains all six observed dimensions;
4. the baseline clearly separates observed behavior from target behavior;
5. the story records that no workflow optimization behavior was implemented.

## Follow-Up Use

When opening one of the six optimization stories, the story should name this
baseline and state which dimension it will improve. The story should include at
least one regression check proving the changed behavior and one comparison note
showing whether the target moved toward the `targetAfter` expectation.
