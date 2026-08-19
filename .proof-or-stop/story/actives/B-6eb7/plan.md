# Plan: B-6eb7 Align repro-first process-fact rationale prose

## CHK-001: Update the three repro-first rationale strings to material-code bug/feature semantics

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/process-fact-levels.ts
- Modify: packages/main/src/core/process-fact-registry.ts

**Verify**:
- `grep -rn 'file-declaring' packages/main/src/core/process-fact-levels.ts packages/main/src/core/process-fact-registry.ts` returns nothing.
- `node scripts/verify-process-fact-contract.mjs` prints "Process fact contract verified".
- `npm test` green.

**DoneWhen**:
- The three rationale strings (process-fact-levels.ts runtime:repro_first_story_intake_preflight + story_create_from_repro; process-fact-registry.ts story-evidence-binding) read "material-code bug/feature" (plus high/critical code-verifiable for the preflight one) instead of "file-declaring stories".
- Only rationale text changed; no structural/gateConsumer/logic change; behavior zero.
