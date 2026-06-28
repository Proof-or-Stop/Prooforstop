# Plan: B-8628 Tighten repro-first classification to material-code bug/feature

## CHK-001: Refine classifyReproFirstRequirement

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/repro-evidence-binding-gate.ts

**Verify**:
- `npm --prefix packages/main run build` compiles (no circular import).
- classifyReproFirstRequirement: docs-bug/docs-feature/refactor/chore/no-file -> required=false; material bug/feature -> true; high/critical+code-verifiable-risk -> true.

**DoneWhen**:
- required = (type in {bug,feature} AND checklist declares >=1 material-code file via classifyReviewAssuranceFloorPath) OR (priority high|critical AND a CODE_VERIFIABLE_RISK_CATEGORIES hit). Else false.
- bare bug_story + bare file_declarations rules removed. resolveReproFirstPreflightMode / modes / resultFor / bypass reasonCode untouched. If circular import, extract a tiny shared material-path helper.

## CHK-002: Update the classification smokes + red/spike regression

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/tasks/repro-evidence-binding-dev-gate-smoke.ts
- Test: packages/main/src/tasks/repro-evidence-binding-dev-gate-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/repro-evidence-binding-dev-gate-smoke.js` prints its pass line.
- `npm test` green.

**DoneWhen**:
- The smoke (and repro-first-candidate-smoke.ts if it asserts classification) updated to the refined behavior; red/spike regression asserts both directions: {docs-only bug, docs feature, material refactor, chore-with-material, no-file bug} -> required=false AND {material bug, material feature, high/critical+code-verifiable-risk} -> required=true.
