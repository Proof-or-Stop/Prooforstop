import type {
  AcceptanceCoverageBasisV1,
  AcceptanceSnapshotSealIssueV1,
  AcceptanceVerificationTopologyV1,
  ChecklistData,
  DecisionData,
  PlannedCoveragePathV1,
  ProofStoryContractData,
  ScopeCheckData,
  ScopeContractData,
  VerificationPlannedPathDeclarationV1,
} from './types.js';
import { digestCanonicalJson } from './digest.js';
import { isConfigFilenameMentioned } from './brand-paths.js';
import { isAcceptanceBasisPathSourceRef } from './acceptance-topology.js';
import { getProcessFactRegistryEntry } from './process-fact-registry.js';
import {
  ACCEPTANCE_PLAN_DISCOVERY_PROFILE,
  acceptanceDiscoveryFactActivationPhase,
  type AcceptanceSourceSnapshot,
  detectAcceptanceDiscoverySupport,
  discoveryProfileDigest,
  reconcileAcceptanceDiscoveryResults,
  runAcceptanceDiscoverySnapshot,
  renderAcceptanceSnapshotSealIssue,
  snapshotAcceptanceSourceFiles,
} from './acceptance-discovery-adapters.js';

export interface AcceptanceBasisDiagnostic {
  code: string;
  message: string;
  pathRef?: string;
}

export interface AcceptanceBasisDerivationInput {
  storyId: string;
  workspaceRoot: string;
  checklist: ChecklistData;
  contract: ProofStoryContractData | null;
  scopeCheck: ScopeCheckData | null;
  scopeContract: ScopeContractData | null;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  supported?: boolean;
  foundationalDecision?: DecisionData | null;
  phaseBasis?: 'plan' | 'pre_review';
  priorPlanBasisDigest?: string;
  /** Test-only mutation point immediately before the end-of-assembly seal. */
  discoveryTestHooks?: {
    immediatelyBeforeFinalSeal?: () => void;
  };
}

export interface AcceptanceBasisDerivation {
  basis: AcceptanceCoverageBasisV1;
  diagnostics: AcceptanceBasisDiagnostic[];
  topologyDigest: string;
}

function stable(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim().length > 0))].sort();
}

function digest(value: unknown): string {
  return `sha256:${digestCanonicalJson(value)}`;
}

function intentEntries(checklist: ChecklistData): Array<{ itemId: string; intentRef: string; declaration: VerificationPlannedPathDeclarationV1 }> {
  return checklist.items.flatMap(item => (['happy', 'edge', 'adversarial'] as const).flatMap(lane =>
    (item.verificationIntent?.[lane] ?? []).flatMap((intent, index) => {
      const intentRef = intent.id || `${item.id}:${lane}:${index}`;
      return (intent.plannedPathDeclarations ?? []).map(declaration => ({ itemId: item.id, intentRef, declaration }));
    })));
}

function resolveDeclaredFile(checklist: ChecklistData, itemId: string, ref: string): string | null {
  const match = ref.match(/^(CHK-\d{3}):files:(modify|create|test):(\d+)$/);
  if (!match || match[1] !== itemId) return null;
  const item = checklist.items.find(candidate => candidate.id === itemId);
  return item?.files?.[match[2] as 'modify' | 'create' | 'test']?.[Number(match[3])] ?? null;
}

function scopeAllows(scope: ScopeContractData | null, file: string): boolean {
  if (!scope) return true;
  return [...scope.allowedModify, ...scope.allowedCreate, ...scope.allowedTest].includes(file);
}

export function derivePlannedCoveragePaths(
  checklist: ChecklistData,
  contract: ProofStoryContractData | null,
  scopeContract: ScopeContractData | null,
): { records: PlannedCoveragePathV1[]; diagnostics: AcceptanceBasisDiagnostic[] } {
  const diagnostics: AcceptanceBasisDiagnostic[] = [];
  const records: PlannedCoveragePathV1[] = [];
  for (const entry of intentEntries(checklist)) {
    const declarationRef = `${entry.intentRef}:${entry.declaration.id}`;
    const endpoints = [entry.declaration.producer, ...entry.declaration.consumers];
    let valid = true;
    if (entry.declaration.schemaVersion !== 'proofstory.verification_planned_path_declaration.v1'
      || entry.declaration.relation !== 'producer_to_consumer'
      || entry.declaration.producer.role !== 'producer'
      || entry.declaration.consumers.length === 0
      || entry.declaration.consumers.some(endpoint => endpoint.role !== 'consumer')
      || !entry.declaration.outputFactRef.trim()) {
      diagnostics.push({ code: 'AT_PLANNED_PATH_INVALID', message: `planned declaration ${declarationRef} has invalid schema, relation, endpoint roles, or output fact`, pathRef: declarationRef });
      valid = false;
    }
    for (const endpoint of endpoints) {
      const file = resolveDeclaredFile(checklist, entry.itemId, endpoint.fileDeclarationRef);
      if (!file || file !== endpoint.expectedFileRef || !scopeAllows(scopeContract, endpoint.expectedFileRef)) {
        diagnostics.push({
          code: 'AT_PLANNED_PATH_INVALID',
          message: `planned endpoint ${endpoint.id} does not resolve to the same checklist file inside scope`,
          pathRef: declarationRef,
        });
        valid = false;
      }
    }
    if (!valid) continue;
    const acceptanceBindingRefs = stable((contract?.acceptanceBindings ?? [])
      .filter(binding => binding.verificationIntentRefs.includes(entry.intentRef))
      .map(binding => `acceptance-binding:${binding.id}`));
    const unsigned = {
      schemaVersion: 'proofstory.planned_coverage_path.v1' as const,
      plannedPathRef: `planned:${declarationRef}`,
      plannedPathDeclarationRef: declarationRef,
      declarationDigest: digest(entry.declaration),
      producer: entry.declaration.producer,
      consumers: [...entry.declaration.consumers].sort((a, b) => a.id.localeCompare(b.id)),
      outputFactRef: entry.declaration.outputFactRef,
      acceptanceBindingRefs,
      verificationIntentRefs: [entry.intentRef],
      declarationRefs: endpoints.map(endpoint => endpoint.fileDeclarationRef).sort(),
    };
    records.push({ ...unsigned, plannedPathDigest: digest(unsigned) });
  }
  records.sort((a, b) => a.plannedPathRef.localeCompare(b.plannedPathRef));
  return { records, diagnostics };
}

function sourceRefValue(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const direct = node as Record<string, unknown>;
  const sourceRef = direct.refKind ? direct : (node as { sourceRef?: unknown }).sourceRef;
  if (!sourceRef || typeof sourceRef !== 'object') return null;
  const ref = sourceRef as Record<string, unknown>;
  if (ref.refKind === 'existing' && typeof ref.canonicalSourceRef === 'string') return `existing:${ref.canonicalSourceRef}`;
  if (ref.refKind === 'planned' && typeof ref.plannedPathDeclarationRef === 'string') return `planned:${ref.plannedPathDeclarationRef}`;
  return null;
}

function topologyPathEndpointValue(node: unknown): string | null {
  const value = sourceRefValue(node);
  // Only registry-backed process-fact references are legal canonical endpoints
  // that can be projected into verifier path space. Keep every other existing
  // reference provenance-qualified so caller-authored aliases such as
  // `consumer:*` cannot impersonate a verifier-owned endpoint.
  return value?.startsWith('existing:process-fact:') ? value.slice('existing:'.length) : value;
}

function consumerGateNamesProcessFact(consumerGate: string, factName: string): boolean {
  const escaped = factName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_:.-])${escaped}(?=$|[^A-Za-z0-9_:.-])`).test(consumerGate);
}

function canonicalRegistryTopologyPath(producerRef: string, consumerRef: string): string | null {
  const producerName = producerRef.match(/^process-fact:(.+)$/)?.[1];
  const consumerName = consumerRef.match(/^process-fact:(.+)$/)?.[1];
  if (!producerName || !consumerName) return null;
  const producer = getProcessFactRegistryEntry(producerName);
  const consumer = getProcessFactRegistryEntry(consumerName);
  if (!producer?.consumerGate || !consumer || !consumerGateNamesProcessFact(producer.consumerGate, consumerName)) return null;
  return `path:process-fact:${producerName}->consumer:${producer.consumerGate}`;
}

function topologyPaths(contract: ProofStoryContractData | null): string[] {
  const paths: string[] = [];
  for (const binding of contract?.acceptanceBindings ?? []) {
    const topology = binding.verificationTopology as AcceptanceVerificationTopologyV1 | undefined;
    if (!topology) continue;
    const producers = new Map(topology.producerRefs.map(producer => [producer.id, topologyPathEndpointValue(producer)]));
    for (const consumer of topology.consumerRefs) {
      const consumerRef = topologyPathEndpointValue(consumer);
      for (const producerId of consumer.producerRefs ?? []) {
        const producerRef = producers.get(producerId);
        if (producerRef && consumerRef) paths.push(canonicalRegistryTopologyPath(producerRef, consumerRef) ?? `path:${producerRef}->${consumerRef}`);
      }
    }
  }
  return stable(paths);
}

function topologyCanonicalRefs(contract: ProofStoryContractData | null): string[] {
  const refs: string[] = [];
  for (const binding of contract?.acceptanceBindings ?? []) {
    const topology = binding.verificationTopology as AcceptanceVerificationTopologyV1 | undefined;
    if (!topology) continue;
    for (const node of [
      ...topology.producerRefs,
      ...topology.consumerRefs,
      ...topology.positiveAssertionRefs,
      ...topology.mutationCaseRefs,
      ...topology.transcriptAssertionRefs,
      ...topology.commandRefs,
    ]) {
      const value = sourceRefValue(node);
      if (value?.startsWith('existing:')) refs.push(value.slice('existing:'.length));
    }
  }
  return stable(refs);
}

function plannedPathRefs(records: readonly PlannedCoveragePathV1[]): string[] {
  return records.map(record => record.plannedPathRef);
}

function sourceInventory(records: readonly PlannedCoveragePathV1[], contract: ProofStoryContractData | null): string[] {
  const planned = records.flatMap(record => [record.producer, ...record.consumers])
    .map(endpoint => `${endpoint.expectedArtifactKind}:${endpoint.expectedFileRef}#${endpoint.expectedSymbolOrFact}`);
  const existing = (contract?.acceptanceBindings ?? []).flatMap(binding => {
    const topology = binding.verificationTopology as AcceptanceVerificationTopologyV1 | undefined;
    return topology ? [...topology.producerRefs, ...topology.consumerRefs].map(sourceRefValue).filter((ref): ref is string => Boolean(ref)) : [];
  });
  return stable([...planned, ...existing]);
}

function inventorySourceFile(ref: string): string | null {
  const bound = ref.match(/^source-file:(?:producer|consumer):[^:]+:(.+)$/);
  if (bound?.[1]) return bound[1];
  return ref.match(/^source-file:closure:(.+)$/)?.[1] ?? ref.match(/^source-file:config:(.+)$/)?.[1] ?? null;
}

export function computeClosureFilesHashFromSnapshots(
  records: readonly PlannedCoveragePathV1[],
  inventory: readonly string[],
  snapshots: readonly AcceptanceSourceSnapshot[],
): { hash: string; blindSpots: string[] } {
  const files = stable([
    ...records.flatMap(record => [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef)),
    ...inventory.map(inventorySourceFile).filter((file): file is string => Boolean(file)),
  ]);
  const plannedFiles = new Set(records.flatMap(record => [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef)));
  const snapshotByFile = new Map(snapshots.map(snapshot => [snapshot.canonicalFile, snapshot]));
  const blindSpots: string[] = [];
  const rows = files.map(file => {
    const snapshot = snapshotByFile.get(file);
    if (snapshot) return `${file}\0${snapshot.contentDigest}`;
    if (plannedFiles.has(file)) return `${file}\0<planned>`;
    blindSpots.push(`closure source lacks immutable bounded snapshot: ${file}`);
    return `${file}\0<uninspectable>`;
  });
  return { hash: digest([...rows, ...stable(inventory)]), blindSpots: stable(blindSpots) };
}

/** Compatibility helper: one bounded no-follow snapshot, never an unbounded raw reread. */
export function computeClosureFilesHash(workspaceRoot: string, records: readonly PlannedCoveragePathV1[], inventory: readonly string[]): string {
  const files = stable([
    ...records.flatMap(record => [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef)),
    ...inventory.map(inventorySourceFile).filter((file): file is string => Boolean(file)),
  ]);
  return computeClosureFilesHashFromSnapshots(records, inventory, snapshotAcceptanceSourceFiles(workspaceRoot, files).sourceSnapshots).hash;
}

function unsignedBasis(basis: AcceptanceCoverageBasisV1): Omit<AcceptanceCoverageBasisV1, 'basisDigest'> {
  const { basisDigest: _basisDigest, ...unsigned } = basis;
  return unsigned;
}

export function digestAcceptanceCoverageBasis(basis: Omit<AcceptanceCoverageBasisV1, 'basisDigest'>): string {
  return digest(basis);
}

/** Stable semantic projection used to detect hash-only rebinding without rerunning discovery. */
export function acceptanceCoverageBasisSemanticDigest(basis: AcceptanceCoverageBasisV1): string {
  const { basisDigest: _basisDigest, binding: _binding, receiptRef: _receiptRef, ...semantic } = basis;
  return digest(semantic);
}

function classifyAcceptanceCoverageBasis(
  supported: boolean,
  diagnostics: readonly AcceptanceBasisDiagnostic[],
  discoveryStatus: 'complete' | 'partial' | 'unsupported',
  blindSpots: readonly string[],
): 'complete' | 'partial' | 'unsupported' {
  if (!supported || discoveryStatus === 'unsupported') return 'unsupported';
  if (diagnostics.length > 0 || discoveryStatus === 'partial' || blindSpots.length > 0) return 'partial';
  return 'complete';
}

export function deriveAcceptanceCoverageBasis(input: AcceptanceBasisDerivationInput): AcceptanceBasisDerivation {
  const diagnostics: AcceptanceBasisDiagnostic[] = [];
  if (!input.scopeCheck) diagnostics.push({ code: 'AT_SCOPE_BINDING_MISSING', message: 'signed scope-check.json is required' });
  const planned = derivePlannedCoveragePaths(input.checklist, input.contract, input.scopeContract);
  diagnostics.push(...planned.diagnostics);
  const scopeRefs = stable([
    ...(input.scopeContract ? [...input.scopeContract.allowedModify, ...input.scopeContract.allowedCreate, ...input.scopeContract.allowedTest].map(file => `scope:file:${file}`) : []),
    ...input.checklist.items.map(item => `scope:checklist:${item.id}`),
  ]);
  const supported = input.supported ?? detectAcceptanceDiscoverySupport(input.workspaceRoot);
  const initialInventory = sourceInventory(planned.records, input.contract);
  const discoverySeedFiles = stable([
    ...scopeRefs.filter(ref => ref.startsWith('scope:file:')).map(ref => ref.slice('scope:file:'.length)),
    ...planned.records.flatMap(record => [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef)),
  ]);
  const discovery = runAcceptanceDiscoverySnapshot({
    supported,
    workspaceRoot: input.workspaceRoot,
    storyId: input.storyId,
    plannedPathRecords: planned.records,
    scopeRefs,
    topologyPathRefs: topologyCanonicalRefs(input.contract),
    phaseBasis: input.phaseBasis ?? 'plan',
    testHooks: input.discoveryTestHooks,
  });
  const registeredClosure = discovery.registeredClosure;
  const reconciled = reconcileAcceptanceDiscoveryResults(discovery.adapterResults);
  diagnostics.push(...reconciled.diagnostics);
  const inventory = stable([...initialInventory, ...registeredClosure.sourceInventoryRefs]);
  const closureSnapshot = computeClosureFilesHashFromSnapshots(planned.records, inventory, discovery.sourceSnapshots);
  const closureFilesHash = closureSnapshot.hash;
  const plannedFiles = new Set(planned.records.flatMap(record => [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef)));
  const sourceReadBlindSpots = discovery.sourceReadBlindSpots.filter(message => {
    const matched = message.match(/: (.+?)(?: -> .+)?$/)?.[1];
    const absentPlannedFile = matched && plannedFiles.has(matched) && /unreadable or disappeared/.test(message);
    return !absentPlannedFile;
  });
  const additionalSealIssues: AcceptanceSnapshotSealIssueV1[] = [
    ...closureSnapshot.blindSpots.map(message => ({ code: 'snapshot_missing' as const, targetKind: 'inventory' as const, canonicalRef: message.split(': ').at(-1) ?? 'closure-source' })),
    ...sourceReadBlindSpots.map(message => ({
      code: (/no-follow/.test(message) ? 'safe_no_follow_unsupported' : /changed|symlink/.test(message) ? 'source_file_changed' : 'snapshot_missing') as AcceptanceSnapshotSealIssueV1['code'],
      // B-cc10 CHK-004: classify by EITHER config spelling. This is a decision,
      // not output — pinning the deprecated literal here would misfile a blind
      // spot about the CANONICAL config as a generic `source_file`, so the
      // rename would silently degrade issue classification.
      targetKind: isConfigFilenameMentioned(message) ? 'config' as const : 'source_file' as const,
      canonicalRef: message.match(/: (.+?)(?: -> .+)?$/)?.[1] ?? 'source-snapshot',
    })),
  ];
  const preSealBlindSpots = reconciled.blindSpots;
  const topologyDigest = digest((input.contract?.acceptanceBindings ?? []).map(binding => ({ id: binding.id, topology: binding.verificationTopology ?? null })));
  const phaseBasis = input.phaseBasis ?? 'plan';
  const receiptRef = `receipt:coverage-basis:${input.storyId}:${phaseBasis}:${digest({ storyId: input.storyId, phaseBasis, topologyDigest, closureFilesHash }).slice(7, 23)}`;
  const plannedActualReconciliations = phaseBasis === 'pre_review'
    ? planned.records.flatMap(record => {
      const actualPathRefs = [record.producer, ...record.consumers].map(endpoint =>
        `actual:${endpoint.expectedArtifactKind}:${endpoint.expectedFileRef}#${endpoint.expectedSymbolOrFact}`);
      if (!actualPathRefs.every(ref => reconciled.enumeratedPathRefs.includes(ref))) return [];
      const unsignedReconciliation = {
        schemaVersion: 'proofstory.planned_actual_path_reconciliation.v1' as const,
        plannedPathRef: record.plannedPathRef,
        actualPathRefs,
        relation: 'exact' as const,
      };
      return [{ ...unsignedReconciliation, reconciliationDigest: digest(unsignedReconciliation) }];
    })
    : [];
  const placeholderSealUnsigned = {
    schemaVersion: 'proofstory.acceptance_snapshot_seal.v1' as const,
    inventoryDirectoryDigest: `sha256:${digestCanonicalJson([])}`,
    inventoryDirectoryCount: 0,
    sourceSnapshotDigest: `sha256:${digestCanonicalJson([])}`,
    sourceSnapshotCount: 0,
    configSnapshotDigest: `sha256:${digestCanonicalJson(null)}`,
    status: 'complete' as const,
    issues: [],
  };
  const placeholderSeal = { ...placeholderSealUnsigned, sealDigest: `sha256:${digestCanonicalJson(placeholderSealUnsigned)}` };
  let unsigned: Omit<AcceptanceCoverageBasisV1, 'basisDigest'> = {
    schemaVersion: 'proofstory.acceptance_coverage_basis.v1',
    storyId: input.storyId,
    phaseBasis,
    ...(phaseBasis === 'pre_review' && input.priorPlanBasisDigest ? { priorPlanBasisDigest: input.priorPlanBasisDigest } : {}),
    status: classifyAcceptanceCoverageBasis(supported, diagnostics, reconciled.status, preSealBlindSpots),
    generatedBy: {
      verifier: 'acceptance-coverage-basis-verifier',
      command: phaseBasis === 'pre_review' ? 'proof-or-stop pre_review_check' : 'proof-or-stop acceptance_basis_generate',
      algorithmVersion: 'v1',
    },
    discoveryProfileRef: ACCEPTANCE_PLAN_DISCOVERY_PROFILE.ref,
    discoveryProfileDigest: discoveryProfileDigest(),
    discoveryMethods: [...ACCEPTANCE_PLAN_DISCOVERY_PROFILE.methods],
    adapterResults: reconciled.adapterResults,
    scopeRefs,
    sourceInventoryRefs: inventory,
    plannedPathRecords: planned.records,
    plannedActualReconciliations,
    enumeratedPathRefs: reconciled.enumeratedPathRefs,
    excludedPathRefs: [],
    blindSpots: preSealBlindSpots,
    snapshotSeal: placeholderSeal,
    binding: {
      headHash: input.headHash,
      materialHash: input.materialHash,
      storyFilesHash: input.storyFilesHash,
      scopeCheckDigest: digest(input.scopeCheck),
      ...(input.scopeContract ? { scopeContractDigest: digest(input.scopeContract) } : {}),
      closureFilesHash,
    },
    receiptRef,
  };
  const provisional = { ...unsigned, basisDigest: digestAcceptanceCoverageBasis(unsigned) };
  const topologyDiagnosticStart = diagnostics.length;
  diagnostics.push(...reconcileTopologyWithCoverageBasis(input.contract, provisional, input.foundationalDecision));
  additionalSealIssues.push(...diagnostics.slice(topologyDiagnosticStart).map(item => ({
    code: 'derivation_diagnostic' as const,
    targetKind: 'inventory' as const,
    canonicalRef: `${item.code}:${item.pathRef ?? '<basis>'}`,
  })));
  discovery.immediatelyBeforeFinalSeal?.();
  const snapshotSeal = discovery.seal(additionalSealIssues);
  const derivationBlindSpots = stable([...preSealBlindSpots, ...snapshotSeal.issues.map(renderAcceptanceSnapshotSealIssue)]);
  unsigned = {
    ...unsigned,
    blindSpots: derivationBlindSpots,
    snapshotSeal,
    status: supported && snapshotSeal.status === 'complete'
      ? classifyAcceptanceCoverageBasis(supported, diagnostics, reconciled.status, derivationBlindSpots)
      : supported ? 'partial' : 'unsupported',
  };
  return { basis: { ...unsigned, basisDigest: digestAcceptanceCoverageBasis(unsigned) }, diagnostics, topologyDigest };
}

export function verifyAcceptanceCoverageBasis(
  basis: AcceptanceCoverageBasisV1,
): { ok: boolean; diagnostics: AcceptanceBasisDiagnostic[] } {
  const diagnostics: AcceptanceBasisDiagnostic[] = [];
  // B-cdf6: the `generatedBy.command` comparisons below are DELIBERATELY exact-match on
  // the canonical bin name, and are the one place in the rename where read-both is the
  // WRONG answer. Do not add a `|| === 'proofOrStop ...'` shim here.
  //
  // Why: this string is an input to `basisDigest`. Accepting both spellings would mean
  // accepting two different digests for what claims to be the same basis, which defeats
  // the point of digesting the issuer at all.
  //
  // Migration consequence, stated so it is not rediscovered as a bug: a basis artifact
  // generated on pre-rename main records `proof-or-stop acceptance_basis_generate` and will
  // fail here with AT_ADAPTER_RESULT_INVALID after that branch merges. That is expected —
  // the basis is a per-story, per-phase artifact that its handler regenerates, so the fix
  // is to re-run `proof-or-stop acceptance_basis_generate` (or `pre_review_check`), not to
  // widen this check. The failure is explicit rather than silent, which is the intended
  // behaviour.
  if (basis.schemaVersion !== 'proofstory.acceptance_coverage_basis.v1'
    || basis.generatedBy.verifier !== 'acceptance-coverage-basis-verifier'
    || (basis.phaseBasis === 'plan' && basis.generatedBy.command !== 'proof-or-stop acceptance_basis_generate')
    || (basis.phaseBasis === 'pre_review' && basis.generatedBy.command !== 'proof-or-stop pre_review_check')
    || (basis.phaseBasis === 'pre_review' && !basis.priorPlanBasisDigest)) {
    diagnostics.push({ code: 'AT_ADAPTER_RESULT_INVALID', message: 'basis issuer, schema, command, or phase is invalid' });
  }
  if (digestAcceptanceCoverageBasis(unsignedBasis(basis)) !== basis.basisDigest) {
    diagnostics.push({ code: 'AT_ADAPTER_RESULT_DIGEST_MISMATCH', message: 'basis digest mismatch' });
  }
  const reconciled = reconcileAcceptanceDiscoveryResults(basis.adapterResults);
  diagnostics.push(...reconciled.diagnostics);
  const seal = basis.snapshotSeal;
  const sealIssueCodes = new Set(['directory_changed', 'source_file_changed', 'safe_no_follow_unsupported', 'inventory_unsealable', 'snapshot_missing', 'derivation_diagnostic']);
  const sealShapeValid = seal?.schemaVersion === 'proofstory.acceptance_snapshot_seal.v1'
    && Number.isInteger(seal.inventoryDirectoryCount) && seal.inventoryDirectoryCount >= 0
    && Number.isInteger(seal.sourceSnapshotCount) && seal.sourceSnapshotCount >= 0
    && [seal.inventoryDirectoryDigest, seal.sourceSnapshotDigest, seal.configSnapshotDigest, seal.sealDigest].every(value => /^sha256:[a-f0-9]{64}$/.test(value))
    && Array.isArray(seal.issues)
    && seal.issues.every(issue => sealIssueCodes.has(issue.code)
      && ['directory', 'source_file', 'config', 'inventory'].includes(issue.targetKind)
      && typeof issue.canonicalRef === 'string' && issue.canonicalRef.length > 0);
  if (!sealShapeValid) diagnostics.push({ code: 'AT_ADAPTER_RESULT_INVALID', message: 'snapshot seal shape is invalid' });
  if (sealShapeValid) {
    const { sealDigest, ...unsignedSeal } = seal;
    if (`sha256:${digestCanonicalJson(unsignedSeal)}` !== sealDigest) diagnostics.push({ code: 'AT_ADAPTER_RESULT_DIGEST_MISMATCH', message: 'snapshot seal digest mismatch' });
    const expectedSealStatus = seal.issues.length === 0 ? 'complete' : 'partial';
    if (seal.status !== expectedSealStatus) diagnostics.push({ code: 'AT_COVERAGE_BASIS_PARTIAL', message: `snapshot seal status mismatch: expected ${expectedSealStatus}` });
  }
  const expectedBlindSpots = stable([...reconciled.blindSpots, ...(sealShapeValid ? seal.issues.map(renderAcceptanceSnapshotSealIssue) : [])]);
  if (JSON.stringify(reconciled.enumeratedPathRefs) !== JSON.stringify(basis.enumeratedPathRefs)
    || JSON.stringify(expectedBlindSpots) !== JSON.stringify(basis.blindSpots)
    || JSON.stringify(stable(reconciled.adapterResults.map(result => result.method))) !== JSON.stringify(stable(basis.discoveryMethods))) {
    diagnostics.push({ code: 'AT_ADAPTER_RESULT_DIGEST_MISMATCH', message: 'basis aggregate does not match adapter result projection' });
  }
  for (const record of basis.plannedPathRecords) {
    const { plannedPathDigest, ...unsigned } = record;
    if (digest(unsigned) !== plannedPathDigest) diagnostics.push({ code: 'AT_PLANNED_PATH_DECLARATION_DRIFT', message: `planned path digest mismatch: ${record.plannedPathRef}` });
    if (basis.status !== 'unsupported' && !basis.enumeratedPathRefs.includes(record.plannedPathRef)) diagnostics.push({ code: 'AT_PLANNED_PATH_OUTSIDE_BASIS', message: `planned path absent from basis union: ${record.plannedPathRef}` });
  }
  if (basis.phaseBasis === 'pre_review') {
    const byPlanned = new Map(basis.plannedActualReconciliations.map(row => [row.plannedPathRef, row]));
    if (byPlanned.size !== basis.plannedActualReconciliations.length) diagnostics.push({ code: 'PR_PLANNED_PATH_RECONCILIATION_TAMPERED', message: 'duplicate planned-to-actual reconciliation' });
    for (const record of basis.plannedPathRecords) {
      const row = byPlanned.get(record.plannedPathRef);
      if (!row) diagnostics.push({ code: 'PR_PLANNED_PATH_UNRESOLVED', message: `planned path is unresolved: ${record.plannedPathRef}` });
      else {
        const { reconciliationDigest, ...unsigned } = row;
        if (digest(unsigned) !== reconciliationDigest) diagnostics.push({ code: 'PR_PLANNED_PATH_RECONCILIATION_TAMPERED', message: `reconciliation digest mismatch: ${record.plannedPathRef}` });
        const expectedActualRefs = [record.producer, ...record.consumers].map(endpoint =>
          `actual:${endpoint.expectedArtifactKind}:${endpoint.expectedFileRef}#${endpoint.expectedSymbolOrFact}`).sort();
        if (row.relation !== 'exact' || JSON.stringify([...row.actualPathRefs].sort()) !== JSON.stringify(expectedActualRefs)
          || !row.actualPathRefs.every(ref => basis.enumeratedPathRefs.includes(ref))) {
          diagnostics.push({ code: 'PR_PLANNED_PATH_RECONCILIATION_TAMPERED', message: `reconciliation is not backed by exact discovered endpoints: ${record.plannedPathRef}` });
        }
      }
    }
  }
  const expectedStatus = reconciled.status === 'unsupported' ? 'unsupported'
    : diagnostics.length > 0 || reconciled.status === 'partial' || seal?.status === 'partial' ? 'partial' : 'complete';
  if (basis.status !== expectedStatus) diagnostics.push({ code: 'AT_COVERAGE_BASIS_PARTIAL', message: `basis status ${basis.status} does not equal verifier classification ${expectedStatus}` });
  return { ok: diagnostics.length === 0, diagnostics };
}

export function reconcileTopologyWithCoverageBasis(
  contract: ProofStoryContractData | null,
  basis: AcceptanceCoverageBasisV1,
  foundationalDecision: DecisionData | null = null,
): AcceptanceBasisDiagnostic[] {
  const topology = new Set(topologyPaths(contract));
  const topologySourceRefs = stable((contract?.acceptanceBindings ?? []).flatMap(binding => {
    const value = binding.verificationTopology as AcceptanceVerificationTopologyV1 | undefined;
    // Consumer process facts name the endpoint of a producer edge; they do not
    // independently claim coverage of their own producer path. A separate
    // producerRef or commandRef is required for that path.
    return value ? [...value.producerRefs, ...value.commandRefs]
      .map(sourceRefValue).filter((ref): ref is string => Boolean(ref)).map(ref => ref.replace(/^existing:/, '')) : [];
  }));
  const planned = new Set((contract?.acceptanceBindings ?? []).flatMap(binding => {
    const value = binding.verificationTopology as AcceptanceVerificationTopologyV1 | undefined;
    return value ? [...value.producerRefs, ...value.consumerRefs].map(sourceRefValue).filter((ref): ref is string => typeof ref === 'string' && ref.startsWith('planned:')) : [];
  }));
  const plannedEndpoints = new Set((contract?.acceptanceBindings ?? []).flatMap(binding => {
    const value = binding.verificationTopology as AcceptanceVerificationTopologyV1 | undefined;
    if (!value) return [];
    return [...value.producerRefs, ...value.consumerRefs].flatMap(node => node.sourceRef.refKind === 'planned'
      ? [`${node.sourceRef.plannedPathDeclarationRef}:${node.sourceRef.endpointRef}`] : []);
  }));
  const diagnostics: AcceptanceBasisDiagnostic[] = [];
  for (const binding of contract?.acceptanceBindings ?? []) {
    const value = binding.verificationTopology as AcceptanceVerificationTopologyV1 | undefined;
    if (value && value.schemaVersion !== 'proofstory.acceptance_topology.v1') {
      diagnostics.push({ code: 'AT_TOPOLOGY_OUTSIDE_BASIS', message: `unsupported topology schema version on ${binding.id}`, pathRef: `acceptance-binding:${binding.id}` });
    }
  }
  const derivedPlanned = new Set(basis.plannedPathRecords.map(record => record.plannedPathRef));
  const excluded = new Set(basis.excludedPathRefs.map(item => item.pathRef));
  const pathMapped = (path: string): boolean => {
    if (path.startsWith('actual:') && basis.plannedActualReconciliations.some(row => row.actualPathRefs.includes(path))) return true;
    if (topologySourceRefs.includes(`basis-path:${path}`)) return true;
    const processMatch = /^path:process-fact:(.+)->consumer:/.exec(path);
    if (processMatch && topologySourceRefs.includes(`process-fact:${processMatch[1]}`)) return true;
    const runtimeMatch = /^path:runtime-fact:(.+)->checker:/.exec(path);
    if (runtimeMatch && topologySourceRefs.includes(`runtime-fact:${runtimeMatch[1]}`)) return true;
    return topology.has(path);
  };
  for (const path of planned) {
    if (!derivedPlanned.has(path)) diagnostics.push({ code: 'AT_PLANNED_PATH_OUTSIDE_BASIS', message: `topology planned path has no frozen verifier-derived declaration: ${path}`, pathRef: path });
  }
  for (const record of basis.plannedPathRecords) {
    for (const endpoint of [record.producer, ...record.consumers]) {
      const endpointRef = `${record.plannedPathDeclarationRef}:${endpoint.id}`;
      if (!plannedEndpoints.has(endpointRef)) diagnostics.push({
        code: 'AT_UNMAPPED_SCOPE_REF',
        message: `basis planned endpoint is not mapped by topology: ${endpointRef}`,
        pathRef: endpointRef,
      });
    }
  }
  for (const path of basis.enumeratedPathRefs) {
    if (path.startsWith('planned:')) {
      if (!planned.has(path)) diagnostics.push({ code: 'AT_UNMAPPED_SCOPE_REF', message: `basis planned path is not mapped by topology: ${path}`, pathRef: path });
    } else if (!pathMapped(path) && !excluded.has(path)) diagnostics.push({ code: 'AT_UNMAPPED_SCOPE_REF', message: `basis path is not mapped by topology or justified exclusion: ${path}`, pathRef: path });
  }
  for (const ref of topologySourceRefs) {
    const directPath = ref.startsWith('basis-path:') ? ref.slice('basis-path:'.length) : null;
    if (directPath && !basis.enumeratedPathRefs.includes(directPath)) {
      const validPlanForwardDeclaration = basis.phaseBasis === 'plan'
        && isAcceptanceBasisPathSourceRef(ref);
      if (!validPlanForwardDeclaration) diagnostics.push({ code: 'AT_TOPOLOGY_OUTSIDE_BASIS', message: `topology basis-path mapping is outside basis: ${directPath}`, pathRef: directPath });
    }
    if (ref.startsWith('process-fact:') && !basis.enumeratedPathRefs.some(path => path.startsWith(`path:${ref}->`))) {
      const factName = ref.slice('process-fact:'.length);
      const deferredToNextPhase = basis.phaseBasis === 'plan'
        && acceptanceDiscoveryFactActivationPhase(factName) === 'pre_review';
      if (!deferredToNextPhase) diagnostics.push({ code: 'AT_TOPOLOGY_OUTSIDE_BASIS', message: `topology process-fact mapping is outside basis: ${ref}`, pathRef: ref });
    }
    if (ref.startsWith('runtime-fact:') && !basis.enumeratedPathRefs.some(path => path.startsWith(`path:${ref}->`))) diagnostics.push({ code: 'AT_TOPOLOGY_OUTSIDE_BASIS', message: `topology runtime-fact mapping is outside basis: ${ref}`, pathRef: ref });
  }
  for (const path of topology) {
    const edgeEndpoints = path.startsWith('path:') ? path.slice(5).split('->') : [];
    const coveredByPlannedDeclarations = edgeEndpoints.length === 2
      && edgeEndpoints.every(ref => ref.startsWith('planned:') && derivedPlanned.has(ref));
    if (!basis.enumeratedPathRefs.includes(path) && !coveredByPlannedDeclarations) diagnostics.push({ code: 'AT_TOPOLOGY_OUTSIDE_BASIS', message: `topology path is outside basis: ${path}`, pathRef: path });
  }
  const seenDecisions = new Set<string>();
  for (const exclusion of basis.excludedPathRefs) {
    const expectedRef = foundationalDecision ? foundationalExclusionDecisionRef(foundationalDecision) : null;
    const eligibleKind = foundationalDecision?.chosen.trim().toLowerCase().startsWith('[coverage-exclusion]') === true;
    const currentAndRelevant = Boolean(foundationalDecision
      && Number.isFinite(Date.parse(foundationalDecision.timestamp))
      && foundationalDecision.rationale.includes(exclusion.pathRef));
    const duplicate = seenDecisions.has(exclusion.decisionRef);
    seenDecisions.add(exclusion.decisionRef);
    if (!expectedRef || exclusion.decisionRef !== expectedRef || !eligibleKind || !currentAndRelevant || duplicate) {
      diagnostics.push({ code: 'AT_UNJUSTIFIED_EXCLUSION', message: `exclusion decisionRef is missing, stale, unrelated, duplicate, or an ineligible decision kind: ${exclusion.pathRef}`, pathRef: exclusion.pathRef });
    }
  }
  return diagnostics.sort((a, b) => `${a.code}:${a.pathRef ?? ''}`.localeCompare(`${b.code}:${b.pathRef ?? ''}`));
}

export function foundationalExclusionDecisionRef(decision: DecisionData): string {
  return `decision:story-design:${digest(decision).slice(7)}`;
}
