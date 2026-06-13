# B-12f3 Transcript Diff

## Expected

When `story_review` reports `missing_scope_check`, the operator-facing message
should state:

- `scope-check.json` is the missing PLAN gate evidence.
- `scope_check_save` already exists.
- a `koala-review-scope-plan` / scope-plan reviewer must persist the result.
- the implementation/main agent must not self-sign or manually edit story
  metadata.
- local CLI guidance is not Authority Server completion.

`scope_check_save --help` should identify the command as reviewer-written PLAN
scope evidence consumed by `story_review`.

Authority-enforced execution must fail closed without configured Authority
readiness and a verified native `gate_decision` receipt.

## Actual

Real-machine checks from
`/Users/jek/Documents/Work/Orchestrate/.worktrees/B-12f3`:

```text
npm --prefix packages/main run build
> @lattice-agent/core@0.3.5 build
> tsc

node packages/main/dist/tasks/story-review-ergonomics-smoke.js
✓ story review ergonomics smoke passed

node packages/main/dist/cli.js scope_check_save --help
lattice scope_check_save — Save reviewer-written PLAN scope evidence
(scope-check.json) consumed by story_review; intended for
koala-review-scope-plan/scope-plan reviewers.

lattice validate --story=B-12f3 --json
status: pass
summary: Project validation commands passed
command: npm test
result: PASS
verificationIntent coverage: 12/12 covered, 0 required missing
```

Authority fail-closed evidence:

```text
lattice authority_status --json
authorityMode: off
authorityReady: false
receiptVerified: false
productionDone: false

lattice autopilot_execute --mode=authority --storyId=B-12f3 --until=DONE --dryRun --json
status: fail
authorityDone: false
fullAuthorityDone: false
receipt.provided: false
```

Review evidence:

```text
REVIEW lanes: concept PASS, quality PASS, test-coverage PASS
Final local two-host audit: Claude-style PASS, Codex-style PASS
findings: none
```

## Difference

Actual matches the expected local CLI behavior. The change improves
`missing_scope_check` guidance and `scope_check_save` help without changing the
scope gate, schema, command ownership, or Authority receipt semantics.

Authority completion is not claimed. The Authority path is classified as blocked
until a real Authority Server and verified native `gate_decision` receipt are
provided.
