# CLI Engine Modularization Execution Plan

Story: B-0717
Date: 2026-06-18
Status: execution plan
Current local Authority status: off / not-configured
Primary source file: `packages/main/src/cli-engine.ts`

## Purpose

This document defines the execution plan for splitting the large Lattice CLI
engine into smaller modules without changing command behavior, lifecycle gates,
or test-facing exports accidentally.

B-0717 is documentation only. It does not refactor
`packages/main/src/cli-engine.ts`, does not decompose the CLI engine, and does
not claim Authority Server completion in this local run.

The plan is specific enough for later hosts to execute as separate implementation
stories, with explicit compatibility contracts, review strength, and stop
conditions.

## Non-Goals

- Do not refactor `packages/main/src/cli-engine.ts` in B-0717.
- Do not move command handlers in this story.
- Do not rename public commands, aliases, or test-facing exports.
- Do not use local Authority readiness, local verdicts, or documentation text as
  proof of production Authority completion.
- Do not treat a 3 rounds x 1 host fallback as equivalent to 3 rounds x 2
  independent hosts for major architecture work.

## Current Inventory

`packages/main/src/cli-engine.ts` is currently 4450 lines.

It owns these high-risk surfaces:

- `MAIN_TOOLS`, including command catalog entries and Zod schemas.
- Help and dry-run rendering.
- `parseFlags`, `parseFlagsTest`, `coerce`, and `addValue`.
- Alias handling.
- Root and worktree resolution.
- Owner lease gates and reviewer read-only gates.
- Activity policy.
- Git and INIT_CHECK metadata sync.
- `runCli` special dispatch for `story_create`,
  `story_advance INIT_CHECK`, and `recover_evidence`.

Handlers are mostly already split through:

- `packages/main/src/registry.ts`
- `packages/main/src/handlers/*`

The modularization should therefore avoid moving business handlers first. The
highest value is to extract the CLI engine shell around the existing handler
registry while preserving imports and tests that currently target
`cli-engine.ts`.

## Compatibility Contract

Future implementation stories must preserve or deliberately migrate every
test-facing and re-export-facing symbol below. If any symbol moves, the story
must keep a compatibility re-export from `packages/main/src/cli-engine.ts` until
all internal and external consumers have migrated.

Required compatibility symbols:

- `MAIN_TOOLS`
- `parseFlags`
- `parseFlagsTest`
- `coerce`
- `addValue`
- `ownerLeaseHelpBlock`
- `resolveEffectiveOwnershipClass`
- `enforceStoryOwnerLeaseGate`
- reviewer read-only helpers
- `commitInitCheckMetadataAndMergeMain`

The compatibility check for each round is:

```bash
npm --prefix packages/main run build
rg -n "MAIN_TOOLS|parseFlags|parseFlagsTest|coerce|addValue|ownerLeaseHelpBlock|resolveEffectiveOwnershipClass|enforceStoryOwnerLeaseGate|commitInitCheckMetadataAndMergeMain" packages/main/src packages/main/tests scripts
```

Stop if a consumer changes behavior because an import path moved, a function is
no longer exported, command help differs unexpectedly, or lifecycle dispatch
ordering changes.

## Target Module Boundaries

### Round 1 - Command Catalog And Schema Modules

Intended future modules:

- `packages/main/src/cli/command-catalog.ts`
- `packages/main/src/cli/command-schemas.ts`
- `packages/main/src/cli/main-tools.ts`

Scope:

- Move `MAIN_TOOLS` and schema-only command metadata behind catalog modules.
- Keep `MAIN_TOOLS` re-exported from `packages/main/src/cli-engine.ts`.
- Do not change handler registration, `runCli`, aliases, or flag parsing.

Acceptance checks:

- `npm --prefix packages/main run build`
- `node scripts/verify-process-fact-contract.mjs`
- A command catalog smoke that compares command names before and after the move.
- Help output smoke for representative commands, including `story_create`,
  `story_advance`, `authority_receipt_verify`, and `validate`.

Stop conditions:

- Any command disappears from `MAIN_TOOLS`.
- Any schema enum, default, or `.describe(...)` text changes unintentionally.
- Registry and catalog disagree about a command that existed before the round.

### Round 2 - Flags, Help, And Aliases

Intended future modules:

- `packages/main/src/cli/flags.ts`
- `packages/main/src/cli/help.ts`
- `packages/main/src/cli/aliases.ts`
- `packages/main/src/cli/dry-run.ts`

Scope:

- Move `parseFlags`, `parseFlagsTest`, `coerce`, `addValue`, help rendering,
  dry-run rendering, and alias normalization into dedicated modules.
- Keep compatibility re-exports from `cli-engine.ts`.
- Preserve exact JSON stdout behavior for commands that promise structured
  output.

Acceptance checks:

- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:command-ownership-contract`
- JSON stdout smoke through the package script if one exists.
- If no package script exists for JSON stdout smoke, run after build:

```bash
node packages/main/dist/tasks/cli-json-stdout-contract-smoke.js
```

Stop conditions:

- A boolean, array, number, or JSON flag parses differently.
- Alias resolution changes command selection.
- Help or dry-run output drops owner lease guidance or Authority disclaimers.
- Structured JSON stdout gains non-JSON log lines.

### Round 3 - Runtime Root, Activity, Ownership, And Reviewer Gates

Intended future modules:

- `packages/main/src/cli/runtime-root.ts`
- `packages/main/src/cli/activity-policy.ts`
- `packages/main/src/cli/ownership-gate.ts`
- `packages/main/src/cli/reviewer-readonly-gate.ts`

Scope:

- Move root/worktree resolution, activity policy, owner lease helpers, effective
  ownership class resolution, `enforceStoryOwnerLeaseGate`, and reviewer
  read-only helpers.
- Keep compatibility re-exports from `cli-engine.ts`.
- Do not alter command classifications without an explicit process-fact contract
  update.

Acceptance checks:

- `npm --prefix packages/main run build`
- `node scripts/verify-process-fact-contract.mjs`
- `npm --prefix packages/main run test:command-ownership-contract`
- `npm --prefix packages/main run test:main-write-lock-coverage`

Stop conditions:

- A story-scoped mutating command bypasses owner lease checks.
- A reviewer lane gains write access outside its allowed command set.
- Read-only commands start writing activity or story artifacts unexpectedly.
- Process fact registry and runtime command policy drift.

### Round 4 - Lifecycle Special Dispatch And INIT_CHECK Metadata Sync

Intended future modules:

- `packages/main/src/cli/run-cli.ts`
- `packages/main/src/cli/lifecycle-dispatch.ts`
- `packages/main/src/cli/init-check-metadata-sync.ts`
- `packages/main/src/cli/recover-evidence-dispatch.ts`

Scope:

- Move `runCli` special dispatch around `story_create`,
  `story_advance INIT_CHECK`, and `recover_evidence`.
- Move `commitInitCheckMetadataAndMergeMain` behind an INIT_CHECK metadata sync
  module while preserving compatibility re-export.
- Keep lifecycle ordering and failure behavior unchanged.

Acceptance checks:

- `npm --prefix packages/main run build`
- `node scripts/verify-process-fact-contract.mjs`
- `npm --prefix packages/main run test:command-ownership-contract`
- INIT_CHECK reconcile smoke.
- INIT_CHECK conflict smoke.
- `recover_evidence` dispatch smoke.

Stop conditions:

- `story_create` loses main write lock or dedup behavior.
- `story_advance INIT_CHECK` writes phase metadata without matching worktree
  bootstrap semantics.
- Metadata sync can silently overwrite main or story worktree state.
- `recover_evidence` no longer uses its single-shot special dispatch path.

## Lattice Authority Server Strong-Verification Flow

This local B-0717 run has Authority mode `off` and status `not-configured`.
That is readiness information only. It is not production Authority completion.

When a future implementation story runs in a configured Authority environment,
the strong-verification path is:

1. Run `authority_status --json` and require readiness for the selected
   Authority mode.
2. Use `authority_job_create` to create a signed job plan that names the story,
   head hash, material hash, artifact anchors, planned steps, and expected gate.
3. Have independent hosts submit `authority_verdict_submit` entries over the
   same head, material, artifact, prompt, and validation anchors.
4. Use `authority_job_status` to require host reconciliation. Matching verdict
   text is not enough; the status must show the required independent host facts
   and anchor agreement.
5. Use `authority_receipt_verify` only against a production
   `gate_decision` receipt proof.
6. Allow lifecycle gates to consume only verified production receipt refs.

Local status, readiness, local-only verdicts, shadow transport acceptance, and
diagnostic output cannot claim production Authority completion. They may explain
what is missing, but they must not satisfy lifecycle Authority gates.

## Local Quorum Flow Without Configured Authority

When Authority is not configured, high-risk local review uses quorum evidence
instead of production Authority receipts.

Default high-risk path:

```text
3 rounds x 2 independent hosts
```

Each counted host verdict must bind to the same story id, head hash, material
hash, artifact anchors, prompt or review profile digest, and validation state.
Hosts must be independent by durable host/session/key identity, not just by
display name.

Degraded fallback:

```text
3 rounds x 1 host
```

This fallback is lower assurance. It is allowed only when policy or explicit
human approval permits a single-host environment or temporary host
unavailability. It is never equivalent to 3x2 for major architecture work and
must be labeled as degraded in status, evidence, and final summaries.

## Verification Matrix

Baseline commands for implementation stories:

```bash
npm --prefix packages/main run build
node scripts/verify-process-fact-contract.mjs
npm --prefix packages/main run test:command-ownership-contract
npm --prefix packages/main run test:main-write-lock-coverage
```

JSON stdout smoke:

- Run the package script if a JSON stdout contract script exists.
- If no package script exists, build first and run:

```bash
node packages/main/dist/tasks/cli-json-stdout-contract-smoke.js
```

Round-specific additions:

| Round | Additional checks |
| --- | --- |
| Round 1 | Command catalog name/schema diff; representative `--help` smokes. |
| Round 2 | Flag coercion matrix; alias matrix; JSON stdout smoke. |
| Round 3 | Owner lease allow/deny smoke; reviewer read-only allow/deny smoke; activity write/no-write smoke. |
| Round 4 | INIT_CHECK reconcile smoke; INIT_CHECK conflict smoke; `recover_evidence` dispatch smoke. |

If any command above does not exist in the implementation branch, stop and add
or document the missing verification surface before continuing the refactor.

## Implementation Story Split

Create one future story per round:

| Future story | Scope freeze | Scope contract | Review requirement |
| --- | --- | --- | --- |
| Round 1 catalog/schema | Only command catalog and schemas. | `cli-engine.ts` re-exports `MAIN_TOOLS`; no handler or dispatch moves. | 3x2 review, plus Authority receipt path where configured. |
| Round 2 flags/help/aliases | Only parser, help, dry-run, alias surfaces. | Re-export parser helpers; preserve JSON stdout and help disclaimers. | 3x2 review, plus Authority receipt path where configured. |
| Round 3 runtime/gates | Only root, activity, ownership, reviewer gates. | Re-export owner/reviewer helpers; no command classification drift without registry updates. | 3x2 review, plus Authority receipt path where configured. |
| Round 4 lifecycle dispatch | Only `runCli` special dispatch and INIT_CHECK metadata sync. | Re-export `commitInitCheckMetadataAndMergeMain`; preserve lifecycle ordering. | 3x2 review, plus Authority receipt path where configured. |

Each story must freeze scope before DEV, list the exact exported symbols it will
move, list the compatibility re-exports it will keep, and attach review evidence
to the same head/material/artifact anchors.

## Rollback And Stop Conditions

Rollback should be simple at every round: revert only that round's module moves
and restore the prior `cli-engine.ts` imports/re-exports. Do not continue to the
next round while any compatibility or lifecycle smoke is red.

Stop immediately if:

- `cli-engine.ts` no longer re-exports required compatibility symbols.
- A lifecycle command changes gate behavior without process-fact registry and
  verification updates.
- Any Authority status is presented as production completion without a verified
  production `gate_decision` receipt ref.
- 3x1 degraded review is described as equal to 3x2.
- JSON stdout contract smokes fail.
- Owner lease or reviewer read-only gates become less strict.
- INIT_CHECK metadata sync can overwrite or lose main/worktree state.

## Reviewer Checklist

- Confirm B-0717 changed only this decision document.
- Confirm the document does not claim `cli-engine.ts` has been decomposed.
- Confirm the current Authority status is stated as off / not-configured and not
  production completion.
- Confirm all required compatibility symbols are listed.
- Confirm each round has module names, acceptance checks, and stop conditions.
- Confirm future stories require scope freeze, scope contract, 3x2 review, and
  Authority receipt path where configured.
- Confirm 3x1 is labeled as degraded fallback only.
- Confirm Round 4 includes INIT_CHECK reconcile and conflict smokes.
