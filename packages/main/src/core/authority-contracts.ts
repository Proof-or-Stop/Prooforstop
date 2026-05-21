import { createHash } from 'node:crypto';
import { z } from 'zod';

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

export const VerificationCommandContractSchema = z.object({
  command: z.union([z.string(), z.array(z.string())]),
  commandDigest: z.string().optional(),
  commandClass: z.string().optional(),
  required: z.boolean().optional(),
}).passthrough();

export const RepoSnapshotContractSchema = z.object({
  headHash: z.string().optional(),
  dirty: z.boolean().optional(),
  materialHash: z.string().optional(),
}).passthrough();

export const ContextPackHunkContractSchema = z.object({
  hunkRef: z.string(),
  file: z.string(),
  oldStart: z.number().int().optional(),
  oldLines: z.number().int().optional(),
  newStart: z.number().int().optional(),
  newLines: z.number().int().optional(),
  header: z.string().optional(),
  patchHash: z.string().optional(),
  riskTags: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const ContextPackSnippetContractSchema = z.object({
  snippetRef: z.string(),
  file: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  contentHash: z.string(),
  content: z.string().optional(),
  hunkRefs: z.array(z.string()).optional(),
  tokenEstimate: z.number().int().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const ContextPackSymbolContractSchema = z.object({
  symbolRef: z.string(),
  file: z.string(),
  symbolName: z.string(),
  kind: z.string().optional(),
  line: z.number().int().optional(),
  hunkRefs: z.array(z.string()).optional(),
  riskTags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const ContextPackDependencyEdgeContractSchema = z.object({
  sourceRef: z.string(),
  targetRef: z.string(),
  edgeType: z.string(),
  confidence: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const VerificationContextPackContractSchema = z.object({
  packId: z.string(),
  producerRunId: z.string(),
  storyId: z.string().optional(),
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
  repo: RepoSnapshotContractSchema.optional(),
  diffHash: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
  changedHunks: z.array(ContextPackHunkContractSchema).optional(),
  changedSymbols: z.array(ContextPackSymbolContractSchema).optional(),
  impactedFiles: z.array(z.string()).optional(),
  impactedSymbols: z.array(ContextPackSymbolContractSchema).optional(),
  dependencyEdges: z.array(ContextPackDependencyEdgeContractSchema).optional(),
  sourceSnippets: z.array(ContextPackSnippetContractSchema).optional(),
  checklistItemIds: z.array(z.string()).optional(),
  testIntentRefs: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  requiredCommands: z.array(VerificationCommandContractSchema).optional(),
  oracleRefs: z.array(z.string()).optional(),
  riskTags: z.array(z.string()).optional(),
  requiredRefs: z.array(z.string()).optional(),
  excludedPaths: z.array(z.string()).optional(),
  limitations: z.array(z.string()).optional(),
  tokenBudget: z.number().int().nonnegative().optional(),
  estimatedTokens: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  parentPackDigest: z.string().optional(),
  expansionReason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

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

export function parseVerificationContextPackContract(
  value: unknown,
  label = 'verification context pack',
): VerificationContextPackContract {
  const parsed = VerificationContextPackContractSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`${label} is invalid: ${issues}`);
  }
  return parsed.data;
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
    ...(normalized.requiredCommands ?? []).map(command => `command:${command.commandDigest ?? digestCommand(command.command)}`),
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

// ===========================================================================
// Authority submission protocol (B-94a6, additive)
//
// NEW exports only. None of the B-2157 VCP exports above are modified — these
// describe the request/response shapes for POSTing an EvidenceEnvelopeContract
// to the cross-repo Python authority server (verification-context-pack.md is the
// shared truth source). Kept intentionally minimal: only the single + batch
// evidence submission shapes that authority-client.ts needs.
// ===========================================================================

/** Single-evidence submission request body sent to the authority server. */
export interface AuthorityEvidenceSubmission {
  evidence: EvidenceEnvelopeContract;
}

/** Batch-evidence submission request body — all-or-nothing on the server side. */
export interface AuthorityEvidenceBatchSubmission {
  evidences: EvidenceEnvelopeContract[];
}

/**
 * Per-entry acceptance status the authority server may return for a batch.
 * `accepted: false` on ANY entry maps to a whole-batch failure in the client
 * (preMortem #3: partial acceptance must not produce a partial local write).
 */
export interface AuthorityEvidenceEntryResult {
  accepted: boolean;
  evidenceId?: string;
  reason?: string;
}

/** Authority server response to a single-evidence submission. */
export interface AuthorityEvidenceSubmissionResult {
  accepted: boolean;
  evidenceId?: string;
  reason?: string;
  record?: unknown;
  receipt?: unknown;
}

/** Authority server response to a batch-evidence submission. */
export interface AuthorityEvidenceBatchSubmissionResult {
  accepted: boolean;
  results?: AuthorityEvidenceEntryResult[];
  reason?: string;
}

export const AuthorityEvidenceEntryResultSchema = z.object({
  accepted: z.boolean(),
  evidenceId: z.string().optional(),
  reason: z.string().optional(),
}).passthrough();

export const AuthorityEvidenceSubmissionResultSchema = z.object({
  accepted: z.boolean(),
  evidenceId: z.string().optional(),
  reason: z.string().optional(),
  record: z.unknown().optional(),
  receipt: z.unknown().optional(),
}).passthrough();

export const AuthorityEvidenceBatchSubmissionResultSchema = z.object({
  accepted: z.boolean(),
  results: z.array(AuthorityEvidenceEntryResultSchema).optional(),
  reason: z.string().optional(),
}).passthrough();

/** Build the request body for a single-evidence submission. */
export function buildAuthorityEvidenceSubmission(
  evidence: EvidenceEnvelopeContract,
): AuthorityEvidenceSubmission {
  return { evidence };
}

/** Build the request body for a batch-evidence submission. */
export function buildAuthorityEvidenceBatchSubmission(
  evidences: EvidenceEnvelopeContract[],
): AuthorityEvidenceBatchSubmission {
  return { evidences: [...evidences] };
}

/**
 * Determine whether a batch result represents whole-batch acceptance.
 * Returns false if the top-level `accepted` is false OR any per-entry result is
 * not accepted — enforcing all-or-nothing so a partial accept never yields a
 * partial local write (preMortem #3).
 */
export function isAuthorityBatchFullyAccepted(
  result: AuthorityEvidenceBatchSubmissionResult,
): boolean {
  if (!result.accepted) return false;
  if (result.results && result.results.some(entry => !entry.accepted)) return false;
  return true;
}
