# B-b36d User-Value Verification Transcript

## Expected

Opening the revised requirements document should show:

- title: `Lattice Lifecycle Proof-Or-Stop Readiness Check`;
- short name: `Lifecycle Readiness Check`;
- V1 report model: `StoryReadinessReport`;
- V1 posture: read-only by default, with `runCommands:false` and
  `writeEvidence:false`;
- exact-next-action semantics for stale, blocking, manual, external, rollback,
  delivery, and `done_prepare` cases;
- no primary V1 framing around `story_pipeline` or the old standard evidence
  pipeline name.

## Actual

Command:

```bash
sed -n '1,120p' docs/requirements/decisions/lattice-lifecycle-readiness-check-execution-plan.md
```

Observed transcript:

```text
# Lattice Lifecycle Proof-Or-Stop Readiness Check

Status: execution plan
Created: 2026-06-20
Short name: Lifecycle Readiness Check
V1 report model: `StoryReadinessReport`

## Purpose

The Lifecycle Readiness Check is a read-only control tower for a Lattice story.
It answers one question:

> What proof is already present for the requested lifecycle target, and what is
> the exact next action when proof is missing, stale, blocking, or external?

It replaces the previous pipeline positioning. The old full-flow material is
now the Full Vision: later staged layers that may plan or orchestrate work only
after V1 proves that a read-only report is stable and does not weaken lifecycle
gates.
```

Command:

```bash
rg -n "Lattice Lifecycle Proof-Or-Stop Readiness Check|Lifecycle Readiness Check|StoryReadinessReport|runCommands|writeEvidence|readiness\[\*\]\.code|missing_delivery_check|delivery_check_blocking|preMergeHead|postMergeHead|one refresh pass|metadata-only waiver waives only|story_pipeline" docs/requirements/decisions/lattice-lifecycle-readiness-check-execution-plan.md docs/requirements/decisions/assets/lattice-lifecycle-readiness-check-flow.svg docs/requirements/NAV.md
```

Observed transcript summary:

```text
docs/requirements/NAV.md:45 references Lattice Lifecycle Proof-Or-Stop Readiness Check.
SVG title/desc reference the Lifecycle Proof-Or-Stop Readiness Check and StoryReadinessReport.
The plan contains runCommands:false and writeEvidence:false.
The plan defines readiness[*].code for stable delivery detail codes.
The delivery table contains missing_delivery_check and delivery_check_blocking rows.
The done_prepare section defines preMergeHead and postMergeHead semantics.
The refresh section limits refresh-only behavior to one refresh pass.
The waiver section says metadata-only waiver waives only the live-smoke transcript requirement.
The only story_pipeline reference is explicitly deferred to a later Full Vision integration layer.
```

Command:

```bash
xmllint --noout docs/requirements/decisions/assets/lattice-lifecycle-readiness-check-flow.svg
```

Observed transcript:

```text
exit 0; SVG is well-formed XML.
```

Command:

```bash
rg -n "lattice-standard-evidence-pipeline|Lattice Standard Evidence Pipeline|standard evidence pipeline|story_pipeline --|lattice story_pipeline|Target Command Surface|Recommended operator path" README.md docs/guide.md docs/requirements/NAV.md docs/requirements/decisions docs/requirements/decisions/assets
```

Observed transcript:

```text
exit 1; no stale old filename/title or V1 story_pipeline command framing matched.
```

## Diff Notes

Expected and actual match. The revised document is visibly framed as a
Lifecycle Proof-Or-Stop Readiness Check, V1 is read-only by default, the
`StoryReadinessReport` can carry both broad readiness categories and stable
delivery detail codes, and old pipeline wording is not presented as the V1
operator path.

