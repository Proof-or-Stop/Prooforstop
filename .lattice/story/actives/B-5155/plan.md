# B-5155 Execution Plan

## Scope Principles

This story fixes three current `gap_analyze` high-priority truth-to-code mapping failures. It does not implement new product behavior unless inspection proves an actual missing implementation. Local Lattice CLI evidence remains Non-authority evidence; no Authority Server receipt-backed completion is claimed.

If any cited implementation or boundary is not real, stop that checklist item, record a finding, and keep the gap visible. Do not add annotation text merely to make the dashboard green.

## CHK-001

Goal: bind `decision-doc-promotion-execution-plan.md:174` `verificationRequirements` to existing decision-doc promotion implementation and smoke coverage.

Allowed edits:
- Add a file-level `@task B-5155` annotation anchor to `packages/main/src/tasks/decision-doc-promotion-smoke.ts`.
- Mention only the existing covered facts: proposal verificationRequirements, preview/save behavior, missing-field rejection, and separation of local quorum from receipt-backed completion.

Verification:
- Inspect the smoke file before editing.
- Run the decision-doc promotion smoke after build.
- Run `lattice gap_analyze --json` and confirm the selected row no longer appears.

Stop condition:
- If the smoke or handler does not actually cover the cited requirement, record a B-5155 finding and do not add the annotation.

## CHK-002

Goal: bind `lattice-runtime-owned-agent-assets-execution-plan.md:249` `requirementsDir` to existing runtime-owned prompt asset and project-structure handling.

Allowed edits:
- Add a file-level `@task B-5155` annotation anchor to `packages/main/src/tasks/runtime-owned-agent-assets-smoke.ts`.
- Mention that project config facts such as `requirementsDir` remain separate from prompt asset ownership, and that runtime-owned prompt registry works without project-local prompt config.

Verification:
- Inspect the smoke file before editing.
- Run the runtime-owned agent asset smoke after build.
- Run `lattice gap_analyze --json` and confirm the selected row no longer appears.

Stop condition:
- If requirementsDir is not actually preserved as project structure configuration, record a B-5155 finding and do not add the annotation.

## CHK-003

Goal: bind the `customerKeyRef` redacted/non-secret row to the existing future/blocked boundary without implementing the locked suite.

Allowed edits:
- Prefer a narrow `@task B-5155` annotation next to the existing `customerKeyRef` scope anti-expansion boundary in `packages/main/src/core/scope-anti-expansion.ts`.
- Touch `packages/main/src/tasks/authority-status-smoke.ts` only if the scope-boundary annotation alone does not truthfully clear the gap.

Forbidden edits:
- Do not implement a customer key reference field, producer, loader, verifier, receipt path, evaluator consumption, or Layer 4 production-safety unlock.
- Do not introduce `receiptVerified=true`, `productionDone=true`, `authorityDone=true`, or `fullAuthorityDone=true`.

Verification:
- Run `lattice gap_analyze --json` and confirm the selected row no longer appears.
- Review the diff for Authority/production completion overclaim.

Stop condition:
- If existing code cannot truthfully represent the future/blocked boundary, record a finding instead of expanding scope.

## CHK-004

Goal: prove the three selected high gaps are gone and document any unrelated residual blockers separately.

Commands:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/decision-doc-promotion-smoke.js`
- `node packages/main/dist/tasks/runtime-owned-agent-assets-smoke.js`
- `node packages/main/dist/tasks/authority-status-smoke.js` if CHK-003 touches that file
- `lattice gap_analyze --json`
- `lattice convergence_check --json`
- `lattice validate --story=B-5155 --json`

Acceptance:
- `lattice gap_analyze --json` reports `Gaps: 0 high / 0 medium`.
- `lattice convergence_check --json` has `No high-priority gaps` PASS, even if unrelated active-story or legacy annotation checks remain.
- Verification evidence states this is local Non-authority evidence only.
