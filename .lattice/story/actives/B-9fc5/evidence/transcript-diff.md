# B-9fc5 User-Value Transcript Diff

## Expected

The user asked for a detailed execution plan for the missing parent-roadmap
completion / user-intent-totality gate, and clarified that the first milestone
must be test cases before the full implementation story.

The expected user-visible result is a plan document that:

- explains why B-5082 protected B-43de only at story-local scope;
- defines the parent-child totality contract;
- starts implementation with `M1. Red/Repro`;
- includes concrete red/repro negative controls before runtime work;
- preserves `partial_parent_done` without allowing a full-roadmap overclaim;
- says `allRowsClosed=false` means `no full-roadmap claim`;
- lists the remaining implementation milestones and their verification path.

## Actual

The document was created at:

```text
docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md
```

The user-visible opening confirms the scope:

```text
# Parent Roadmap Intent Totality Gate Execution Plan

Status: plan-only for B-9fc5
```

The marker sweep passed:

```bash
rg -n "M1\\. Red/Repro|allRowsClosed=false|partial_parent_done|no full-roadmap claim|ParentRoadmapLedger|ParentRollupResult|child-story-needed|deferred-with-human-approval|B-5082" docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md
```

Observed highlights:

```text
7:B-5082 protected story-local intent for B-43de
45:- When the evaluator sees `allRowsClosed=false`
49:  missing evidence, or an invalid deferral, summaries must make `no full-roadmap claim`.
66:### ParentRoadmapLedger
127:### ParentRollupResult
194:### M1. Red/Repro Test Cases Before Full Implementation
224:  or later rows are still `child-story-needed`
228:- `partial_parent_done` allowed but not complete
236:- Invalid deferral: `deferred-with-human-approval`
387:### M5. B-5082 ProofStory Binding
```

Formal validation also passed:

```text
lattice proofstory_gate_check {"storyId":"B-9fc5","mode":"enforce","json":true}
status: pass

lattice intent_coverage_check {"storyId":"B-9fc5","mode":"enforce","json":true}
status: pass

lattice validate --story=B-9fc5
Project validation commands passed
Verification intent coverage: 15/15 covered
```

## Diff Notes

- Match: the first implementation milestone is explicitly `M1. Red/Repro Test
  Cases Before Full Implementation`.
- Match: the plan does not claim runtime implementation or full M4-M12 roadmap
  completion.
- Match: parent governance DONE can be honest as `partial_parent_done`, but
  open child rows force `allRowsClosed=false` and `no full-roadmap claim`.
- Match: later implementation must use B-5082 controls and cannot shrink the
  user's original parent intent.
- No mismatch found during this acceptance check.
