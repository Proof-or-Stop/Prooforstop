/**
 * @task B-6e41
 * @checklist CHK-001, CHK-002, CHK-003
 * @title Claim-admissibility pack interface and read-only registry
 * @type feature
 * @priority high
 * @description
 *   Declarative M1 adapter-pack contract for claim admissibility. The built-in
 *   code-runtime pack wraps the existing proof-admissibility surface registry
 *   without creating storage, ledgers, gates, or runtime execution hooks.
 * @changes
 *   - [CHK-001] Define ClaimAdmissibilityPack and related schema/adapter/boundary types.
 *   - [CHK-002] Represent the existing code-runtime proof surfaces as a local read-only pack.
 *   - [CHK-003] Add fail-closed list/resolve/validate registry helpers.
 */

import {
  PROOF_ADMISSIBILITY_CONTRACT_VERSION,
  PROOF_ADMISSIBILITY_VERIFIER_VERSION,
  listProofSurfaceDefinitions,
  type ArtifactConsumerKind,
  type ClaimKind,
  type ProofSurfaceDefinition,
} from '../proof-admissibility.js';
import {
  QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION,
  QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
  QUANTUM_CLAIM_IDS,
  QUANTUM_CLAIM_SPECIFIC_FIELDS,
  QUANTUM_CONDITIONAL_IDENTITY_FIELDS,
  QUANTUM_CORE_IDENTITY_FIELDS,
  QUANTUM_EVIDENCE_KINDS,
  QUANTUM_RUNTIME_STATUS,
  listQuantumVerifierAdapterDescriptors,
} from './quantum.js';

export const CLAIM_ADMISSIBILITY_PACK_CONTRACT_VERSION = 'lattice.claim_admissibility_pack.v1' as const;
export const CODE_RUNTIME_CLAIM_ADMISSIBILITY_PACK_ID = 'code-runtime' as const;
export const QUANTUM_CLAIM_ADMISSIBILITY_PACK_ID = 'quantum' as const;

export type ClaimAdmissibilityPackRuntimeBoundary = 'local' | 'external-adapter';
export type ClaimAdmissibilityPackMutationBoundary = 'read-only';
export type ClaimAdmissibilityPackDeclarationBoundary = 'declarative-only';
export type ClaimAdmissibilityPackClaimScope = 'claim-admissibility-only';
export type ClaimAdmissibilityPackEvidenceRuntime = 'existing-proof-admissibility' | 'domain-local-receipts';
export type ClaimAdmissibilityAdapterExecutionBoundary =
  | 'declarative-only'
  | 'read-receipt-only'
  | 'local-command-contract';
export type ClaimAdmissibilityGatePolicyEffect =
  | 'describe-existing-consumers'
  | 'strengthen-existing-consumers';

export interface ClaimAdmissibilityPackBoundary {
  readonly runtime: ClaimAdmissibilityPackRuntimeBoundary;
  readonly mutation: ClaimAdmissibilityPackMutationBoundary;
  readonly declaration: ClaimAdmissibilityPackDeclarationBoundary;
  readonly claimScope: ClaimAdmissibilityPackClaimScope;
  readonly evidenceRuntime: ClaimAdmissibilityPackEvidenceRuntime;
  readonly createsStorage: false;
  readonly createsLedger: false;
  readonly createsLifecycleGate: false;
  readonly callerWritableMetadataAdmissible: false;
  readonly completionEligible: false;
}

export interface ClaimAdmissibilityClaimBoundary {
  readonly claimScope: ClaimAdmissibilityPackClaimScope;
  readonly completionEligible: false;
  readonly externalGateControl: false;
}

export interface DomainClaimSchema {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description?: string;
  readonly claimIds: readonly string[];
  readonly proofAdmissibilityClaimKinds?: readonly ClaimKind[];
  readonly identityFields?: readonly string[];
  readonly boundary?: ClaimAdmissibilityClaimBoundary;
}

export interface DomainEvidenceSchema {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description?: string;
  readonly artifactKinds?: readonly string[];
  readonly schemaVersions?: readonly string[];
  readonly identityFields?: readonly string[];
}

export interface VerifierCommandSpecDefinition {
  readonly commandId: string;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly output: 'machine-readable';
}

export interface VerifierAdapterDefinition {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description?: string;
  readonly executionBoundary: ClaimAdmissibilityAdapterExecutionBoundary;
  readonly supportedVerifierVersions: readonly string[];
  readonly supportedOutputVersions?: readonly string[];
  readonly inputClaimSchemaIds?: readonly string[];
  readonly outputEvidenceSchemaIds: readonly string[];
  readonly outputEvidenceKinds?: readonly string[];
  readonly commandSpec?: VerifierCommandSpecDefinition;
}

export interface GatePolicyClaimMapping {
  readonly claimId: string;
  readonly claimKind: ClaimKind;
  readonly consumers: readonly ArtifactConsumerKind[];
  readonly proofSurfaceArtifactKinds?: readonly string[];
}

export interface GatePolicyBoundary {
  readonly effect: ClaimAdmissibilityGatePolicyEffect;
  readonly canWeakenLifecycleGates: false;
  readonly completionEligible: false;
}

export interface GatePolicyAdapterDefinition {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description?: string;
  readonly claimSchemaIds: readonly string[];
  readonly evidenceSchemaIds: readonly string[];
  readonly consumerMappings: readonly GatePolicyClaimMapping[];
  readonly boundary: GatePolicyBoundary;
}

export interface BenchmarkHarnessDefinition {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description?: string;
  readonly regimes: readonly string[];
  readonly failureCases: readonly string[];
  readonly metrics: readonly string[];
  readonly diagnosticOnly: boolean;
}

export interface ClaimAdmissibilityPack {
  readonly id: string;
  readonly version: string;
  readonly contractVersion: typeof CLAIM_ADMISSIBILITY_PACK_CONTRACT_VERSION;
  readonly domain: string;
  readonly displayName: string;
  readonly description?: string;
  readonly boundary: ClaimAdmissibilityPackBoundary;
  readonly proofSurfaces: readonly ProofSurfaceDefinition[];
  readonly claimSchemas: readonly DomainClaimSchema[];
  readonly evidenceSchemas: readonly DomainEvidenceSchema[];
  readonly verifierAdapters: readonly VerifierAdapterDefinition[];
  readonly gatePolicies: readonly GatePolicyAdapterDefinition[];
  readonly benchmarkHarnesses?: readonly BenchmarkHarnessDefinition[];
}

export type ClaimAdmissibilityValidationIssueSeverity = 'blocking' | 'warning';

export type ClaimAdmissibilityValidationIssueCode =
  | 'unknown_pack_id'
  | 'invalid_pack_descriptor'
  | 'duplicate_pack_id'
  | 'duplicate_claim_schema_id'
  | 'duplicate_evidence_schema_id'
  | 'duplicate_verifier_adapter_id'
  | 'duplicate_proof_surface_artifact_kind'
  | 'duplicate_proof_surface_alias'
  | 'duplicate_claim_id';

export interface ClaimAdmissibilityValidationIssue {
  readonly severity: ClaimAdmissibilityValidationIssueSeverity;
  readonly code: ClaimAdmissibilityValidationIssueCode;
  readonly message: string;
  readonly packId?: string;
  readonly path?: string;
  readonly value?: string;
  readonly firstPath?: string;
}

export interface ClaimAdmissibilityValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ClaimAdmissibilityValidationIssue[];
  readonly blockingIssues: readonly ClaimAdmissibilityValidationIssue[];
  readonly warningIssues: readonly ClaimAdmissibilityValidationIssue[];
}

export type ClaimAdmissibilityPackLookupResult =
  | {
      readonly status: 'found';
      readonly pack: ClaimAdmissibilityPack;
    }
  | {
      readonly status: 'not_found';
      readonly id?: string;
      readonly issue?: ClaimAdmissibilityValidationIssue;
    };

export interface ClaimAdmissibilityPackRegistry {
  readonly list: () => readonly ClaimAdmissibilityPack[];
  readonly resolve: (id: string) => ClaimAdmissibilityPackLookupResult;
  readonly validate: () => ClaimAdmissibilityValidationResult;
}

interface SeenLocation {
  readonly packId: string;
  readonly path: string;
}

function freezeDescriptorItem<T extends object>(item: T): T {
  const descriptor = { ...item } as Record<string, unknown>;
  for (const [key, value] of Object.entries(descriptor)) {
    if (Array.isArray(value)) descriptor[key] = Object.freeze([...value]);
  }
  return Object.freeze(descriptor) as T;
}

function freezeItems<T extends object>(items: readonly T[]): readonly T[] {
  return Object.freeze(items.map((item) => freezeDescriptorItem(item)));
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort()) as readonly T[];
}

function blockingIssue(
  code: ClaimAdmissibilityValidationIssueCode,
  message: string,
  options: {
    readonly packId?: string;
    readonly path?: string;
    readonly value?: string;
    readonly firstPath?: string;
  } = {},
): ClaimAdmissibilityValidationIssue {
  return {
    severity: 'blocking',
    code,
    message,
    ...options,
  };
}

function trackRequiredId(
  seen: Map<string, SeenLocation>,
  issues: ClaimAdmissibilityValidationIssue[],
  code: ClaimAdmissibilityValidationIssueCode,
  label: string,
  value: string,
  location: SeenLocation,
): void {
  const normalized = value.trim();
  if (!normalized) {
    issues.push(blockingIssue(
      'invalid_pack_descriptor',
      `${label} id must be a non-empty string at ${location.path}.`,
      { packId: location.packId, path: location.path, value },
    ));
    return;
  }

  const first = seen.get(normalized);
  if (!first) {
    seen.set(normalized, location);
    return;
  }

  issues.push(blockingIssue(
    code,
    `${label} "${normalized}" is declared more than once (${first.path}, ${location.path}).`,
    {
      packId: location.packId,
      path: location.path,
      value: normalized,
      firstPath: first.path,
    },
  ));
}

function defineReadOnlyPack(
  descriptor: Omit<ClaimAdmissibilityPack, 'proofSurfaces'>,
  proofSurfaces: readonly ProofSurfaceDefinition[],
): ClaimAdmissibilityPack {
  const pack = { ...descriptor } as ClaimAdmissibilityPack & { readonly toJSON: () => unknown };

  Object.defineProperty(pack, 'proofSurfaces', {
    enumerable: false,
    configurable: false,
    get: () => proofSurfaces,
  });
  Object.defineProperty(pack, 'toJSON', {
    enumerable: false,
    configurable: false,
    value: () => ({
      ...descriptor,
      proofSurfaceArtifactKinds: proofSurfaces.map((surface) => surface.artifactKind),
    }),
  });

  return Object.freeze(pack);
}

const CODE_RUNTIME_PROOF_SURFACES = Object.freeze([...listProofSurfaceDefinitions()]);
const CODE_RUNTIME_CLAIM_KINDS = uniqueSorted(
  CODE_RUNTIME_PROOF_SURFACES.flatMap((surface) => surface.allowedClaims.map((policy) => policy.claim)),
);
const CODE_RUNTIME_SCHEMA_VERSIONS = uniqueSorted(
  CODE_RUNTIME_PROOF_SURFACES.flatMap((surface) => surface.schemaVersions),
);
const CODE_RUNTIME_ARTIFACT_KINDS = Object.freeze(
  CODE_RUNTIME_PROOF_SURFACES.map((surface) => surface.artifactKind),
);

const CODE_RUNTIME_BOUNDARY: ClaimAdmissibilityPackBoundary = Object.freeze({
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
});

const CODE_RUNTIME_CLAIM_SCHEMA_ID = 'code-runtime.lifecycle-claims' as const;
const CODE_RUNTIME_EVIDENCE_SCHEMA_ID = 'code-runtime.proof-surface-evidence' as const;

const CODE_RUNTIME_CLAIM_SCHEMAS = freezeItems<DomainClaimSchema>([
  {
    id: CODE_RUNTIME_CLAIM_SCHEMA_ID,
    version: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
    displayName: 'Code runtime lifecycle claims',
    description: 'Existing Proofbound lifecycle claim ids that are checked by proof-admissibility policy.',
    claimIds: CODE_RUNTIME_CLAIM_KINDS,
    proofAdmissibilityClaimKinds: CODE_RUNTIME_CLAIM_KINDS,
    boundary: Object.freeze({
      claimScope: 'claim-admissibility-only',
      completionEligible: false,
      externalGateControl: false,
    }),
  },
]);

const CODE_RUNTIME_EVIDENCE_SCHEMAS = freezeItems<DomainEvidenceSchema>([
  {
    id: CODE_RUNTIME_EVIDENCE_SCHEMA_ID,
    version: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
    displayName: 'Code runtime proof-surface evidence',
    description: 'Existing proof-admissibility artifact kinds and schema versions exposed through a pack descriptor.',
    artifactKinds: CODE_RUNTIME_ARTIFACT_KINDS,
    schemaVersions: CODE_RUNTIME_SCHEMA_VERSIONS,
  },
]);

const CODE_RUNTIME_VERIFIER_ADAPTERS = freezeItems<VerifierAdapterDefinition>([
  {
    id: 'code-runtime.proof-admissibility-evaluator',
    version: PROOF_ADMISSIBILITY_VERIFIER_VERSION,
    displayName: 'Code runtime proof-admissibility evaluator',
    description: 'Declarative reference to the existing evaluator; this pack does not execute verifiers.',
    executionBoundary: 'declarative-only',
    supportedVerifierVersions: Object.freeze([PROOF_ADMISSIBILITY_VERIFIER_VERSION]),
    inputClaimSchemaIds: Object.freeze([CODE_RUNTIME_CLAIM_SCHEMA_ID]),
    outputEvidenceSchemaIds: Object.freeze([CODE_RUNTIME_EVIDENCE_SCHEMA_ID]),
  },
]);

const CODE_RUNTIME_GATE_POLICY_BOUNDARY: GatePolicyBoundary = Object.freeze({
  effect: 'describe-existing-consumers',
  canWeakenLifecycleGates: false,
  completionEligible: false,
});

function codeRuntimeConsumersForClaim(claimKind: ClaimKind): readonly ArtifactConsumerKind[] {
  return uniqueSorted(CODE_RUNTIME_PROOF_SURFACES.flatMap((surface) => (
    surface.allowedClaims
      .filter((policy) => policy.claim === claimKind)
      .flatMap((policy) => policy.consumers)
  )));
}

function codeRuntimeArtifactKindsForClaim(claimKind: ClaimKind): readonly string[] {
  return uniqueSorted(CODE_RUNTIME_PROOF_SURFACES
    .filter((surface) => surface.allowedClaims.some((policy) => policy.claim === claimKind))
    .map((surface) => surface.artifactKind));
}

const CODE_RUNTIME_GATE_POLICIES = freezeItems<GatePolicyAdapterDefinition>([
  {
    id: 'code-runtime.existing-proof-admissibility-policy',
    version: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
    displayName: 'Existing proof-admissibility consumer policy',
    description: 'Maps code-runtime claims to existing proof-admissibility consumers without creating a new gate.',
    claimSchemaIds: Object.freeze([CODE_RUNTIME_CLAIM_SCHEMA_ID]),
    evidenceSchemaIds: Object.freeze([CODE_RUNTIME_EVIDENCE_SCHEMA_ID]),
    consumerMappings: freezeItems<GatePolicyClaimMapping>(
      CODE_RUNTIME_CLAIM_KINDS.map((claimKind) => ({
        claimId: claimKind,
        claimKind,
        consumers: codeRuntimeConsumersForClaim(claimKind),
        proofSurfaceArtifactKinds: codeRuntimeArtifactKindsForClaim(claimKind),
      })),
    ),
    boundary: CODE_RUNTIME_GATE_POLICY_BOUNDARY,
  },
]);

export const CODE_RUNTIME_CLAIM_ADMISSIBILITY_PACK: ClaimAdmissibilityPack = defineReadOnlyPack(
  {
    id: CODE_RUNTIME_CLAIM_ADMISSIBILITY_PACK_ID,
    version: '1.0.0',
    contractVersion: CLAIM_ADMISSIBILITY_PACK_CONTRACT_VERSION,
    domain: 'proofbound-code-runtime',
    displayName: 'Proofbound code runtime pack',
    description: 'Read-only descriptor for the existing local proof-admissibility code/runtime lifecycle path.',
    boundary: CODE_RUNTIME_BOUNDARY,
    claimSchemas: CODE_RUNTIME_CLAIM_SCHEMAS,
    evidenceSchemas: CODE_RUNTIME_EVIDENCE_SCHEMAS,
    verifierAdapters: CODE_RUNTIME_VERIFIER_ADAPTERS,
    gatePolicies: CODE_RUNTIME_GATE_POLICIES,
  },
  CODE_RUNTIME_PROOF_SURFACES,
);

const QUANTUM_BOUNDARY: ClaimAdmissibilityPackBoundary = Object.freeze({
  runtime: 'external-adapter',
  mutation: 'read-only',
  declaration: 'declarative-only',
  claimScope: 'claim-admissibility-only',
  evidenceRuntime: 'domain-local-receipts',
  createsStorage: false,
  createsLedger: false,
  createsLifecycleGate: false,
  callerWritableMetadataAdmissible: false,
  completionEligible: false,
});

const QUANTUM_CLAIM_SCHEMA_ID = 'quantum.claims' as const;
const QUANTUM_EVIDENCE_SCHEMA_ID = 'quantum.verifier-receipts' as const;
const QUANTUM_IDENTITY_FIELDS = Object.freeze([
  ...QUANTUM_CORE_IDENTITY_FIELDS,
  ...QUANTUM_CONDITIONAL_IDENTITY_FIELDS,
  ...QUANTUM_CLAIM_SPECIFIC_FIELDS,
]);

const QUANTUM_CLAIM_SCHEMAS = freezeItems<DomainClaimSchema>([
  {
    id: QUANTUM_CLAIM_SCHEMA_ID,
    version: QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION,
    displayName: 'Computational quantum claim IDs',
    description: `${QUANTUM_RUNTIME_STATUS} Local scoped claims only; no theory, hardware, solver-improvement, production, or Authority claim is implied.`,
    claimIds: QUANTUM_CLAIM_IDS,
    identityFields: QUANTUM_IDENTITY_FIELDS,
    boundary: Object.freeze({
      claimScope: 'claim-admissibility-only',
      completionEligible: false,
      externalGateControl: false,
    }),
  },
]);

const QUANTUM_EVIDENCE_SCHEMAS = freezeItems<DomainEvidenceSchema>([
  {
    id: QUANTUM_EVIDENCE_SCHEMA_ID,
    version: QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION,
    displayName: 'Computational quantum verifier receipts',
    description: 'Receipt schema for normalized adapter output consumed by the local quantum claim-admissibility evaluator.',
    artifactKinds: QUANTUM_EVIDENCE_KINDS,
    schemaVersions: Object.freeze([
      QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION,
      QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    ]),
    identityFields: QUANTUM_IDENTITY_FIELDS,
  },
]);

const QUANTUM_VERIFIER_ADAPTERS = freezeItems<VerifierAdapterDefinition>(
  listQuantumVerifierAdapterDescriptors().map((adapter) => ({
    id: adapter.id,
    version: adapter.version,
    displayName: adapter.displayName,
    description: adapter.description,
    executionBoundary: adapter.executionBoundary,
    supportedVerifierVersions: Object.freeze([adapter.version]),
    supportedOutputVersions: adapter.supportedOutputVersions,
    inputClaimSchemaIds: Object.freeze([QUANTUM_CLAIM_SCHEMA_ID]),
    outputEvidenceSchemaIds: Object.freeze([QUANTUM_EVIDENCE_SCHEMA_ID]),
    outputEvidenceKinds: Object.freeze([...new Set(adapter.evidenceProfiles.map((profile) => profile.evidenceKind))]),
  })),
);

export const QUANTUM_CLAIM_ADMISSIBILITY_PACK: ClaimAdmissibilityPack = defineReadOnlyPack(
  {
    id: QUANTUM_CLAIM_ADMISSIBILITY_PACK_ID,
    version: '1.0.0',
    contractVersion: CLAIM_ADMISSIBILITY_PACK_CONTRACT_VERSION,
    domain: 'computational-quantum-mechanics',
    displayName: 'Computational quantum claim-admissibility pack',
    description: 'Read-only descriptor for Quantum M2 verifier adapters. It normalizes supplied receipts only and does not run commands or create lifecycle gates.',
    boundary: QUANTUM_BOUNDARY,
    claimSchemas: QUANTUM_CLAIM_SCHEMAS,
    evidenceSchemas: QUANTUM_EVIDENCE_SCHEMAS,
    verifierAdapters: QUANTUM_VERIFIER_ADAPTERS,
    gatePolicies: Object.freeze([]),
  },
  Object.freeze([]),
);

const DEFAULT_CLAIM_ADMISSIBILITY_PACKS = Object.freeze([
  CODE_RUNTIME_CLAIM_ADMISSIBILITY_PACK,
  QUANTUM_CLAIM_ADMISSIBILITY_PACK,
]);

export function validateClaimAdmissibilityPacks(
  packs: readonly ClaimAdmissibilityPack[] = DEFAULT_CLAIM_ADMISSIBILITY_PACKS,
): ClaimAdmissibilityValidationResult {
  const issues: ClaimAdmissibilityValidationIssue[] = [];
  const packIds = new Map<string, SeenLocation>();
  const claimSchemaIds = new Map<string, SeenLocation>();
  const evidenceSchemaIds = new Map<string, SeenLocation>();
  const verifierAdapterIds = new Map<string, SeenLocation>();
  const proofSurfaceArtifactKinds = new Map<string, SeenLocation>();
  const proofSurfaceAliases = new Map<string, SeenLocation>();
  const claimIds = new Map<string, SeenLocation>();

  packs.forEach((pack, packIndex) => {
    const packPath = `packs[${packIndex}]`;
    const packId = pack.id;
    trackRequiredId(packIds, issues, 'duplicate_pack_id', 'pack', packId, {
      packId,
      path: `${packPath}.id`,
    });

    pack.claimSchemas.forEach((schema, schemaIndex) => {
      const schemaPath = `${packPath}.claimSchemas[${schemaIndex}]`;
      trackRequiredId(claimSchemaIds, issues, 'duplicate_claim_schema_id', 'claim schema', schema.id, {
        packId,
        path: `${schemaPath}.id`,
      });
      schema.claimIds.forEach((claimId, claimIndex) => {
        trackRequiredId(claimIds, issues, 'duplicate_claim_id', 'claim', claimId, {
          packId,
          path: `${schemaPath}.claimIds[${claimIndex}]`,
        });
      });
    });

    pack.evidenceSchemas.forEach((schema, schemaIndex) => {
      const schemaPath = `${packPath}.evidenceSchemas[${schemaIndex}]`;
      trackRequiredId(evidenceSchemaIds, issues, 'duplicate_evidence_schema_id', 'evidence schema', schema.id, {
        packId,
        path: `${schemaPath}.id`,
      });
    });

    pack.verifierAdapters.forEach((adapter, adapterIndex) => {
      const adapterPath = `${packPath}.verifierAdapters[${adapterIndex}]`;
      trackRequiredId(verifierAdapterIds, issues, 'duplicate_verifier_adapter_id', 'verifier adapter', adapter.id, {
        packId,
        path: `${adapterPath}.id`,
      });
    });

    pack.proofSurfaces.forEach((surface, surfaceIndex) => {
      const surfacePath = `${packPath}.proofSurfaces[${surfaceIndex}]`;
      trackRequiredId(
        proofSurfaceArtifactKinds,
        issues,
        'duplicate_proof_surface_artifact_kind',
        'proof surface artifact kind',
        surface.artifactKind,
        {
          packId,
          path: `${surfacePath}.artifactKind`,
        },
      );
      for (const [aliasIndex, alias] of (surface.aliases ?? []).entries()) {
        trackRequiredId(
          proofSurfaceAliases,
          issues,
          'duplicate_proof_surface_alias',
          'proof surface alias',
          alias,
          {
            packId,
            path: `${surfacePath}.aliases[${aliasIndex}]`,
          },
        );
      }
    });
  });

  for (const [alias, aliasLocation] of proofSurfaceAliases.entries()) {
    const artifactKindLocation = proofSurfaceArtifactKinds.get(alias);
    if (!artifactKindLocation) continue;
    issues.push(blockingIssue(
      'duplicate_proof_surface_alias',
      `Proof surface alias "${alias}" collides with artifact kind declared at ${artifactKindLocation.path}.`,
      {
        packId: aliasLocation.packId,
        path: aliasLocation.path,
        value: alias,
        firstPath: artifactKindLocation.path,
      },
    ));
  }

  const blockingIssues = Object.freeze(issues.filter((issue) => issue.severity === 'blocking'));
  const warningIssues = Object.freeze(issues.filter((issue) => issue.severity === 'warning'));
  return Object.freeze({
    ok: blockingIssues.length === 0,
    issues: Object.freeze([...issues]),
    blockingIssues,
    warningIssues,
  });
}

export function createClaimAdmissibilityPackRegistry(
  packs: readonly ClaimAdmissibilityPack[] = DEFAULT_CLAIM_ADMISSIBILITY_PACKS,
): ClaimAdmissibilityPackRegistry {
  const registryPacks = Object.freeze([...packs]);
  return Object.freeze({
    list: () => registryPacks,
    resolve: (id: string): ClaimAdmissibilityPackLookupResult => {
      const pack = registryPacks.find((candidate) => candidate.id === id);
      if (pack) return { status: 'found', pack };
      const result = { status: 'not_found' } as ClaimAdmissibilityPackLookupResult;
      Object.defineProperties(result, {
        id: {
          enumerable: false,
          value: id,
        },
        issue: {
          enumerable: false,
          value: blockingIssue(
            'unknown_pack_id',
            `Claim-admissibility pack "${id}" is not registered.`,
            { value: id },
          ),
        },
      });
      return Object.freeze(result);
    },
    validate: () => validateClaimAdmissibilityPacks(registryPacks),
  });
}

const DEFAULT_CLAIM_ADMISSIBILITY_PACK_REGISTRY = createClaimAdmissibilityPackRegistry();

export function listClaimAdmissibilityPacks(): readonly ClaimAdmissibilityPack[] {
  return DEFAULT_CLAIM_ADMISSIBILITY_PACK_REGISTRY.list();
}

export function getClaimAdmissibilityPack(id: string): ClaimAdmissibilityPackLookupResult {
  return DEFAULT_CLAIM_ADMISSIBILITY_PACK_REGISTRY.resolve(id);
}
