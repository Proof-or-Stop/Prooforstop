# Plan: B-5e4a Register acceptance-topology artifact filenames in the lifecycle scope registry

## CHK-001: Register the four missing acceptance-topology artifact filenames in LATTICE_LIFECYCLE_ARTIFACT_FILENAMES

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/lifecycle-registry.ts

**Verify**:
- `npm --prefix packages/main run build` compiles
- Node repro against dist: `classifyLifecycleArtifact('.lattice/story/actives/B-bf52/acceptance-basis.json')` returns `{kind: 'lifecycle', ...}` (and same for pre-review-check.json, topology-critic-receipt.json, topology-exclusion-approvals.json)
- Negative control: an unregistered basename (e.g. `random.json`) in the same story dir still returns null

**DoneWhen**:
- The four filenames appear in `LATTICE_LIFECYCLE_ARTIFACT_FILENAMES` grouped under a comment naming their acceptance-topology origin (commits bff1a4c277 / 78a483a4d6, B-5e4a)
- `authority-receipt-refs.json` is NOT added (explicitly excluded; see scope-boundary excludedScope)
- No other change to the classifier logic, relative-paths set, or trust policy

## CHK-002: Add a registry-coverage invariant smoke so unregistered story artifacts cannot silently regress

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files** (per OQ-1 resolution — evidence split across the doc-canonical script and the registry contract):
- Modify: packages/main/src/tasks/lifecycle-registry-contract.ts (runtime invariant home — it already does named-divergence cross-checks)
- Modify: scripts/verify-process-fact-contract.mjs (doc-canonical source-level assertion: the four new filenames are present in the LATTICE_LIFECYCLE_ARTIFACT_FILENAMES initializer, in the script's existing extractConstInitializer style)
- Modify: docs/requirements/decisions/lifecycle-artifact-scope.md (add one bullet to the #Verification evidence inventory naming the new registry-contract evidence)
- Modify: packages/main/src/validate.ts or the npm script wiring only if a new task file is created and needs wiring (check how lifecycle-registry-contract is currently wired first — likely `npm run test:*` script in packages/main/package.json)

**Verify**:
- The new check asserts, via `classifyLifecycleArtifact`, that each of the four newly registered filenames classifies as `kind='lifecycle'` under `.lattice/story/actives/<id>/`
- The new check derives the set of top-level story artifact filenames StoryStore writes by scanning packages/main/src/core/store.ts source for single-segment relative-path literals passed to writeJson/readJson-style helpers (no slash in the literal), then asserts every derived filename is in `LATTICE_LIFECYCLE_ARTIFACT_FILENAMES` or in a named exemption constant
- Exemption constant contains exactly `authority-receipt-refs.json` with a comment: dead writeLegacyReceiptRefs path, Authority future-capability domain, register it when its write path goes live
- Sanity floor: derived set size must be >= 40 (store.ts currently references ~50 top-level filenames); a shrunken/empty derivation fails loudly
- Divergence message names each missing filename explicitly
- Temporarily deleting one filename from the registry (local scratch mutation, then restore) makes the check fail naming that filename — record transcript as evidence
- `lattice validate` (or the wired test script) runs the check green on the final tree

**DoneWhen**:
- The invariant is wired into the same execution path sibling contract checks use (visible in `lattice validate` or `npm run test:*` consumed by validate)
- `npm run test:process-fact-contract` passes with the new source-level assertion in place
- The lifecycle-artifact-scope.md #Verification inventory names the new registry-contract evidence
- Positive and negative evidence recorded via `verification_evidence_add` for all must intents of CHK-001 and CHK-002
