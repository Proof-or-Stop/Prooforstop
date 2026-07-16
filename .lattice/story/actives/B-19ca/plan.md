# Plan: B-19ca Typed agent dispatch registry

## CHK-001: Define the canonical typed agent registry and compatibility aliases

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/types.ts
- Create: packages/main/src/core/agent-dispatch-registry.ts
- Test: packages/main/src/tasks/agent-dispatch-registry-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/agent-dispatch-registry-smoke.js` enumerates every canonical role and legacy alias with no duplicate alias, prompt class, phase, cardinality, identifier, or authority mismatch.
- Unknown and blank explicit agent types resolve to typed errors; only omitted agentType resolves to the deliberate implementer default.

**DoneWhen**:
- Registry entries declare canonical name, aliases, role class, phases, target cardinality and identifier kinds, prompt class/builder key, state-changing commands, commit permission, reviewer lane, and evidence ownership.
- The registry includes implementer, verification-intent/test aliases, INIT/product/scope/story/item/coverage/delivery reviewers, finding repair, and cluster repair without prefix-derived privileges.

## CHK-002: Route dispatch schemas, handlers, prompts, and hints through the registry

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/story-dispatch.ts, packages/main/src/cli/command-catalog.ts, packages/main/src/handlers/transition-effects.ts, packages/main/src/handlers/checklist.ts, packages/main/src/core/review-run.ts
- Create: none
- Test: packages/main/src/tasks/agent-dispatch-registry-smoke.ts, packages/main/src/tasks/review-pass-discard-smoke.ts

**Verify**:
- `lattice dispatch --storyId=B-19ca --itemId=CHK-001 --agentType=verification-intent` emits a verification-intent prompt with no git commit or status:done guidance.
- Unknown types and invalid story/item/finding/cluster combinations exit nonzero with accepted type and cardinality guidance.
- Every lifecycle hint that names a dispatch supplies the identifiers required by the same registry contract.

**DoneWhen**:
- Dispatch validates type, phase, target cardinality, and identifier kind before selecting a prompt.
- Legacy test-intent and test-case-reviewer aliases route deliberately to role-safe prompts.
- Reviewer and implementer mutation boundaries consume registry role/authority helpers, preventing reviewer checklist completion and implementer reviewer-pass minting.

## CHK-003: Prove every type, alias, phase, cardinality, prompt class, and denied command class

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/core/process-fact-registry.ts, packages/main/src/core/process-fact-levels.ts, scripts/verify-process-fact-contract.mjs, packages/main/src/tasks/command-catalog-smoke.ts, docs/requirements/decisions/workflow-convergence-failure-remediation-execution-plan.md
- Create: packages/main/src/tasks/agent-dispatch-registry-smoke.ts
- Test: packages/main/src/tasks/agent-dispatch-registry-smoke.ts, packages/main/src/tasks/command-catalog-smoke.ts, scripts/verify-process-fact-contract.mjs

**Verify**:
- `npm --prefix packages/main run build` passes.
- `node packages/main/dist/tasks/agent-dispatch-registry-smoke.js` passes the full table-driven positive and negative matrix.
- `node packages/main/dist/tasks/command-catalog-smoke.js` and `node scripts/verify-process-fact-contract.mjs` pass.
- `lattice validate --story=B-19ca` covers every must verificationIntent.

**DoneWhen**:
- Tests execute every registry entry and alias across allowed/disallowed phases, valid/invalid cardinality, prompt class, schema-valid examples, and denied mutation class.
- Process-fact registry and the decision document describe the same mechanical dispatch authority and compatibility contract.
- The RED-B19CA-DISPATCH reproduction is green on the implementation commit.
