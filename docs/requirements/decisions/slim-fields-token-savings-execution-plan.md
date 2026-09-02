# Slim / Fields Token Savings Execution Plan

Date: 2026-06-15

## Purpose

This document defines a low-risk execution plan for reducing repeated LLM context
cost from Proof-or-Stop status queries.

The goal is not to change command semantics. The goal is to update agent prompts
and documentation so agents use compact read-only query forms by default:

```bash
proof-or-stop story_get '{"storyId":"B-xxxx","slim":true,"fields":["story","checklist","review"]}'
proof-or-stop checklist_get '{"storyId":"B-xxxx","slim":true,"fields":["counts","items"]}'
```

Agents must still request full output when they need full evidence, full
checklist content, full review history, or complete story metadata.

## Current Evidence

The compact query surface already exists:

- `packages/main/src/handlers/story-query.ts` supports `story_get.slim` and
  top-level `fields`.
- `packages/main/src/handlers/checklist.ts` supports `checklist_get.slim` and
  top-level `fields`.
- `packages/main/src/cli-engine.ts` exposes both parameters in the command
  schemas.
- `packages/main/src/tasks/prompt-token-cost-smoke.ts` verifies:
  - default `checklist_get` remains full output;
  - default `story_get` still embeds full checklist data;
  - slim `checklist_get` is smaller than default;
  - slim `story_get` is smaller than default;
  - `fields` returns only requested top-level fields.

The token-cost audit records that repeated `story_get` / `checklist_get` output
can contribute roughly 6K-12K approximate tokens per ordinary story when agents
query status repeatedly. The same audit estimates the direct output-dedup saving
at roughly 1.2K-2.7K approximate tokens per query round, depending on story size.

These are approximate context-token estimates based on serialized output size,
not provider billing receipts. Provider prompt-cache behavior is not proven by
this repository.

## Scope

In scope:

- Update agent templates so status polling uses slim / fields first.
- Update docs and runbooks so examples show compact read-only query forms where
  full data is not required.
- Add or extend smoke coverage to prevent future prompt/doc regressions.
- Keep full-output commands documented for evidence-sensitive work.

Out of scope:

- Do not change default `story_get` output.
- Do not change default `checklist_get` output.
- Do not remove any fields from full output.
- Do not make lifecycle gates consume slim output.
- Do not claim Authority Server completion or provider billing savings.

## Behavior Rule

Use this rule in agent prompts and docs:

```text
Use slim / fields for routine status checks.
Use full output before evidence-sensitive conclusions or mutations.
```

Routine status checks include:

- finding the current story phase;
- checking checklist counts;
- seeing item ids, titles, and statuses;
- checking latest review issue/blocker counts;
- deciding which file or command to inspect next.

Full output is required before:

- resolving or disputing a reviewer finding;
- marking checklist items done with verification evidence;
- submitting reviewer pass or finding evidence;
- making delivery, TEST, or DONE conclusions;
- auditing missing or stale evidence;
- interpreting detailed `verificationIntent`, `verificationEvidence`,
  `initCheck`, or full review history.

## Execution Discipline

Implementation must run as a dedicated Proof-or-Stop story, not as part of B-f495.
That story must begin with `proof-or-stop session_brief` and `proof-or-stop aux_doc_list`
from its own worktree before reading or editing implementation files.

The implementing story should enter ordinary REVIEW first. If the first REVIEW
round records two or more countable findings, follow the automatic escalation
policy: run the 3x2 review path when enough independent hosts are available, or
the degraded 3x1 path when only one host is available. The escalation should be
recorded by the implementation story's normal review and evidence flow.

## Implementation Plan

### Step 1. Add A Shared Prompt Snippet

Add a short reusable guidance block to the prompt registry or the relevant agent
templates:

```text
For routine status refreshes, prefer compact read-only queries:

proof-or-stop story_get '{"storyId":"B-xxxx","slim":true,"fields":["story","checklist","review"]}'
proof-or-stop checklist_get '{"storyId":"B-xxxx","slim":true,"fields":["counts","items"]}'

Before evidence-sensitive conclusions or mutations, reload the full output:

proof-or-stop story_get '{"storyId":"B-xxxx"}'
proof-or-stop checklist_get '{"storyId":"B-xxxx"}'
```

The wording must be advisory, not a hard replacement for full output.

### Step 2. Update Agent Templates

Update the templates that routinely query story state:

- `packages/main/templates/agents/proof-or-stop-implementer.md`
- `packages/main/templates/agents/proof-or-stop-review-concept.md`
- `packages/main/templates/agents/proof-or-stop-review-quality.md`
- `packages/main/templates/agents/proof-or-stop-review-docs.md`
- `packages/main/templates/agents/proof-or-stop-review-behavior.md`
- `packages/main/templates/agents/proof-or-stop-review-delivery.md`
- `packages/main/templates/agents/proof-or-stop-review-story-init.md`
- `packages/main/templates/agents/proof-or-stop-review-scope-plan.md`
- `packages/main/templates/agents/proof-or-stop-review-test-coverage.md`

If the repository is in full-asset mode, regenerate or synchronize:

- `.claude/agents/*.md`
- `.proof-or-stop-codex/agents/*.md`

The rendered mirrors must continue to match the package templates.

### Step 3. Update Documentation Examples

Update command examples in docs that use `story_get` or `checklist_get` only for
routine orientation.

Preferred examples:

```bash
proof-or-stop story_get '{"storyId":"B-xxxx","slim":true,"fields":["story","checklist","review"]}'
proof-or-stop checklist_get '{"storyId":"B-xxxx","slim":true,"fields":["counts","items"]}'
```

Keep full-output examples where the surrounding text requires complete data:

```bash
proof-or-stop story_get '{"storyId":"B-xxxx"}'
proof-or-stop checklist_get '{"storyId":"B-xxxx"}'
```

### Step 4. Add Regression Checks

Extend `prompt-token-cost-smoke` or add a focused smoke that checks:

- the compact-query guidance exists in package templates;
- `.claude` mirrors match package templates;
- `.proof-or-stop-codex` mirrors match Codex-rendered package templates;
- default `story_get` and `checklist_get` output is unchanged;
- slim output remains smaller than default output;
- the guidance includes a full-output fallback for evidence-sensitive work.

When TypeScript, templates, generated mirrors, or smoke tasks may have changed,
run build before invoking built `dist` smoke tasks:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/prompt-token-cost-smoke.js
npm --prefix packages/main run test:prompt-registry-smoke
```

If Codex adapter assets are touched in the final implementation branch, also
run:

```bash
node bin/proof-or-stop.js verify_codex --json
```

## Expected Savings

Expected savings are workload-dependent.

Conservative estimate:

```text
3K-6K approximate tokens per ordinary story
```

Typical estimate:

```text
6K-12K approximate tokens per ordinary story
```

Large-story estimate:

```text
10K+ approximate tokens per story
```

The savings come from avoiding repeated full checklist, review, and evidence JSON
in routine orientation queries. This does not replace the larger prompt-template
savings already delivered by compact load-bearing prompt slices.

## Risk Assessment

Risk level: low.

Reasons:

- `slim` and `fields` are already opt-in.
- Default full output remains unchanged.
- Agents can request full output at any time.
- Existing smoke coverage already verifies default compatibility.

Main risk:

- A prompt could over-encourage slim output and cause an agent to make an
  evidence-sensitive conclusion without full evidence.

Mitigation:

- Every template and doc example must pair compact status queries with the rule:
  use full output before evidence-sensitive conclusions or mutations.

## Acceptance Criteria

The implementation is acceptable when:

- routine prompt examples prefer slim / fields;
- full-output fallback is explicit;
- default `story_get` and `checklist_get` behavior is unchanged;
- prompt registry and host mirrors remain consistent;
- `npm --prefix packages/main run build` passes before built smoke tasks are run;
- `prompt-token-cost-smoke` passes;
- `prompt-registry-smoke` passes;
- `verify_codex` passes when Codex adapter assets are touched;
- no lifecycle gate, Authority receipt field, or DONE semantic is changed.

## Formal Audit Disposition

B-f495 accepts this plan after the execution-order and review-discipline
corrections above. The evidence cited here is local repository evidence and is
not Authority Server evidence. Provider billing savings are not proven; the
token figures are approximate context-size estimates only. Implementation should
proceed as a separate dedicated Proof-or-Stop story.

## Rollback

Rollback is simple because this plan does not change command defaults.

If reviewers find that agents are missing required details:

1. Remove or soften the prompt guidance.
2. Keep the existing `slim` / `fields` CLI support unchanged.
3. Re-run prompt registry and Codex adapter verification.

No story metadata migration is required.
