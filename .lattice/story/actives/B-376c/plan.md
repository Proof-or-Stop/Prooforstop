$(cat <<EOF
# Plan: B-376c Align lifecycle-control with full global control-plane baseline

## CHK-001: Reconcile migration milestone IDs

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/lifecycle-control/milestones.ts
- Create: packages/main/src/core/lifecycle-control/milestones.ts
- Test: packages/main/tests/tasks/source-structure-convergence-smoke.ts

**Verify**:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/source-structure-convergence-smoke.js`
- grep the milestone definition confirms CP-0 to CP-5 entries are canonical.

**DoneWhen**:
- CP-0 is explicit migration inventory marker and milestone IDs are normalized to CP-0..CP-5 in canonical order.
- Unknown/non-canonical IDs are rejected by shape checks.

## CHK-002: Align StoryControlStatus and ProjectControlStatus with documented schema

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/lifecycle-control/control-status.ts
- Test: packages/main/tests/tasks/source-structure-convergence-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/source-structure-convergence-smoke.js`
- Unit/integration checks demonstrate runtime/consumption/queue/readiness fields exist on canonical status.
- Legacy lane/queue compatibility fields remain present only as compatibility projection.

**DoneWhen**:
- `StoryControlStatus` and `ProjectControlStatus` include canonical fields as first-class values.
- Compatibility projection keeps legacy fields mapped without breaking current consumers.

## CHK-003: Update lifecycle-control smoke assertions and exports

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/tests/tasks/source-structure-convergence-smoke.ts
- Test: packages/main/tests/tasks/source-structure-convergence-smoke.ts

**Verify**:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/source-structure-convergence-smoke.js`
- Smoke reports no legacy-shape-only passes in strict mode.

**DoneWhen**:
- Smoke explicitly checks milestone count == 6 and canonical status payload shape.
- Legacy-shape only mismatch is reported as mismatch with clear guidance.

## CHK-004: Document compatibility policy in code comments and docs

**Owner**: lattice-implementer
**DependsOn**: CHK-002
**Files**:
- Modify: docs/evidence/evidence-platform-architecture.md
- Modify: packages/main/src/core/lifecycle-control/control-status.ts

**Verify**:
- Manual docs/scan pass confirms canonical versus compatibility field comments are present and aligned.

**DoneWhen**:
- architecture/doc comments mark which lifecycle-control fields are canonical.
- All compatibility-only fields are clearly marked as projection/compatibility.
EOF
)
