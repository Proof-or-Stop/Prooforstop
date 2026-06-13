# B-56ce Execution Plan

## Purpose
Improve Lattice CLI flow recovery diagnostics for verified operator confusion without changing lifecycle gate pass/fail semantics. The work remains host-neutral: ordinary flow commands stay `lattice ...`; Codex-specific adapter commands remain limited to `lattice codex verify` and `lattice codex doctor`.

## Guardrails
- Do not optimize for optimization; no new broad command framework.
- Do not change validation status, stale evidence freshness rules, owner lease ownership rules, or delivery-check DONE requirements.
- Do not allow the main agent to forge delivery reviewer authority.
- Only fix verified recovery correctness gaps and keep logic consistent across CLI surfaces.

## CHK-001
Add explicit timeout diagnostics in `packages/main/src/core/validation-executor.ts` when a validation command is killed by timeout. Include the configured timeout value when available and point to `validate.commands[].timeoutMs`. Verification: update `packages/main/src/tasks/validation-protocol-smoke.ts` to assert timeout remains `status=fail` and the details include the timeout/config hint.

## CHK-002
Update `packages/main/src/core/evidence-stale-hint.ts` so stale evidence tells the operator it means HEAD/material hash binding changed, not necessarily that the test logic failed. Prefer `lattice` recovery commands over legacy `koala` wording. Verification: update `packages/main/src/tasks/verification-freshness-smoke.ts` to check the shared recovery block text.

## CHK-003
Improve same-worktree owner lease guidance in `packages/main/src/core/story-owner-lease.ts` and `packages/main/src/handlers/session.ts`. Detect when the recorded owner cwd resolves to the current cwd and add safer guidance for context-switch recovery while keeping active foreign leases fail-closed unless `--forceTakeover` is explicit. Verification: extend `story-owner-lease-smoke` for active same-worktree messaging and session_brief rendering.

## CHK-004
Clarify missing delivery-check hints in `packages/main/src/core/done-oracle.ts` and TEST phase guidance in `packages/main/src/handlers/transition-effects.ts`. The hint must state that fallback is compliant only when the `delivery_check_set` invocation carries `koala-review-delivery` provenance, or when the delivery reviewer is rerun. Verification: update `flow-stability-smoke` to assert the missing delivery-check hint includes reviewer provenance/fallback boundary.

## CHK-005
Improve unsupported `lattice codex <core-command>` handling in `packages/main/src/cli-engine.ts`. For known mistaken core commands such as `session_brief` and `aux_doc_list`, suggest the ordinary `lattice session_brief` / `lattice aux_doc_list` form while preserving `lattice codex verify/doctor` as adapter-specific aliases. Verification: add CLI smoke coverage that `node dist/cli.js codex session_brief` exits non-zero with the ordinary command suggestion.

## Scope Contract
The enforce scope contract is initialized from the PLAN checklist. Runtime/source changes are limited to the seven declared CLI diagnostic files, and tests are limited to the five declared smoke files. Truth docs are related context, not edit targets for this story.

## Validation Checklist
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:validation-protocol`
- `npm --prefix packages/main run test:verification-freshness-smoke`
- `npm --prefix packages/main run test:story-owner-lease-smoke`
- `npm --prefix packages/main run test:flow-stability-smoke`
- `npm --prefix packages/main run test:legacy-koala-compatibility-smoke`
- Codex alias smoke command for `codex session_brief` after build
- `node bin/lattice.js validate --story=B-56ce` during TEST
