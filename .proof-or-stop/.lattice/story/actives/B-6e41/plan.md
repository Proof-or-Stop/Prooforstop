# Plan: B-6e41 Add ClaimAdmissibilityPack interface and read-only pack registry

## CHK-001: Define ClaimAdmissibilityPack and related adapter contract types

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/claim-admissibility/pack-framework.ts
- Test: packages/main/src/tasks/claim-admissibility-pack-framework-smoke.ts

**Verify**:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:claim-admissibility-pack-framework`

**DoneWhen**:
- `ClaimAdmissibilityPack` and related schema, verifier, gate-policy, and benchmark descriptor types exist.
- The built-in `code-runtime` descriptor satisfies the contract.
- Benchmark harness definitions are optional.
- No pack contract field mints `productionDone`, Authority completion, scientific truth, hardware validation, or solver improvement claims.

## CHK-002: Implement a read-only pack registry with fail-closed validation

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/claim-admissibility/pack-framework.ts
- Test: packages/main/src/tasks/claim-admissibility-pack-framework-smoke.ts

**Verify**:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:claim-admissibility-pack-framework`

**DoneWhen**:
- The default registry lists and resolves the built-in `code-runtime` pack.
- Unknown pack ids return deterministic `not_found` diagnostics instead of throwing.
- Duplicate pack ids, schema ids, artifact kinds, aliases, and claim ids fail validation deterministically.
- The registry remains read-only and creates no proof storage, ledger, or lifecycle gate.

## CHK-003: Expose the pack framework through the admissibility compatibility entrypoint

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/core/evidence/admissibility/index.ts
- Modify: packages/main/package.json
- Test: packages/main/src/tasks/claim-admissibility-pack-framework-smoke.ts

**Verify**:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:claim-admissibility-pack-framework`

**DoneWhen**:
- The compatibility entrypoint exports pack registry functions and types.
- Existing proof-admissibility exports remain available from the same entrypoint.
- No second proof manager, ledger, storage root, or lifecycle gate export is introduced.

## CHK-004: Add focused smoke coverage for M1 pack registry behavior

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: packages/main/package.json
- Create: packages/main/src/tasks/claim-admissibility-pack-framework-smoke.ts

**Verify**:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:claim-admissibility-pack-framework`

**DoneWhen**:
- The focused smoke prints `pack contract exposes code-runtime pack`.
- The focused smoke prints `duplicate pack ids: BLOCK` and `duplicate artifact aliases: BLOCK`.
- The focused smoke prints `compat entrypoint exports pack registry`.
- The focused smoke ends with `claim-admissibility pack framework smoke passed`.
