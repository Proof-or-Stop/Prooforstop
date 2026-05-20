import { createHash } from 'node:crypto';

export interface RepoSnapshotContract {
  headHash?: string;
  dirty?: boolean;
  materialHash?: string;
}

export interface VerificationCommandContract {
  command: string | string[];
  commandDigest?: string;
  commandClass?: string;
  required?: boolean;
}

export interface VerificationTargetContract {
  targetId: string;
  producerRunId: string;
  diffHash?: string;
  artifactRefs?: string[];
  checklistItemIds?: string[];
  testIntentRefs?: string[];
  requiredCommands?: VerificationCommandContract[];
  acceptanceCriteria?: string[];
  requiredRefs?: string[];
  requiredFiles?: string[];
  requiredHunks?: string[];
  metadata?: Record<string, unknown>;
}

export interface ContextPackHunkContract {
  hunkRef: string;
  file: string;
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  header?: string;
  patchHash?: string;
  riskTags?: string[];
  required?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ContextPackSnippetContract {
  snippetRef: string;
  file: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  content?: string;
  hunkRefs?: string[];
  tokenEstimate?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextPackSymbolContract {
  symbolRef: string;
  file: string;
  symbolName: string;
  kind?: string;
  line?: number;
  hunkRefs?: string[];
  riskTags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ContextPackDependencyEdgeContract {
  sourceRef: string;
  targetRef: string;
  edgeType: string;
  confidence?: string;
  metadata?: Record<string, unknown>;
}

export interface VerificationContextPackContract {
  packId: string;
  producerRunId: string;
  storyId?: string;
  baseRef?: string;
  headRef?: string;
  repo?: RepoSnapshotContract;
  diffHash?: string;
  changedFiles?: string[];
  changedHunks?: ContextPackHunkContract[];
  changedSymbols?: ContextPackSymbolContract[];
  impactedFiles?: string[];
  impactedSymbols?: ContextPackSymbolContract[];
  dependencyEdges?: ContextPackDependencyEdgeContract[];
  sourceSnippets?: ContextPackSnippetContract[];
  checklistItemIds?: string[];
  testIntentRefs?: string[];
  acceptanceCriteria?: string[];
  requiredCommands?: VerificationCommandContract[];
  oracleRefs?: string[];
  riskTags?: string[];
  requiredRefs?: string[];
  excludedPaths?: string[];
  limitations?: string[];
  tokenBudget?: number;
  estimatedTokens?: number;
  truncated?: boolean;
  parentPackDigest?: string;
  expansionReason?: string;
  metadata?: Record<string, unknown>;
}

export interface EvidenceEnvelopeContract {
  evidenceId: string;
  projectId: string;
  storyId: string;
  producerActorId: string;
  role: string;
  kind: string;
  trustLevel: number;
  repo: RepoSnapshotContract;
  itemId?: string;
  intentRef?: string;
  command?: string;
  exitCode?: number;
  producerRunId?: string;
  verifierRunId?: string;
  provider?: string;
  model?: string;
  vendor?: string;
  verificationTargetId?: string;
  verificationTargetDigest?: string;
  verificationContextPackId?: string;
  verificationContextPackDigest?: string;
  coveredRefs: string[];
  uncoveredRefs: string[];
  failedRefs: string[];
  inspectedArtifacts: string[];
  inspectedFiles: string[];
  inspectedHunks: string[];
  inspectedPackRefs: string[];
  diffHash?: string;
  commandDigest?: string;
  transcriptHash?: string;
  note?: string;
  nonce: string;
  createdAt: string;
  signature?: string;
}

export interface TargetBoundEvidenceInput {
  evidenceId: string;
  projectId: string;
  storyId: string;
  producerActorId: string;
  role?: string;
  kind?: string;
  trustLevel?: number;
  repo?: RepoSnapshotContract;
  itemId?: string;
  intentRef?: string;
  command?: string;
  exitCode?: number;
  producerRunId?: string;
  verifierRunId?: string;
  provider?: string;
  model?: string;
  vendor?: string;
  verificationTarget?: VerificationTargetContract;
  verificationTargetDigest?: string;
  verificationContextPack?: VerificationContextPackContract;
  verificationContextPackDigest?: string;
  coveredRefs?: string[];
  uncoveredRefs?: string[];
  failedRefs?: string[];
  inspectedArtifacts?: string[];
  inspectedFiles?: string[];
  inspectedHunks?: string[];
  inspectedPackRefs?: string[];
  diffHash?: string;
  commandDigest?: string;
  transcriptHash?: string;
  note?: string;
  nonce: string;
  createdAt: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function normalizeJson(value: unknown): JsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map(item => normalizeJson(item)).filter(item => item !== undefined) as JsonValue[];
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalizeJson(item)] as const)
      .filter((entry): entry is readonly [string, JsonValue] => entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries) as JsonValue;
  }
  return String(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function digestCommand(command: string | string[]): string {
  return digestCanonical({ command });
}

export function normalizeVerificationContextPack(
  pack: VerificationContextPackContract,
): VerificationContextPackContract {
  return {
    ...pack,
    changedFiles: [...(pack.changedFiles ?? [])].sort(),
    changedHunks: [...(pack.changedHunks ?? [])].sort((a, b) => a.hunkRef.localeCompare(b.hunkRef)),
    changedSymbols: [...(pack.changedSymbols ?? [])].sort((a, b) => a.symbolRef.localeCompare(b.symbolRef)),
    impactedFiles: [...(pack.impactedFiles ?? [])].sort(),
    impactedSymbols: [...(pack.impactedSymbols ?? [])].sort((a, b) => a.symbolRef.localeCompare(b.symbolRef)),
    dependencyEdges: [...(pack.dependencyEdges ?? [])].sort((a, b) => `${a.sourceRef}:${a.targetRef}`.localeCompare(`${b.sourceRef}:${b.targetRef}`)),
    sourceSnippets: [...(pack.sourceSnippets ?? [])].sort((a, b) => a.snippetRef.localeCompare(b.snippetRef)),
    checklistItemIds: [...(pack.checklistItemIds ?? [])].sort(),
    testIntentRefs: [...(pack.testIntentRefs ?? [])].sort(),
    acceptanceCriteria: [...(pack.acceptanceCriteria ?? [])],
    requiredCommands: [...(pack.requiredCommands ?? [])],
    oracleRefs: [...(pack.oracleRefs ?? [])].sort(),
    riskTags: [...(pack.riskTags ?? [])].sort(),
    requiredRefs: [...(pack.requiredRefs ?? [])].sort(),
    excludedPaths: [...(pack.excludedPaths ?? [])].sort(),
    limitations: [...(pack.limitations ?? [])],
    estimatedTokens: pack.estimatedTokens ?? 0,
    truncated: pack.truncated ?? false,
    metadata: pack.metadata ?? {},
  };
}

export function digestVerificationContextPack(pack: VerificationContextPackContract): string {
  return digestCanonical(normalizeVerificationContextPack(pack));
}

export function allTargetRequiredRefs(target: VerificationTargetContract): string[] {
  const refs = [
    ...(target.requiredRefs ?? []),
    ...(target.checklistItemIds ?? []).map(id => `checklist:${id}`),
    ...(target.testIntentRefs ?? []).map(ref => `intent:${ref}`),
    ...(target.artifactRefs ?? []),
    ...(target.requiredFiles ?? []).map(path => `file:${path}`),
    ...(target.requiredHunks ?? []).map(ref => `hunk:${ref}`),
  ];
  return [...new Set(refs)].sort();
}

export function allContextPackRequiredRefs(pack: VerificationContextPackContract): string[] {
  const normalized = normalizeVerificationContextPack(pack);
  const refs = [
    ...(normalized.requiredRefs ?? []),
    ...(normalized.changedFiles ?? []).map(path => `file:${path}`),
    ...(normalized.impactedFiles ?? []).map(path => `file:${path}`),
    ...(normalized.changedHunks ?? []).map(hunk => `hunk:${hunk.hunkRef}`),
    ...(normalized.sourceSnippets ?? []).map(snippet => `snippet:${snippet.snippetRef}`),
    ...(normalized.checklistItemIds ?? []).map(id => `checklist:${id}`),
    ...(normalized.testIntentRefs ?? []).map(ref => `intent:${ref}`),
    ...(normalized.oracleRefs ?? []).map(ref => `oracle:${ref}`),
  ];
  return [...new Set(refs)].sort();
}

export function buildTargetBoundEvidenceEnvelope(input: TargetBoundEvidenceInput): EvidenceEnvelopeContract {
  const contextPack = input.verificationContextPack;
  const target = input.verificationTarget;
  const targetDigest = input.verificationTargetDigest ?? (target ? digestCanonical(target) : undefined);
  const contextPackDigest = input.verificationContextPackDigest
    ?? (contextPack ? digestVerificationContextPack(contextPack) : undefined);
  const coveredRefs = [
    ...(input.coveredRefs ?? []),
    ...(target ? allTargetRequiredRefs(target) : []),
    ...(contextPack ? allContextPackRequiredRefs(contextPack) : []),
  ];

  return {
    evidenceId: input.evidenceId,
    projectId: input.projectId,
    storyId: input.storyId,
    producerActorId: input.producerActorId,
    role: input.role ?? 'verifier',
    kind: input.kind ?? 'logic_test',
    trustLevel: input.trustLevel ?? 2,
    repo: input.repo ?? {},
    itemId: input.itemId,
    intentRef: input.intentRef,
    command: input.command,
    exitCode: input.exitCode,
    producerRunId: input.producerRunId ?? target?.producerRunId ?? contextPack?.producerRunId,
    verifierRunId: input.verifierRunId,
    provider: input.provider,
    model: input.model,
    vendor: input.vendor,
    verificationTargetId: target?.targetId,
    verificationTargetDigest: targetDigest,
    verificationContextPackId: contextPack?.packId,
    verificationContextPackDigest: contextPackDigest,
    coveredRefs: [...new Set(coveredRefs)].sort(),
    uncoveredRefs: input.uncoveredRefs ?? [],
    failedRefs: input.failedRefs ?? [],
    inspectedArtifacts: input.inspectedArtifacts ?? [],
    inspectedFiles: input.inspectedFiles ?? [],
    inspectedHunks: input.inspectedHunks ?? [],
    inspectedPackRefs: input.inspectedPackRefs ?? (contextPack ? allContextPackRequiredRefs(contextPack) : []),
    diffHash: input.diffHash ?? target?.diffHash ?? contextPack?.diffHash,
    commandDigest: input.commandDigest,
    transcriptHash: input.transcriptHash,
    note: input.note,
    nonce: input.nonce,
    createdAt: input.createdAt,
  };
}

export function prepareEvidenceEnvelopeForSigning(
  envelope: EvidenceEnvelopeContract,
): Omit<EvidenceEnvelopeContract, 'signature'> {
  const { signature: _signature, ...unsigned } = envelope;
  return {
    ...unsigned,
    coveredRefs: unsigned.coveredRefs ?? [],
    uncoveredRefs: unsigned.uncoveredRefs ?? [],
    failedRefs: unsigned.failedRefs ?? [],
    inspectedArtifacts: unsigned.inspectedArtifacts ?? [],
    inspectedFiles: unsigned.inspectedFiles ?? [],
    inspectedHunks: unsigned.inspectedHunks ?? [],
    inspectedPackRefs: unsigned.inspectedPackRefs ?? [],
  };
}
