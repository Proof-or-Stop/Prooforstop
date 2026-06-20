# Truth-First Host Handoff: Stale-Doc Guard Execution Plan

Story: B-0607  
Scope: execution plan only (no CLI/runtime code in this story)

## 0. Why now

A recent issue showed a host could read a stale story plan/backfill artifact as if it were
open work and ask the same task again, even though the work had already been completed.
This plan defines a **truth-first host handoff contract** so future hosts can avoid false rework requests.

## 1. Problem statement

- Sources in play for task ownership are currently mixed:
  - current story lifecycle state (truth of record),
  - older execution plans (historical),
  - ad-hoc memory entries.
- Hosts currently do not share a uniform rule for when historical docs can be trusted.
- Consequence: hosts can treat stale content as current work and re-prompt for completed items.

### Verified failure mode snapshot

Recent verified incident:

- Plan-only documentation for a completed activity still described future steps as pending.
- Backfill data was complete (`656` signatures) in commit `2750aadef`, but a host still surfaced stale prose as if work remained.
- The current story must therefore treat historical completion prose as **non-authoritative** unless it is bound to a completed outcome artifact and a valid `completionCommit`/`completedByStory` pointer.

## 2. Truth-first principle

When a host receives “work is not done / this remains pending” signals, it must evaluate in this order:

1. Live workflow facts (active story/checklist/finding state, session_brief).
2. Story completion facts (DONE stories and commit hash lineage).
3. Supersession metadata (whether this doc is historical, replaced, or superseded).
4. Ad-hoc memory hints (advisory only).

Any single host should treat lower-order signals as advisory and should not instruct users
to re-run tasks if higher-order facts show completion.

## 3. Stale-doc metadata contract

Execution and requirement documents that describe previous completion should carry explicit
machine-checkable provenance in a minimal frontmatter block.

```yaml
---
supersession:
  status: completed   # completed | superseded | historical | draft
  completedByStory: B-xxxx
  completionCommit: <40-char-sha>
  supersededBy: B-yyyy | null
  completionNote: "Outcome doc or evidence bundle that demonstrates finish"
  updatedAt: 2026-06-20
---
```

Interpretation:

- `status: completed`: safe baseline for “already done” when evidence is present.
- `status: superseded`: historical but intentionally replaced by a newer authoritative artifact.
- `status: historical`: reference-only, not authoritative for current active work.
- `status: draft`: intentionally in-progress planning text.
- `completedByStory`: source story that proves completion.
- `completionCommit`: commit SHA that contains the proof.
- `supersededBy`: if set, hosts must route users to the newer story/doc.

Compatibility requirement:

- `sourceStoryId` is retained as alias only and must be treated as equivalent to
  `completedByStory` to keep this executable for older docs that were already migrated
  with the previous field name.

## 4. Contract that each host must execute before claiming open work

Before stating any task as still pending, a host must at least perform the following
checks and expose them in handoff logs:

1. `session_brief` snapshot (story list + ownership + current phase).
2. `story_get` / `checklist_get` on the target story for required `DONE` or in-progress truth.
3. Supersession check for any referenced docs (frontmatter + linked source commit validity).
4. `gap_analyze` result read (if available), mainly to spot framework-level blockers/retries.
5. `learning_validate`/`learning_effectiveness` only as advisory confidence checks, never as definitive completion proof.

### Minimal mandatory preflight bundle (host entrypoint requirement)

Every host handoff must materialize the following facts bundle before responding:

- `sessionBrief`: raw output of `lattice session_brief`.
- `devMemoryPreflight`: raw output of `lattice dev_memory_preflight` (or equivalent host-specific entrypoint), or explicit `unavailable` proof.
- `activeStorySummary`: full output of `lattice story_get` for the target story if present.
- `doneStorySummary`: summary of DONE artifact for same target when done evidence exists.
- `gapAnalyzeSummary`: raw output of `lattice gap_analyze`.
- `learningSignalSummary`: raw output of `lattice learning_validate` (or explicit refusal with reason) when callable.

Minimal gate-like decision rule used by hosts:

- If `activeStorySummary` or `doneStorySummary` proves DONE-complete, do not claim pending.
- If those summaries are absent or stale, the host must state uncertainty and ask for re-validation.
- If document is `completed/superseded` and target story has a different live status, treat doc as stale and prefer live facts.
- If only memory suggests completion, treat as advisory and never as proof.

Host output must include these fields:

- `prefetchManifest.host`
- `prefetchManifest.targetStoryId`
- `prefetchManifest.bundleFiles` (if persisted to temp cache)
- `prefetchManifest.verdict`: `blocked | no-block | uncertain`
- `prefetchManifest.winSignal`: proof source actually used (for example DONE summary hash / completionCommit).

## 5. Host handoff behavior

If checks conflict:

- If live story/worktree facts say complete but docs say pending -> obey live facts, mark doc as stale.
- If docs are `completed` but live facts show unfinished -> treat docs as advisory only and keep task open.
- If no live facts are available -> explicitly report uncertainty and require explicit revalidation before proceeding.

Output language suggestion:
- “当前以 Story 生命周期事实为准；该文档已标记 `completed/superseded`，并有有效完成 commit，不再重复执行。”

## 6. Documents to update in this track

- `docs/requirements/decisions/truth-first-host-handoff-stale-doc-guard-execution-plan.md` (this document)
- `docs/requirements/decisions/session-ownership-and-write-leases.md` (cross-reference: owner lease + handoff truth)
- `docs/requirements/NAV.md` (add navigation entry)
- `docs/guide.md` (add short operator note for host handoff preflight)

## 7. Execution stories derived (for next implementation story set)

1. Define parsing/consumption schema for `supersession` metadata and inject into handoff prompt context.
2. Add one reusable preflight command path per host entrypoint (Codex/Claude/Antigravity) using the same contract and output format.
3. Add stale-document warning with supersession link when a target is historical or replaced.
4. Add explicit "uncertain until verified" fallback when preflight bundle is incomplete.
5. Add acceptance checks:
   - host-level manual check: no stale claim accepted as active work if live facts show DONE.
   - evidence audit: each warning includes checked story ids + proof refs.
   - preflight artifact check: each handoff output carries `verdict`, `winSignal`, and evidence source names.
6. Add one migration task set to annotate relevant legacy plan-only docs with the canonical `supersession` frontmatter fields:
   - `status`
   - `completedByStory`
   - `completionCommit`
   - `supersededBy`
   - `completionNote`

## 11. 4 Capability Acceptance Matrix (this story gate)

The following must hold before implementation handoff:

- **C1 Host preflight bundle readiness**
  - bundle includes session_brief, dev_memory_preflight, active/DONE summaries, gap_analyze, learning_validate.
  - host wrapper writes at least one `prefetchManifest` key set.
- **C2 Legacy doc machine readability**
  - completed/future plan docs include `supersession.status` and `completionCommit`.
  - docs with `status: completed` include `completedByStory` and one completion evidence pointer.
- **C3 Claim discipline**
  - if host output says “not done”, proof fields are attached.
  - if proof is historical-only, output label is `uncertain` and includes a request for revalidation.
- **C4 Dev-memory preflight injection**
  - Codex/Claude/Antigravity entrypoints call and expose preflight output consistently in handoff context.

## 8. Verification for this story

- Documentation-only PASS criteria:
  - The contract is explicit and unambiguous for all hosts.
  - The execution path includes explicit commands/results and fail-open/closed behavior.
  - The docs that must be touched are listed with concrete target IDs.
- Human review criteria:
  - Contract should be impossible to misread as “memory is proof”.
  - No runtime gate claims are asserted in plan-only scope.

## 9. Completion and supersession trail

This execution plan is completed only when a follow-up implementation story ships runtime preflight.
When implemented, the implementation story must append a short line to this section with
its `storyId`, `target files`, and the `first evidence` proving hosts stop stale rework prompts.

## 10. 3×2 Host Verification Pattern

For this plan only, verification should be executed with:

1. At least 2 hosts (`Codex CLI`, `Claude Code CLI`, then fallback `Antigravity CLI`) on separate handoff paths.
2. 3 review rounds per host for this requirement:
   - Round 1: understand and reproduce stale-doc claim,
   - Round 2: verify command-level preflight contract,
   - Round 3: adversarial checks (missing/partial evidence, conflicting signals, commit mismatch).

Verification evidence that must be recorded for each round:

- host ID / handoff ID used in command output,
- target story id and doc ids checked,
- outcome (block/no-block),
- exact signal that won over stale text (for example DONE commit hash or supersession frontmatter).

### Recommended command sequence (per host)

- `lattice session_brief`
- `lattice story_get '{"storyId":"<target_story>"}'`
- `lattice checklist_get '{"storyId":"<target_story>"}'`
- `lattice gap_analyze` (existing command behavior reference)
- `lattice learning_validate` (advisory confidence check only)

Failure mode for any round:

- If a host cannot demonstrate that higher-order facts were checked before flagging pending work,
  this round is not passed and the plan is not ready for downstream implementation handoff.
