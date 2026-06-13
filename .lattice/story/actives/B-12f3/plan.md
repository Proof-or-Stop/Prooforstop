# B-12f3 Plan

## CHK-001

Inspect only existing surfaces that already produce or explain the PLAN scope blocker.

Current findings:
- `packages/main/src/handlers/story-review.ts` emits `missing_scope_check` when `understanding` exists and `scope-check.json` is absent.
- `packages/main/src/handlers/scope-check.ts` already implements `scope_check_save` and writes signed `scope-check.json`.
- `packages/main/src/cli-engine.ts` registers `scope_check_save` help/schema.
- `packages/main/src/tasks/story-review-ergonomics-smoke.ts` is the narrow existing smoke for story_review message behavior.
- `lattice authority_status --json` reports Authority not configured; Authority claims must fail closed.

No new workflow command is needed.

## CHK-002

Implement a narrow guidance update:
- improve the `missing_scope_check` blocker message in `story-review.ts`;
- update `scope_check_save` help wording in `cli-engine.ts` only to clarify it is reviewer-written PLAN gate evidence;
- do not change `scope-check.ts` signature, phase policy, gate predicates, or process-fact registry.

Required wording facts:
- `scope-check.json` is missing;
- `scope_check_save` already exists;
- the scope-plan reviewer must persist the result;
- the main implementation agent must not self-sign;
- this is local CLI guidance, not Authority Server completion.

## CHK-003

Add targeted smoke coverage in `story-review-ergonomics-smoke.ts`:
- construct a PLAN story with understanding and checklist but without scope-check evidence;
- assert `missing_scope_check` appears;
- assert the message mentions `scope-check.json`, `scope_check_save`, and scope-plan reviewer evidence;
- assert the message does not imply self-signing or Authority completion.

Run:
- `npm --prefix packages/main run build`
- targeted smoke command if available through package scripts or direct dist task after build;
- `npm test` or `lattice validate --story=B-12f3 --json` as lifecycle validation.

## CHK-004

Run the closure path with Authority-enforced semantics:
- record `lattice authority_status --json` and `lattice autopilot_execute --mode=authority --storyId=B-12f3 --until=DONE --dryRun --json` as evidence that Authority completion fails closed without configured readiness/receipt;
- complete local REVIEW/TEST/DONE only as Non-authority Lattice lifecycle evidence unless a verified `gate_decision` receipt is provided;
- use stronger two-host audit before DONE because this touches gate/process guidance;
- do not claim `receiptVerified`, `authorityDone`, `productionDone`, or `fullAuthorityDone`.
