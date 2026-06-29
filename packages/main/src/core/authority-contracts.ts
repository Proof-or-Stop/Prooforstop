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
  claims?: unknown[];
  coverage?: unknown[];
  negativeControls?: unknown[];
  oracleSpecs?: unknown[];
  observedAssertions?: string[];
  artifactDigests?: string[];
  inspectedArtifacts: string[];
  inspectedFiles: string[];
  inspectedHunks: string[];
  inspectedPackRefs: string[];
  diffHash?: string;
  commandDigest?: string;
  transcriptHash?: string;
  note?: string;
  clientName?: string;
  clientVersion?: string;
  authorityMode?: string;
  commandCatalogDigest?: string;
  evidenceSchemaDigest?: string;
  deviceId?: string;
  runnerId?: string;
  reviewedClaimIds?: string[];
  unresolvedLimitations?: string[];
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
// Legacy quarantine: these evidence submission shapes were originally used by
// the retired server-backed client path. Active consumers use the shared
// contract types for local verifier context and receipt-bundle metadata only.
// ===========================================================================

// ===========================================================================
// Authority policy discovery contract (B-ea92, additive, M1)
//
// Typed shapes for GET /v1/authority/policy. Kept intentionally separate from
// evidence submission shapes (above). Policy discovery is read-only and never
// produces receipts, gate passes, or evidence writes.
//
// OVERCLAIM guard: a policy response that contains `receipt`, `receiptId`,
// `gatePassed`, or `accepted` at the top level is rejected with a non-success
// outcome. These keys belong to the evidence-submission protocol (B-94a6) and
// must never appear in a discovery response.
// ===========================================================================

/** Keys that must NOT appear at the top level of a policy discovery response. */
export const AUTHORITY_POLICY_OVERCLAIM_KEYS: readonly string[] = [
  'receipt',
  'receiptId',
  'gatePassed',
  'accepted',
] as const;

/**
 * Typed shape of the Python authority server's /v1/authority/policy response
 * (authority-policy.v1 contract). Matches the real Python route implementation.
 *
 * Key top-level fields (as returned by the Python server):
 *  - requiredAuthorityMode  : the server's required mode ("enforce" / "shadow" / "local")
 *  - compatibility          : object (NOT string[]) containing supportedAuthorityModes,
 *                             requiredAuthorityMode, requireHandshake, minClientVersions, etc.
 *
 * SCOPE: read-only discovery. This type does NOT contain any evidence-submission
 * or receipt fields. If the server returns those keys they are treated as an
 * overclaim and the discovery fails.
 */
export interface AuthorityPolicyContract {
  contractVersion: string;        // "authority-policy.v1"
  purpose: string;                // "discovery"
  documentation?: string;
  /** The server's required authority mode ("enforce" / "shadow" / "local"). */
  requiredAuthorityMode: string;
  productionEnforceAuthority: boolean;
  requireHandshake: boolean;
  commandCatalogDigest: string;
  evidenceSchemaDigest: string;
  supportedAuthorityModes: string[];
  minClientVersions: Record<string, string>;
  requiredEvidenceFields: string[];
  evidencePolicy: {
    preset: string;
    [key: string]: unknown;
  };
  serverKey?: {
    keyId: string;
    algorithm: string;
    encoding: string;
    publicKeyHex: string;
    [key: string]: unknown;
  };
  /** Object containing compatibility metadata (supportedAuthorityModes, minClientVersions, etc.). */
  compatibility: {
    supportedAuthorityModes: string[];
    requiredAuthorityMode: string;
    requireHandshake: boolean;
    handshakeRequiredFields?: string[];
    minClientVersions: Record<string, string>;
    commandCatalogDigest: string;
    evidenceSchemaDigest: string;
    productionEnforceAuthority: boolean;
    requireActorKeyBinding: boolean;
    requireRunnerHeartbeatForL2: boolean;
    serverKey?: {
      keyId: string;
      algorithm: string;
      encoding: string;
      publicKeyHex: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const AuthorityPolicyContractSchema = z.object({
  contractVersion: z.string(),
  purpose: z.string(),
  documentation: z.string().optional(),
  requiredAuthorityMode: z.string(),
  productionEnforceAuthority: z.boolean(),
  requireHandshake: z.boolean(),
  commandCatalogDigest: z.string(),
  evidenceSchemaDigest: z.string(),
  supportedAuthorityModes: z.array(z.string()),
  minClientVersions: z.record(z.string(), z.string()),
  requiredEvidenceFields: z.array(z.string()),
  evidencePolicy: z.object({
    preset: z.string(),
  }).passthrough(),
  serverKey: z.object({
    keyId: z.string(),
    algorithm: z.string(),
    encoding: z.string(),
    publicKeyHex: z.string(),
  }).passthrough().optional(),
  compatibility: z.object({
    supportedAuthorityModes: z.array(z.string()),
    requiredAuthorityMode: z.string(),
    requireHandshake: z.boolean(),
    handshakeRequiredFields: z.array(z.string()).optional(),
    minClientVersions: z.record(z.string(), z.string()),
    commandCatalogDigest: z.string(),
    evidenceSchemaDigest: z.string(),
    productionEnforceAuthority: z.boolean(),
    requireActorKeyBinding: z.boolean(),
    requireRunnerHeartbeatForL2: z.boolean(),
    serverKey: z.object({
      keyId: z.string(),
      algorithm: z.string(),
      encoding: z.string(),
      publicKeyHex: z.string(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

/**
 * Runtime overclaim guard: returns the first overclaim key found in `body`, or
 * undefined when clean. Called BEFORE schema validation so a malicious server
 * cannot sneak in overclaim data inside a schema-valid response.
 *
 * Per "Handler coding conventions": runtime re-validation beyond Zod, because the same
 * body is read from network text that may bypass Zod on exceptional paths.
 */
export function detectPolicyOverclaim(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of AUTHORITY_POLICY_OVERCLAIM_KEYS) {
    if (key in record) return key;
  }
  return undefined;
}

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

// ===========================================================================
// Legacy/out-of-core run-event upload contract — POST /v1/runs/{runId}/events
//
// Legacy quarantine: mirrors the old provider-events envelope shape, but
// for the executor's command / validation / repair / summary / completion events.
// Kept self-contained here (an allowed file) rather than extending the runner
// header so the executor evidence/gate loop has one typed surface to import.
// The CLI never mints a receipt. This compatibility shape is legacy-readable
// only and is not an active local gate or production-completion path.
// ===========================================================================

/** A single executor run event (command / validation / repair / summary / completion). */
export interface AuthorityRunEvent {
  /** Stable event id (client chooses; server dedups via X5 idempotency). */
  eventId?: string;
  /** Event kind, e.g. "command" | "validation" | "repair" | "summary" | "completion". */
  kind?: string;
  /** Python Authority run-event type, e.g. "response.completed" or "lattice.command". */
  type?: string;
  /** ISO 8601 occurredAt timestamp. */
  occurredAt?: string;
  /** Free-form structured payload (digests / refs only — never raw secrets, B4a). */
  payload?: Record<string, unknown>;
}

export const AuthorityRunEventSchema = z.object({
  eventId: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  occurredAt: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).passthrough().refine(value => typeof value.type === 'string' || typeof value.kind === 'string', {
  message: 'run event requires type or kind',
});

/** Signed envelope posted to /v1/runs/{runId}/events. */
export interface AuthorityRunEventsEnvelope {
  actorId: string;
  role: string;
  nonce: string;
  timestamp: string;
  signature?: string;
  runId: string;
  event: {
    type: string;
    payload?: Record<string, unknown>;
  };
}

export const AuthorityRunEventsEnvelopeSchema = z.object({
  actorId: z.string().min(1),
  role: z.string().min(1),
  nonce: z.string().min(1),
  timestamp: z.string().min(1),
  signature: z.string().min(1).optional(),
  runId: z.string().min(1),
  event: z.object({
    type: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict();

/** Build a run-events envelope (signing is the caller's responsibility). */
export function buildAuthorityRunEventsEnvelope(
  header: { actorId: string; role?: string; nonce: string; timestamp?: string; createdAt?: string; signature?: string },
  runId: string,
  events: AuthorityRunEvent[],
): AuthorityRunEventsEnvelope {
  if (events.length !== 1) {
    throw new Error('Python Authority /v1/runs/{runId}/events accepts one event envelope per POST');
  }
  const [event] = events;
  const timestamp = header.timestamp ?? header.createdAt;
  if (!timestamp) {
    throw new Error('run-events envelope requires timestamp');
  }
  const type = event.type ?? (event.kind ? `lattice.${event.kind}` : undefined);
  if (!type) {
    throw new Error('run event requires type or kind');
  }
  return {
    actorId: header.actorId,
    role: header.role ?? 'runner',
    nonce: header.nonce,
    timestamp,
    ...(header.signature ? { signature: header.signature } : {}),
    runId,
    event: {
      type,
      ...(event.payload ? { payload: event.payload } : {}),
    },
  };
}

// ===========================================================================
// Legacy/out-of-core gate-evaluation contract — POST /v1/gates/evaluate (B6 / B15)
//
// The CLI no longer posts this contract as an active runtime path. Legacy
// consumers may still read the shape, but local assurance is proof-admissibility,
// receipt-bundle anti-tamper evidence, and review quorum.
// `gateInputDigest` is the X5 gate idempotency key.
// ===========================================================================

export type AuthorityGateDecisionValue = 'approve' | 'reject' | 'blocked';

export interface MaterialOverlapAuditContract {
  changedFiles: string[];
  actualFileOverlaps: string[];
}

export const MaterialOverlapAuditContractSchema = z.object({
  changedFiles: z.array(z.string()),
  actualFileOverlaps: z.array(z.string()),
}).strict();

/** Current CLI/smoke caller-owned default when no material-overlap detector exists. */
export function buildNoOverlapMaterialOverlapAuditDefault(): MaterialOverlapAuditContract {
  return {
    changedFiles: [],
    actualFileOverlaps: [],
  };
}

/** Gate input fields (B15) the client sends to /v1/gates/evaluate. */
export interface GateEvaluateRequestContract {
  projectId: string;
  storyId: string;
  targetPhase: string;
  until: string;
  /** X5 gate idempotency key = digest over the canonical gate input. */
  gateInputDigest: string;
  jobId?: string;
  authorityRunId?: string;
  requestedByRunnerId?: string;
  policyVersion?: string;
  stateVersion?: number;
  canonicalStoryDigest?: string;
  materialHash?: string;
  repo?: RepoSnapshotContract;
  validationDigest?: string;
  evidenceRefs?: string[];
  providerEventRefs?: string[];
  commandEventRefs?: string[];
  gitEvidenceRefs?: string[];
  materialOverlapAudit?: MaterialOverlapAuditContract;
}

export const GateEvaluateRequestContractSchema = z.object({
  projectId: z.string().min(1),
  storyId: z.string().min(1),
  targetPhase: z.string().min(1),
  until: z.string().min(1),
  gateInputDigest: z.string().min(1),
  jobId: z.string().min(1).optional(),
  authorityRunId: z.string().min(1).optional(),
  requestedByRunnerId: z.string().min(1).optional(),
  policyVersion: z.string().min(1).optional(),
  stateVersion: z.number().int().optional(),
  canonicalStoryDigest: z.string().min(1).optional(),
  materialHash: z.string().min(1).optional(),
  repo: z.object({
    headHash: z.string().min(1).optional(),
    materialHash: z.string().min(1).optional(),
    dirty: z.boolean().optional(),
  }).passthrough().optional(),
  validationDigest: z.string().min(1).optional(),
  evidenceRefs: z.array(z.string()).optional(),
  providerEventRefs: z.array(z.string()).optional(),
  commandEventRefs: z.array(z.string()).optional(),
  gitEvidenceRefs: z.array(z.string()).optional(),
  materialOverlapAudit: MaterialOverlapAuditContractSchema.optional(),
}).passthrough();

/**
 * Compute the X5 gate idempotency key (gateInputDigest) over the canonical gate
 * input, excluding the digest field itself so it is stable and self-referential.
 */
export function computeGateInputDigest(
  input: Omit<GateEvaluateRequestContract, 'gateInputDigest'>,
): string {
  return digestCanonical(input);
}

/** Assemble the gate request and stamp its idempotency digest. */
export function buildGateEvaluateRequest(
  input: Omit<GateEvaluateRequestContract, 'gateInputDigest'>,
): GateEvaluateRequestContract {
  return { ...input, gateInputDigest: computeGateInputDigest(input) };
}

/**
 * Server response to /v1/gates/evaluate. `decision` is the gate verdict; only
 * `approve` may support per-run authority DONE. A native gate_decision receipt
 * is returned inline (`receipt`) or by reference (`receiptId`); the client fetches
 * and verifies it — acceptance of this body alone is NOT a DONE projection.
 */
export interface GateEvaluateResultContract {
  decision: AuthorityGateDecisionValue;
  decisionDigest?: string;
  receiptId?: string;
  receipt?: Record<string, unknown>;
  reason?: string;
}

export const GateEvaluateResultContractSchema: z.ZodType<GateEvaluateResultContract> = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const decision = record.decision;
  if (decision && typeof decision === 'object' && !Array.isArray(decision)) {
    const decisionRecord = decision as Record<string, unknown>;
    const verdict = decisionRecord.verdict;
    const normalized: AuthorityGateDecisionValue =
      verdict === 'pass' ? 'approve' : verdict === 'fail' ? 'reject' : 'blocked';
    const receipt = record.receipt && typeof record.receipt === 'object' && !Array.isArray(record.receipt)
      ? record.receipt as Record<string, unknown>
      : undefined;
    const reasons = Array.isArray(decisionRecord.reasons)
      ? decisionRecord.reasons.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      decision: normalized,
      ...(typeof receipt?.decisionDigest === 'string' ? { decisionDigest: receipt.decisionDigest } : {}),
      ...(typeof receipt?.receiptId === 'string' ? { receiptId: receipt.receiptId } : {}),
      ...(receipt ? { receipt } : {}),
      ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
    };
  }
  return value;
}, z.object({
  decision: z.enum(['approve', 'reject', 'blocked']),
  decisionDigest: z.string().min(1).optional(),
  receiptId: z.string().min(1).optional(),
  receipt: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().optional(),
}).passthrough());

// ===========================================================================
// Multi-host verdict contract — POST/GET /v1/jobs/{jobId}/verdicts
//
// Server-side multi-host verification surface (truth source §X9, "Verdict
// submission and reconciliation"). The CLI submits one host's verdict claim and
// reads back the Authority-computed reconciliation. This is deliberately a
// SEPARATE protocol from the gate/receipt contract above:
//
//  - POST returns a `host_verdict` receipt, NOT a `gate_decision` receipt. A host
//    verdict is one host's opinion certified for audit; it is never a production
//    DONE decision. A verdict endpoint that returns a `gate_decision` receipt is an
//    overclaim and is rejected at the schema boundary (see the kind refine below),
//    exactly mirroring the policy-discovery overclaim guard.
//  - Independence is computed by the Authority from the authenticated host/session/
//    key binding, NOT from self-reported JSON. The client only types and surfaces
//    the server's reconciliation block (`independentHostCount` / `satisfied`); it
//    must never recompute independence from the submission body.
//  - Submitting verdicts and reading a satisfied reconciliation is NOT authority
//    DONE. `fullAuthorityDone` still requires per-run `authorityDone` (a verified
//    native gate_decision receipt) PLUS this passing multi-host wave; the receipt
//    half is owned by /v1/gates/evaluate, never by this endpoint.
// ===========================================================================

export type AuthorityVerdictDecisionValue = 'pass' | 'fail' | 'blocked';

/** The kind a verdict-endpoint receipt MUST carry. */
export const AUTHORITY_VERDICT_RECEIPT_KIND = 'host_verdict';

export const FINAL_HOST_REVIEW_PROMPT_PROFILE = 'lattice-final-host-check-v1';

export const FINAL_HOST_REVIEW_CORE_PRINCIPLES = [
  "don't optimize for the sake of optimization",
  "don't optimize arbitrarily",
  'only fix real correctness issues',
  'preserve consistency of logic',
] as const;

export function buildFinalHostReviewPromptDigestInput(input: {
  reviewWaveId?: string;
  provider?: string;
  checkedReceiptId?: string;
  /** Server policy: this is the native gate_decision receipt inputDigest, not the executor X5 idempotency digest. */
  checkedGateInputDigest?: string;
  checkedEvidenceRefs?: string[];
  checkedValidationDigest?: string;
  checkedMaterialHash?: string;
  checkedCommit?: string;
}): Record<string, unknown> {
  return {
    kind: 'lattice.final_host_review_prompt.v1',
    profile: FINAL_HOST_REVIEW_PROMPT_PROFILE,
    principles: [...FINAL_HOST_REVIEW_CORE_PRINCIPLES],
    reviewWaveId: input.reviewWaveId,
    provider: input.provider,
    checkedReceiptId: input.checkedReceiptId,
    checkedGateInputDigest: input.checkedGateInputDigest,
    checkedEvidenceRefs: [...(input.checkedEvidenceRefs ?? [])].sort(),
    checkedValidationDigest: input.checkedValidationDigest,
    checkedMaterialHash: input.checkedMaterialHash,
    checkedCommit: input.checkedCommit,
  };
}

/**
 * The kind a verdict-endpoint receipt must NEVER carry: `gate_decision` is the
 * native production-DONE receipt owned by /v1/gates/evaluate. A host verdict is not
 * a gate decision, so a verdict endpoint returning this kind is treated as an
 * overclaim and fails schema validation (client maps it to `error`, ok:false).
 */
export const AUTHORITY_VERDICT_FORBIDDEN_RECEIPT_KIND = 'gate_decision';

/** Returns true when a verdict-endpoint receipt kind is the forbidden gate_decision overclaim. */
export function isVerdictReceiptKindOverclaim(kind: unknown): boolean {
  return kind === AUTHORITY_VERDICT_FORBIDDEN_RECEIPT_KIND;
}

/**
 * One host's verdict claim, posted to /v1/jobs/{jobId}/verdicts. The server derives
 * the authenticated host/session/key binding from the request context and does NOT
 * trust those identity fields from the body for independence counting (§X9 verifier
 * authenticity). `jobId` lives in the path, not the body.
 */
export interface AuthorityVerdictClaim {
  runId: string;
  storyId: string;
  role: 'implementer' | 'verifier' | 'reviewer' | string;
  provider: string;
  model?: string;
  decision: AuthorityVerdictDecisionValue;
  reviewWaveId?: string;
  reviewPromptProfile?: string;
  reviewPromptDigest?: string;
  checkedEvidenceRefs?: string[];
  checkedReceiptId?: string;
  /** Native gate_decision receipt inputDigest inspected by the host. */
  checkedGateInputDigest?: string;
  checkedValidationDigest?: string;
  checkedMaterialHash?: string;
  checkedCommit?: string;
  commandsRun?: string[];
  findings?: string[];
  artifactDigest?: string;
  issuedAt?: string;
}

/** Request body sent to POST /v1/jobs/{jobId}/verdicts. */
export interface AuthorityVerdictSubmission {
  verdict: AuthorityVerdictClaim;
}

/** Build the request body for a single host verdict submission. */
export function buildAuthorityVerdictSubmission(
  verdict: AuthorityVerdictClaim,
): AuthorityVerdictSubmission {
  return { verdict };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVerdictReceiptInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    kind: value.kind ?? AUTHORITY_VERDICT_RECEIPT_KIND,
    decision: value.decision ?? value.verdict,
    independent: value.independent ?? value.independentHostCounted,
    receiptId: value.receiptId ?? value.receipt_id,
    reviewPromptProfile: value.reviewPromptProfile ?? value.review_prompt_profile,
    reviewPromptDigest: value.reviewPromptDigest ?? value.promptDigest ?? value.review_prompt_digest,
    checkedEvidenceRefs: value.checkedEvidenceRefs ?? value.checked_evidence_refs,
    checkedReceiptId: value.checkedReceiptId ?? value.checked_receipt_id,
    checkedGateInputDigest: value.checkedGateInputDigest ?? value.checked_gate_input_digest,
    checkedValidationDigest: value.checkedValidationDigest ?? value.checked_validation_digest,
    checkedMaterialHash: value.checkedMaterialHash ?? value.checked_material_hash ?? value.materialDigest,
    checkedCommit: value.checkedCommit ?? value.checked_commit,
  };
}

/**
 * The `host_verdict` receipt returned by the verdict endpoint. `hostId` (and any
 * other identity binding) is the Authority's authenticated derivation, not a copy of
 * the submitted body. `kind` is validated to never be `gate_decision`.
 */
export interface AuthorityVerdictReceipt {
  kind: string;
  verdictId: string;
  jobId: string;
  runId: string;
  storyId?: string;
  hostId: string;
  provider?: string;
  role?: string;
  decision: AuthorityVerdictDecisionValue;
  reviewWaveId?: string;
  reviewPromptProfile?: string;
  reviewPromptDigest?: string;
  checkedEvidenceRefs?: string[];
  checkedReceiptId?: string;
  /** Native gate_decision receipt inputDigest inspected by the host. */
  checkedGateInputDigest?: string;
  checkedValidationDigest?: string;
  checkedMaterialHash?: string;
  checkedCommit?: string;
  /** Whether the Authority counted this host as a NEW independent host. */
  independent?: boolean;
  /** Server-minted host_verdict receipt id. Python Authority returns this on list records. */
  receiptId?: string;
  issuedAt: string;
  signature?: string;
  [key: string]: unknown;
}

export const AuthorityVerdictReceiptSchema = z.preprocess(normalizeVerdictReceiptInput, z.object({
  kind: z.string().min(1),
  verdictId: z.string().min(1),
  jobId: z.string().min(1),
  runId: z.string().min(1),
  storyId: z.string().min(1).optional(),
  hostId: z.string().min(1),
  provider: z.string().optional(),
  role: z.string().optional(),
  decision: z.enum(['pass', 'fail', 'blocked']),
  reviewWaveId: z.string().optional(),
  reviewPromptProfile: z.string().optional(),
  reviewPromptDigest: z.string().optional(),
  checkedEvidenceRefs: z.array(z.string()).optional(),
  checkedReceiptId: z.string().optional(),
  checkedGateInputDigest: z.string().optional(),
  checkedValidationDigest: z.string().optional(),
  checkedMaterialHash: z.string().optional(),
  checkedCommit: z.string().optional(),
  independent: z.boolean().optional(),
  receiptId: z.string().min(1).optional(),
  issuedAt: z.string().min(1),
  signature: z.string().optional(),
}).passthrough().refine(
  receipt => !isVerdictReceiptKindOverclaim(receipt.kind),
  {
    message: `verdict endpoint must not return a "${AUTHORITY_VERDICT_FORBIDDEN_RECEIPT_KIND}" receipt: a host verdict is not a production DONE gate decision`,
    path: ['kind'],
  },
));

/**
 * Authority-computed reconciliation over the job's verdict records. The server owns
 * independence counting; the client only surfaces these numbers. `satisfied` is the
 * single mechanical "multi-host wave passed" flag (enough independent passing hosts,
 * no failing verdict). It is NOT, by itself, `fullAuthorityDone`.
 */
export interface AuthorityVerdictReconciliation {
  independentHostCount: number;
  requiredHostCount: number;
  passingIndependentHostCount: number;
  failingIndependentHostCount: number;
  duplicateVerdictCount?: number;
  satisfiedReviewWaveCount?: number;
  requiredReviewWaveCount?: number;
  reviewWaveRefs?: string[];
  satisfied: boolean;
  blockedReason?: string;
}

function numberOrFallback(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeVerdictReconciliationInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const total = numberOrFallback(value.totalVerdictCount);
  const independent =
    value.independentHostCount
    ?? value.independentHostVerdictCount
    ?? value.independent_host_verdict_count
    ?? 0;
  const independentCount = numberOrFallback(independent);
  const failingHostIds = Array.isArray(value.failingHostIds) ? value.failingHostIds : [];
  const hasFailing = value.hasFailingVerdict === true || failingHostIds.length > 0;
  return {
    ...value,
    independentHostCount: independentCount,
    requiredHostCount: value.requiredHostCount ?? value.requiredIndependentHostCount ?? value.required_independent_host_count ?? 0,
    passingIndependentHostCount: value.passingIndependentHostCount ?? value.passing_independent_host_count ?? 0,
    failingIndependentHostCount: value.failingIndependentHostCount ?? failingHostIds.length,
    duplicateVerdictCount: value.duplicateVerdictCount ?? (total > 0 ? Math.max(0, total - independentCount) : undefined),
    satisfied: value.satisfied ?? value.multiHostGateSatisfied ?? value.multi_host_gate_satisfied ?? false,
    blockedReason: value.blockedReason ?? (hasFailing ? 'multi_host_disagreement' : undefined),
  };
}

export const AuthorityVerdictReconciliationSchema = z.preprocess(normalizeVerdictReconciliationInput, z.object({
  independentHostCount: z.number().int().nonnegative(),
  requiredHostCount: z.number().int().nonnegative(),
  passingIndependentHostCount: z.number().int().nonnegative(),
  failingIndependentHostCount: z.number().int().nonnegative(),
  duplicateVerdictCount: z.number().int().nonnegative().optional(),
  satisfiedReviewWaveCount: z.number().int().nonnegative().optional(),
  requiredReviewWaveCount: z.number().int().nonnegative().optional(),
  reviewWaveRefs: z.array(z.string().min(1)).optional(),
  satisfied: z.boolean(),
  blockedReason: z.string().optional(),
}).passthrough());

const AuthorityVerdictEndpointReceiptSchema = z.object({
  kind: z.string().min(1),
}).passthrough().refine(
  receipt => !isVerdictReceiptKindOverclaim(receipt.kind),
  {
    message: `verdict endpoint must not return a "${AUTHORITY_VERDICT_FORBIDDEN_RECEIPT_KIND}" receipt: a host verdict is not a production DONE gate decision`,
    path: ['kind'],
  },
);

/** Server response to POST /v1/jobs/{jobId}/verdicts. */
export interface AuthorityVerdictSubmitResult {
  accepted: boolean;
  verdict?: AuthorityVerdictReceipt;
  /** Server receipt metadata for the host verdict record; never a gate_decision. */
  receipt?: Record<string, unknown>;
  reconciliation?: AuthorityVerdictReconciliation;
  reason?: string;
}

export const AuthorityVerdictSubmitResultSchema = z.object({
  accepted: z.boolean(),
  verdict: AuthorityVerdictReceiptSchema.optional(),
  receipt: AuthorityVerdictEndpointReceiptSchema.optional(),
  reconciliation: AuthorityVerdictReconciliationSchema.optional(),
  reason: z.string().optional(),
}).passthrough();

/** Server response to GET /v1/jobs/{jobId}/verdicts. */
export interface AuthorityVerdictListResult {
  jobId: string;
  runId?: string;
  verdicts: AuthorityVerdictReceipt[];
  reconciliation: AuthorityVerdictReconciliation;
}

export const AuthorityVerdictListResultSchema = z.object({
  jobId: z.string().min(1),
  runId: z.string().optional(),
  verdicts: z.array(AuthorityVerdictReceiptSchema),
  reconciliation: AuthorityVerdictReconciliationSchema,
}).passthrough();
