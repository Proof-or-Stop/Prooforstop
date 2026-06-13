# Lattice Mid-Flight Story Repair And gitRoot Worktree Bootstrap Plan

Date: 2026-06-13

## Purpose

This document defines the execution plan for fixing the Lattice CLI gaps exposed
by the ClawCreek PR-A story recovery case.

The goal is to let Lattice support a story that was created before the current
PLAN discipline was fully applied, without weakening the second-generation
flow. A completed implementation with recorded evidence should have a
mechanical, auditable repair path when the checklist schema is missing
`verificationIntent`. At the same time, automatic worktree bootstrap must honor
`gitRoot` when Lattice metadata lives in a wrapper directory that is not itself
a git repository.

Problem 3 from the incident, the `checklist_update --help` import error for
`sourceManifestDigest`, is intentionally out of scope for this fix. It was
re-tested against the current global CLI and no longer reproduces. This story
may keep a smoke check for the help command, but it must not spend implementation
time changing `sourceManifestDigest` exports unless the failure is reproduced
again.

## Incident Summary

Observed project layout:

```text
/Users/jek/Documents/ClawCreek
  lattice.config.json
  .lattice/story/actives/...
  clawcreek/                  # configured gitRoot and actual git repository
```

Relevant config:

```json
{
  "scanRoot": ".",
  "testsDir": "tests",
  "storyDir": ".lattice/story/actives",
  "requirementsDir": "docs/requirements",
  "storyPrefix": "S",
  "gitRoot": "clawcreek"
}
```

The affected story, `B-5a12`, did not start cleanly from the current standard
Lattice PLAN flow. Checklist items existed before `verificationIntent` was
filled. Later work added understanding, decision, plan, scope check, checklist
done state, and 21 verification evidence records. `story_review` still blocked
because each checklist item lacked `verificationIntent.happy`,
`verificationIntent.edge`, and `verificationIntent.adversarial`.

The blocking review result is directionally correct: evidence proves behavior,
but intent is the acceptance contract. The defect is that Lattice gives no
first-class way to repair or migrate a mid-flight story whose evidence already
exists.

There was also a bootstrap failure path: Lattice correctly resolved the signed
workspace root to the configured `gitRoot`, but automatic worktree creation
still assumed the current metadata root was the git root in at least part of the
bootstrap path.

## Problems To Fix

### P1. Missing Mid-Flight verificationIntent Repair Path

Current behavior:

- `checklist_update` can set `verificationIntent`, but normal phase protection
  prevents careless late mutation.
- `verification_evidence_add` can add evidence for existing intent refs, but it
  cannot create missing intent entries.
- `story_review` reports `missing_verification_intent` even when evidence exists
  for the corresponding `CHK-xxx:lane:index` refs.

Why this is a product defect:

- The user sees that the code and verification evidence are complete, but
  Lattice cannot close the workflow.
- The only manual workaround is to reconstruct intent one item at a time through
  generic checklist updates, without a repair-specific audit trail.
- A reviewer cannot distinguish "no acceptance contract exists and no evidence
  exists" from "legacy acceptance contract is missing, but evidence can be used
  to reconstruct it".

### P2. gitRoot-Aware Worktree Bootstrap

Current behavior:

- `session_brief` can resolve a signed workspace from configured `gitRoot`.
- The wrapper root may be intentionally non-git.
- Worktree bootstrap can still fail when it runs git operations from the wrong
  root or computes worktree paths from an inconsistent root.

Why this is a product defect:

- The user has a valid Lattice setup: metadata at wrapper root, code repository
  under configured `gitRoot`.
- INIT_CHECK should be able to create `story/B-*` worktrees for that code repo
  without requiring manual intervention.
- If bootstrap fails, the workflow loses the token-saving preflight value that
  Lattice is supposed to provide.

### P3. sourceManifestDigest Help Import Error

Status:

- The prior error was `checklist_update --help` failing due to a missing
  `sourceManifestDigest` export/import.
- The command was re-run against the current global CLI and now succeeds.

Decision:

- Do not fix P3 in this story.
- Do not touch source manifest digest implementation as part of this plan.
- A read-only regression smoke that checks `lattice checklist_update --help`
  still exits zero is acceptable, but it is not the primary fix.

## Design Principles

1. Preserve `verificationIntent` as the acceptance contract.
2. Do not let evidence silently replace intent for normal stories.
3. Make repair explicit, auditable, and phase-aware.
4. Do not mutate existing intent unless the operator explicitly asks for
   replacement and provides a reason.
5. Keep metadata root and git material root separate.
6. Reuse signed workspace resolution instead of adding a second root resolver.
7. Emit actionable review and validation hints that name the repair command.

## Non-Goals

- Do not weaken `story_review` so missing `verificationIntent` simply passes
  when evidence exists.
- Do not allow arbitrary checklist mutation in protected phases.
- Do not change the normal PLAN expectation that intent is written before DEV.
- Do not repair DONE stories automatically.
- Do not change ClawCreek PR-A application code.
- Do not directly edit story JSON files in `.lattice/story` or `docs/story`.
- Do not fix the already-verified `sourceManifestDigest` help import issue
  unless it is reproduced again.

## Proposed Product Behavior

### New Repair Command

Add one explicit command:

```bash
lattice verification_intent_repair '{"storyId":"B-5a12","mode":"fromEvidence","legacyRepair":true,"reason":"Story was adopted after implementation; evidence exists but checklist items predate verificationIntent schema."}'
```

Suggested aliases are optional, but the canonical command should be
`verification_intent_repair`.

Inputs:

| Field | Required | Notes |
| --- | --- | --- |
| `storyId` | yes | Existing story id. |
| `mode` | yes | Start with only `fromEvidence`. Future manual modes can be separate. |
| `items` | no | Optional checklist item ids. Missing means all items. |
| `legacyRepair` | phase-dependent | Required outside PLAN. |
| `reason` | phase-dependent | Required outside PLAN; minimum 30 chars. |
| `dryRun` | no | Prints proposed generated intent without writing. |
| `replaceExisting` | no | Default false; if true, requires stronger reason and should be rare. |

Phase policy:

| Phase | Behavior |
| --- | --- |
| INIT / INIT_CHECK | Refuse; checklist intent belongs to PLAN or later repair. |
| PLAN | Allow without `legacyRepair`; still record repair event. |
| DEV / REVIEW / TEST | Allow only with `legacyRepair:true` and a substantial `reason`. |
| DONE / DISCARDED | Refuse by default. |

Repair semantics:

1. Read checklist through the normal store and command handler.
2. For each selected item, inspect existing `verificationEvidence`.
3. Parse evidence `intentRef` values in the form `CHK-001:happy:0`.
4. For every lane/index with evidence but no intent, synthesize an intent entry.
5. Do not overwrite existing intent unless `replaceExisting:true`.
6. Ignore or report malformed `intentRef` values; do not guess.
7. Refuse to synthesize intent from failing evidence unless an explicit future
   option is designed.
8. Write an audit event that records story id, item ids, lanes, count,
   source evidence refs, phase, operator reason, and current HEAD/material hash
   when available.

Generated intent text should be honest and visibly reconstructed:

```json
{
  "desc": "Reconstructed from existing verification evidence: npm test covered session memory persistence for Postgres-only flow.",
  "type": "logic",
  "priority": "must"
}
```

The text must not pretend the intent was authored before implementation. This
matters because the repair path is a migration path, not the ideal workflow.

Type mapping should be deterministic:

| Evidence kind | Generated intent type |
| --- | --- |
| `logic_test` | `logic` |
| `integration_test` | `logic` or existing canonical integration alias if supported |
| `browser_test` | `browser` |
| `cli_blackbox` | `cli` |
| `manual_transcript` | `cli` |
| unknown supported kind | `cli`, with a note that the type was conservatively inferred |

If the current schema only permits a narrower type set, use the existing
normalizer rather than adding new type values in this story.

### story_review Diagnostic Upgrade

Keep `missing_verification_intent` blocking. Add a more precise diagnostic when
evidence exists for the missing lane:

```text
CHK-001 missing verificationIntent.happy, but evidence exists for CHK-001:happy:0.
Run lattice verification_intent_repair ... to reconstruct audited legacy intent,
or add explicit verificationIntent in PLAN.
```

Structured issue fields should include:

| Field | Example |
| --- | --- |
| `type` | `missing_verification_intent_with_evidence` |
| `severity` | `blocker` |
| `itemId` | `CHK-001` |
| `lane` | `happy` |
| `evidenceRefs` | `["CHK-001:happy:0"]` |
| `suggestedCommand` | `lattice verification_intent_repair ...` |

The old `missing_verification_intent` type may remain for the no-evidence case.
If external tests depend on the old type, preserve it and add a subfield instead
of renaming the issue.

### validate Diagnostic Upgrade

`lattice validate` should continue to evaluate coverage from
`verificationIntent` to `verificationEvidence`. If a story has evidence refs but
no stored intent, validation should print the same repair hint instead of only
reporting missing coverage.

This is a hint, not a pass condition.

### gitRoot-Aware Worktree Bootstrap

Worktree creation should resolve two roots:

| Root | Meaning |
| --- | --- |
| metadata root | Where Lattice config and story metadata live. |
| git material root | The actual git repo, usually `metadataRoot/gitRoot` when configured. |

The bootstrap path must:

1. Resolve the signed workspace using the existing signed workspace resolver.
2. Run git commands from the resolved git material root.
3. Create the story branch from the material repo.
4. Preserve story metadata in the configured story store.
5. Store `story.worktree.path` in the existing format expected by downstream
   commands.
6. Support worktree directory under the wrapper metadata root when configured,
   while using the material repo as the git command cwd.
7. Fail with the same signed-workspace reason vocabulary that `session_brief`
   already uses when `gitRoot` is invalid.

This avoids the split-brain behavior where `session_brief` says the signed
workspace is valid but INIT_CHECK bootstrap cannot use it.

## Likely Implementation Touchpoints

### Intent Repair

Likely files:

| File | Change |
| --- | --- |
| `packages/main/src/handlers/checklist.ts` | Add repair handler or shared checklist mutation helper. |
| `packages/main/src/handlers/story-review.ts` | Add evidence-aware missing-intent diagnostics. |
| `packages/main/src/core/intent-coverage.ts` | Reuse evidence ref parsing and avoid duplicate parsing logic. |
| `packages/main/src/core/verification.ts` | Add repair hint for validation output when legacy evidence exists. |
| `packages/main/src/core/command-policy.ts` | Register the new command policy. |
| `packages/main/src/core/process-fact-levels.ts` | Register repair audit facts if consumed by gates or reviews. |
| `packages/main/src/core/process-fact-registry.ts` | Keep command facts and gate-consumed facts consistent. |
| `scripts/verify-process-fact-contract.mjs` | Update if new process facts are registered. |

If the repair command only writes checklist metadata and audit events that are
not gate-consumed, process fact registration can be minimal. If review or
validate gates consume a new repair artifact, it must be registered.

### Worktree Bootstrap

Likely files:

| File | Change |
| --- | --- |
| `packages/main/src/handlers/worktree.ts` | Use signed workspace git root for branch/worktree git operations. |
| `packages/main/src/core/story-signed-workspace-resolution.ts` | Expose or reuse helper for configured `gitRoot` resolution. |
| `packages/main/src/handlers/context.ts` | Reuse existing unresolved workspace formatting if bootstrap fails. |
| `packages/main/src/handlers/session.ts` | Only update if hints need to mention the repaired bootstrap path. |
| `packages/main/src/tasks/worktree-authority-smoke.ts` | Add nested `gitRoot` bootstrap coverage. |
| `scripts/verify-init-check-bootstrap.mjs` | Extend bootstrap regression coverage if this script owns INIT_CHECK checks. |

## Execution Boundary

### Do

- Add an explicit repair command for missing `verificationIntent` based on
  existing evidence.
- Improve `story_review` and `validate` messages for legacy evidence-without-
  intent cases.
- Fix INIT_CHECK worktree bootstrap to use configured signed workspace git root.
- Add smoke tests for both defects.
- Keep a read-only `checklist_update --help` regression check if cheap.
- Update requirement docs that describe the repair path and `gitRoot` bootstrap.

### Do Not

- Do not edit ClawCreek story JSON directly.
- Do not mutate user application code in ClawCreek.
- Do not bypass protected phase semantics through generic checklist updates.
- Do not treat evidence as a permanent substitute for intent.
- Do not implement sourceManifestDigest changes for P3.
- Do not add broad legacy compatibility that hides malformed evidence refs.

### Stop Conditions

Stop and ask for human decision if:

- Evidence refs cannot be mapped to checklist items deterministically.
- Existing intent conflicts with reconstructed evidence intent.
- The story is already DONE or DISCARDED.
- `gitRoot` points outside the metadata root and existing policy does not allow
  that shape.
- Process fact registry requirements are unclear after adding the repair command.
- A reproduced `sourceManifestDigest` error appears again; that becomes a
  separate defect rather than silently expanding this story.

### Allowed File Classes

Allowed:

- `packages/main/src/**`
- `packages/main/src/tasks/**`
- `scripts/**`
- `docs/requirements/**`
- generated `packages/main/dist/**` only after build, if this repository still
  tracks distribution output for the global CLI path.

Not allowed:

- `docs/story/**`
- `.lattice/story/**`
- `tests/fixtures/**`
- `packages/main/tests/fixtures/**`
- `.omx/**`

## Verification Plan

### Unit / Smoke Scenarios

Add or extend smoke coverage for these scenarios:

1. Legacy story has evidence refs but no intent.
   - `story_review` blocks.
   - Diagnostic names the repair command.
   - `verification_intent_repair --dryRun` prints generated intent.
   - `verification_intent_repair` writes missing intent.
   - `story_review` no longer reports missing intent for repaired lanes.

2. Existing intent is not overwritten.
   - One lane already has authored intent.
   - Repair fills only missing lanes.
   - Existing authored text remains unchanged.

3. Malformed evidence refs fail closed.
   - Evidence ref does not match `CHK-001:happy:0`.
   - Repair reports the malformed refs and leaves story unchanged.

4. Protected phase repair requires explicit legacy reason.
   - In DEV/REVIEW/TEST, missing `legacyRepair:true` fails.
   - Short or empty `reason` fails.
   - Valid reason succeeds and writes audit event.

5. Nested configured `gitRoot` bootstrap works.
   - Metadata root is not git.
   - `gitRoot` points to nested repo.
   - `session_brief` resolves signed workspace.
   - `story_advance INIT_CHECK` creates the story branch and worktree.

6. Invalid `gitRoot` remains clear.
   - Missing or non-git configured root fails with actionable error.
   - Error vocabulary aligns with signed workspace resolution.

7. P3 regression sanity.
   - `lattice checklist_update --help` exits zero.
   - No implementation change to `sourceManifestDigest` is part of the story.

### Manual Replay

Use a copied fixture or temporary project shaped like ClawCreek. Do not mutate
the real `B-5a12` story unless the user explicitly approves.

Replay steps:

```bash
lattice session_brief
lattice story_get '{"storyId":"B-5a12","detail":true}'
lattice verification_intent_repair '{"storyId":"B-5a12","mode":"fromEvidence","legacyRepair":true,"reason":"Story was adopted mid-flight after implementation; existing evidence refs should be used to reconstruct missing verification intent."}'
lattice story_review '{"storyId":"B-5a12"}'
lattice validate --story=B-5a12
```

Expected result:

- Repair command writes intent for all lanes with passing evidence.
- Review no longer blocks on missing `verificationIntent`.
- Any remaining blockers are real story quality gates, not schema migration
  dead-ends.

### Required Commands

Run at minimum:

```bash
npm --prefix packages/main run build
node scripts/verify-process-fact-contract.mjs
node scripts/verify-story-review-structured-output.mjs
node scripts/verify-init-check-bootstrap.mjs
lattice checklist_update --help
```

Also run the new or extended smoke tasks added by the implementation story.

If tracked `dist` is part of the global CLI install path, confirm the built
runtime contains the new command before testing globally.

## Acceptance Criteria

The fix is complete when:

1. A mid-flight story with passing evidence but missing `verificationIntent` can
   be repaired through one explicit Lattice command.
2. The repair is auditable and does not pretend the intent was authored before
   implementation.
3. `story_review` gives a specific repair hint instead of a generic blocker
   when evidence refs exist.
4. Normal PLAN stories still require authored `verificationIntent`.
5. INIT_CHECK can create a worktree for a project whose metadata root is not git
   but whose configured `gitRoot` is valid.
6. Invalid `gitRoot` setups still fail with clear diagnostics.
7. The current `checklist_update --help` behavior remains healthy.
8. No changes are made to `sourceManifestDigest` unless the issue is reproduced
   as a separate story.

## Rollout Notes

After implementation lands on main and the main package is built, global CLI
users should get the new repair command through the normal global Lattice path.
For affected projects, the recommended operator sequence is:

1. Update to the fixed main/global CLI.
2. Run `lattice check` to confirm managed assets are current.
3. Run `lattice session_brief`.
4. Run `verification_intent_repair` only for stories that have legacy evidence
   but missing intent.
5. Re-run `story_review` and `validate`.

This keeps the repair narrow: it fixes historical schema adoption without
relaxing future story discipline.
