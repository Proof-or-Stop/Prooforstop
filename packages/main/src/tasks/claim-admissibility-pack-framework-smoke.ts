#!/usr/bin/env node
/**
 * @task B-6e41
 * @checklist CHK-004
 * @title Smoke claim-admissibility pack framework registry contract
 * @type test
 * @priority high
 * @description
 *   In-memory smoke coverage for the M1 ClaimAdmissibilityPack contract and
 *   read-only registry. It proves the built-in code-runtime pack is exposed,
 *   duplicate ids fail closed, optional benchmark harnesses are accepted, and
 *   the compatibility admissibility entrypoint keeps both old and new exports.
 * @changes
 *   - [CHK-004] Add smoke assertions for default registry, duplicate blocking issues, unknown lookup, and JSON boundary terms.
 */

import assert from 'node:assert/strict';
import {
  CLAIM_ADMISSIBILITY_PACK_CONTRACT_VERSION,
  CODE_RUNTIME_CLAIM_ADMISSIBILITY_PACK,
  CODE_RUNTIME_CLAIM_ADMISSIBILITY_PACK_ID,
  createClaimAdmissibilityPackRegistry,
  getClaimAdmissibilityPack,
  listClaimAdmissibilityPacks,
  validateClaimAdmissibilityPacks,
  type ClaimAdmissibilityPack,
  type ClaimAdmissibilityValidationIssueCode,
} from '../core/claim-admissibility/pack-framework.js';
import * as compatAdmissibility from '../core/evidence/admissibility/index.js';
import type { ProofSurfaceDefinition } from '../core/proof-admissibility.js';

function proofSurface(artifactKind: string, aliases: readonly string[] = []): ProofSurfaceDefinition {
  return {
    artifactKind,
    aliases,
    scope: 'local-diagnostic',
    artifactRole: 'current-verification',
    temporalRole: 'current-state',
    producerBoundary: 'local-runtime-owned',
    schemaVersions: ['test.schema.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: true,
    allowedConsumers: ['PLAN'],
    allowedClaims: [
      { claim: 'diagnostic-status', consumers: ['PLAN'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Synthetic smoke surface for registry duplicate detection.',
    remediation: 'Use unique smoke ids.',
  };
}

function smokePack(
  id: string,
  options: {
    readonly claimSchemaId?: string;
    readonly evidenceSchemaId?: string;
    readonly artifactKind?: string;
    readonly aliases?: readonly string[];
    readonly claimIds?: readonly string[];
  } = {},
): ClaimAdmissibilityPack {
  const claimSchemaId = options.claimSchemaId ?? `${id}.claims`;
  const evidenceSchemaId = options.evidenceSchemaId ?? `${id}.evidence`;
  const artifactKind = options.artifactKind ?? `${id}.artifact`;
  const claimIds = options.claimIds ?? [`${id}.claim`];

  return {
    id,
    version: '1.0.0',
    contractVersion: CLAIM_ADMISSIBILITY_PACK_CONTRACT_VERSION,
    domain: 'smoke',
    displayName: `${id} smoke pack`,
    boundary: {
      runtime: 'local',
      mutation: 'read-only',
      declaration: 'declarative-only',
      claimScope: 'claim-admissibility-only',
      evidenceRuntime: 'existing-proof-admissibility',
      createsStorage: false,
      createsLedger: false,
      createsLifecycleGate: false,
      callerWritableMetadataAdmissible: false,
      completionEligible: false,
    },
    proofSurfaces: [proofSurface(artifactKind, options.aliases)],
    claimSchemas: [
      {
        id: claimSchemaId,
        version: '1.0.0',
        displayName: `${id} claims`,
        claimIds,
        boundary: {
          claimScope: 'claim-admissibility-only',
          completionEligible: false,
          externalGateControl: false,
        },
      },
    ],
    evidenceSchemas: [
      {
        id: evidenceSchemaId,
        version: '1.0.0',
        displayName: `${id} evidence`,
        artifactKinds: [artifactKind],
      },
    ],
    verifierAdapters: [],
    gatePolicies: [],
  };
}

function expectBlockingIssue(
  packs: readonly ClaimAdmissibilityPack[],
  code: ClaimAdmissibilityValidationIssueCode,
  context: string,
): void {
  const result = validateClaimAdmissibilityPacks(packs);
  assert.equal(result.ok, false, `${context} should make registry invalid`);
  assert.ok(
    result.issues.some((issue) => issue.severity === 'blocking' && issue.code === code),
    `${context} should include blocking ${code}; got ${result.issues.map((issue) => issue.code).join(', ')}`,
  );
}

{
  const defaultResult = validateClaimAdmissibilityPacks();
  assert.equal(defaultResult.ok, true, `default registry should validate: ${defaultResult.issues.map((issue) => issue.message).join('; ')}`);

  const packs = listClaimAdmissibilityPacks();
  assert.equal(packs.some((pack) => pack.id === CODE_RUNTIME_CLAIM_ADMISSIBILITY_PACK_ID), true, 'default registry includes code-runtime pack');

  const lookup = getClaimAdmissibilityPack(CODE_RUNTIME_CLAIM_ADMISSIBILITY_PACK_ID);
  assert.equal(lookup.status, 'found', 'code-runtime pack lookup should resolve');
  if (lookup.status === 'found') {
    assert.equal(lookup.pack.boundary.runtime, 'local', 'code-runtime pack is local');
    assert.equal(lookup.pack.boundary.mutation, 'read-only', 'code-runtime pack is read-only');
    assert.equal(lookup.pack.boundary.declaration, 'declarative-only', 'code-runtime pack is declarative');
    assert.equal(lookup.pack.boundary.completionEligible, false, 'code-runtime pack cannot declare completion');
    for (const claimSchema of lookup.pack.claimSchemas) {
      assert.ok(claimSchema.boundary, `${claimSchema.id} declares a claim boundary`);
      assert.equal(claimSchema.boundary.claimScope, 'claim-admissibility-only', `${claimSchema.id} remains claim-admissibility only`);
      assert.equal(claimSchema.boundary.completionEligible, false, `${claimSchema.id} cannot declare completion eligibility`);
      assert.equal(claimSchema.boundary.externalGateControl, false, `${claimSchema.id} cannot control external gates`);
    }
    assert.ok(lookup.pack.proofSurfaces.length > 0, 'code-runtime pack exposes proof surfaces');
    assert.equal(lookup.pack.benchmarkHarnesses, undefined, 'benchmarkHarnesses are optional and absent');
  }

  const registry = createClaimAdmissibilityPackRegistry();
  assert.equal(registry.validate().ok, true, 'created default registry validates');
  assert.equal(registry.resolve('missing-pack').status, 'not_found', 'unknown id returns not_found');

  console.log('pack contract exposes code-runtime pack');
}

{
  const forbiddenTerms = [
    'productionDone',
    'scientificTruth',
    'quantumTheoryClaim',
    'hardwareValidationClaim',
    'physicalValidationClaim',
    'solverImprovementClaim',
    'authorityDone',
  ];
  const packJson = JSON.stringify(CODE_RUNTIME_CLAIM_ADMISSIBILITY_PACK);
  for (const term of forbiddenTerms) {
    assert.equal(packJson.includes(term), false, `pack JSON must not contain ${term}`);
  }
}

expectBlockingIssue(
  [
    smokePack('duplicate-pack', { artifactKind: 'duplicate-pack-a', claimSchemaId: 'duplicate-pack.claims.a', evidenceSchemaId: 'duplicate-pack.evidence.a', claimIds: ['duplicate-pack.claim.a'] }),
    smokePack('duplicate-pack', { artifactKind: 'duplicate-pack-b', claimSchemaId: 'duplicate-pack.claims.b', evidenceSchemaId: 'duplicate-pack.evidence.b', claimIds: ['duplicate-pack.claim.b'] }),
  ],
  'duplicate_pack_id',
  'duplicate pack ids',
);
console.log('duplicate pack ids: BLOCK');

expectBlockingIssue(
  [
    smokePack('schema-pack-a', { claimSchemaId: 'duplicate.claim.schema', artifactKind: 'schema-pack-a.artifact', evidenceSchemaId: 'schema-pack-a.evidence', claimIds: ['schema-pack-a.claim'] }),
    smokePack('schema-pack-b', { claimSchemaId: 'duplicate.claim.schema', artifactKind: 'schema-pack-b.artifact', evidenceSchemaId: 'schema-pack-b.evidence', claimIds: ['schema-pack-b.claim'] }),
  ],
  'duplicate_claim_schema_id',
  'duplicate claim schema ids',
);

expectBlockingIssue(
  [
    smokePack('evidence-pack-a', { evidenceSchemaId: 'duplicate.evidence.schema', artifactKind: 'evidence-pack-a.artifact', claimSchemaId: 'evidence-pack-a.claims', claimIds: ['evidence-pack-a.claim'] }),
    smokePack('evidence-pack-b', { evidenceSchemaId: 'duplicate.evidence.schema', artifactKind: 'evidence-pack-b.artifact', claimSchemaId: 'evidence-pack-b.claims', claimIds: ['evidence-pack-b.claim'] }),
  ],
  'duplicate_evidence_schema_id',
  'duplicate evidence schema ids',
);

expectBlockingIssue(
  [
    smokePack('surface-pack-a', { artifactKind: 'duplicate.artifact.kind', claimSchemaId: 'surface-pack-a.claims', evidenceSchemaId: 'surface-pack-a.evidence', claimIds: ['surface-pack-a.claim'] }),
    smokePack('surface-pack-b', { artifactKind: 'duplicate.artifact.kind', claimSchemaId: 'surface-pack-b.claims', evidenceSchemaId: 'surface-pack-b.evidence', claimIds: ['surface-pack-b.claim'] }),
  ],
  'duplicate_proof_surface_artifact_kind',
  'duplicate proof surface artifact kinds',
);

expectBlockingIssue(
  [
    smokePack('alias-pack-a', { aliases: ['duplicate-artifact-alias'], artifactKind: 'alias-pack-a.artifact', claimSchemaId: 'alias-pack-a.claims', evidenceSchemaId: 'alias-pack-a.evidence', claimIds: ['alias-pack-a.claim'] }),
    smokePack('alias-pack-b', { aliases: ['duplicate-artifact-alias'], artifactKind: 'alias-pack-b.artifact', claimSchemaId: 'alias-pack-b.claims', evidenceSchemaId: 'alias-pack-b.evidence', claimIds: ['alias-pack-b.claim'] }),
  ],
  'duplicate_proof_surface_alias',
  'duplicate artifact aliases',
);
console.log('duplicate artifact aliases: BLOCK');

expectBlockingIssue(
  [
    smokePack('claim-pack-a', { artifactKind: 'claim-pack-a.artifact', claimSchemaId: 'claim-pack-a.claims', evidenceSchemaId: 'claim-pack-a.evidence', claimIds: ['duplicate.claim.id'] }),
    smokePack('claim-pack-b', { artifactKind: 'claim-pack-b.artifact', claimSchemaId: 'claim-pack-b.claims', evidenceSchemaId: 'claim-pack-b.evidence', claimIds: ['duplicate.claim.id'] }),
  ],
  'duplicate_claim_id',
  'duplicate claim ids',
);

{
  assert.equal(typeof compatAdmissibility.listClaimAdmissibilityPacks, 'function', 'compat entrypoint exports pack registry');
  assert.equal(
    compatAdmissibility.getProofSurfaceDefinition('done-required-evidence')?.artifactKind,
    'done-required-evidence',
    'compat entrypoint still exports proof-admissibility registry',
  );
  console.log('compat entrypoint exports pack registry');
}

console.log('claim-admissibility pack framework smoke passed');
