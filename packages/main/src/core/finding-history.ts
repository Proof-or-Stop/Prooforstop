/** Versioned, pure exact history and immutable correction graph. No gate authority. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { identityHash, parseIdentityInput, findingIdentityRefSchema, identityConfirmSchema } from './finding-identity.js';
import { ledgerRefSchema, routeText, routeHash, routeTime } from './finding-route.js';
import type { FindingIdentityRef, IdentitySourceAnchor } from './finding-identity-types.js';
import type { CandidateFinding, DetectorSignal } from './finding-identity-types.js';

const authority = { authority: z.literal('non_authoritative'), gateEvidence: z.literal(false) };
const anchors = identityConfirmSchema.shape.evidenceAnchors;
export const supersessionSchema = z.object({ schemaVersion: z.literal(1), ...authority,
  kind: z.enum(['finding_supersession', 'canonical_defect_supersession']), supersessionId: routeText,
  predecessor: ledgerRefSchema, successor: ledgerRefSchema, predecessorEntityId: routeText, successorEntityId: routeText,
  reason: z.enum(['incorrect_statement', 'better_evidence', 'merged_identity', 'obsolete_measurement', 'root_cause_corrected', 'identity_split', 'identity_merged']),
  evidenceRefs: z.array(routeText).min(1), evidenceAnchors: anchors, createdBy: routeText, reviewRunId: routeText,
  effectiveAt: routeTime, recordHash: routeHash }).strict();
export type HistorySupersession = z.infer<typeof supersessionSchema>;
export const findingSupersessionRequestSchema = z.object({ storyId: routeText, idempotencyKey: routeText,
  predecessor: findingIdentityRefSchema, successor: findingIdentityRefSchema,
  reason: z.enum(['incorrect_statement', 'better_evidence', 'merged_identity', 'obsolete_measurement']),
  evidenceRefs: z.array(routeText).min(1), evidenceAnchors: anchors, reviewRunId: routeText }).strict();
export const canonicalSupersessionRequestSchema = identityConfirmSchema.omit({ memberFindingRefs: true, canonicalFindingRef: true }).extend({
  predecessor: ledgerRefSchema, reason: z.literal('root_cause_corrected'),
}).strict();
export function validateSupersession(value: unknown): asserts value is HistorySupersession {
  const row = parseIdentityInput(supersessionSchema, value); const { recordHash, ...base } = row;
  if (identityHash(value) !== identityHash(row) || identityHash(base) !== recordHash) throw new Error('history: supersession digest mismatch');
  if (row.predecessor.recordId === row.successor.recordId || row.predecessorEntityId === row.successorEntityId && row.kind === 'canonical_defect_supersession') throw new Error('history: self-link or canonical alias');
  const canonicalReason = ['root_cause_corrected', 'identity_split', 'identity_merged'].includes(row.reason);
  if (canonicalReason !== (row.kind === 'canonical_defect_supersession') || Date.parse(row.effectiveAt) > Date.now()) throw new Error('history: invalid supersession kind/time');
}
export interface HistoryNode {
  observationKey: string;
  kind: 'finding' | 'canonical';
  storyId: string;
  entityId: string;
  ref?: { storyId: string; recordId: string; recordHash: string };
  findingRef?: FindingIdentityRef;
  paths: string[];
  packages: string[];
  symbols: string[];
  contracts: string[];
  canonicalIds: string[];
  sourceLineageKeys: string[];
  outcome: string;
  payload: object;
  evidenceAnchors: IdentitySourceAnchor[];
}
export interface HistoryInput { nodes: HistoryNode[]; links: HistorySupersession[]; sourceBindings: { storyId: string; digest: string }[]; }
export function validateHistoryGraph(input: HistoryInput): void {
  const ids = new Map<string, HistoryNode>(); const observations = new Set<string>();
  for (const node of input.nodes) {
    if (observations.has(node.observationKey)) throw new Error('history: duplicate observation identity'); observations.add(node.observationKey);
    if (node.ref) {
      if (ids.has(node.ref.recordId) || node.ref.storyId !== node.storyId) throw new Error('history: durable identity alias');
      ids.set(node.ref.recordId, node);
    }
  }
  const successors = new Map<string, string>(); const predecessors = new Map<string, string>();
  for (const link of input.links) {
    validateSupersession(link);
    const before = ids.get(link.predecessor.recordId); const after = ids.get(link.successor.recordId);
    const kind = link.kind === 'finding_supersession' ? 'finding' : 'canonical';
    if (!before || !after || before.kind !== kind || after.kind !== kind
      || identityHash(before.ref) !== identityHash(link.predecessor) || identityHash(after.ref) !== identityHash(link.successor)
      || before.entityId !== link.predecessorEntityId || after.entityId !== link.successorEntityId) throw new Error('history: missing/substituted supersession node');
    if (successors.has(before.ref!.recordId) || predecessors.has(after.ref!.recordId)) throw new Error('history: conflicting successor or ambiguous merge');
    successors.set(before.ref!.recordId, after.ref!.recordId); predecessors.set(after.ref!.recordId, before.ref!.recordId);
  }
  for (const start of successors.keys()) {
    const seen = new Set<string>(); let next: string | undefined = start;
    while (next) { if (seen.has(next)) throw new Error('history: supersession cycle'); seen.add(next); next = successors.get(next); }
  }
}
/** Resolve exact immutable record IDs, never a bare cross-Story human ID. */
export function canonicalCurrent(input: HistoryInput, recordId: string) {
  validateHistoryGraph(input);
  const byId = new Map(input.nodes.filter(node => node.ref).map(node => [node.ref!.recordId, node]));
  if (!byId.has(recordId)) throw new Error('history: current lookup node missing');
  const next = new Map(input.links.map(link => [link.predecessor.recordId, link.successor.recordId]));
  const prior = new Map(input.links.map(link => [link.successor.recordId, link.predecessor.recordId]));
  let tip = recordId; while (next.has(tip)) tip = next.get(tip)!;
  const predecessors: HistoryNode[] = []; let previous = prior.get(tip);
  while (previous) { predecessors.unshift(byId.get(previous)!); previous = prior.get(previous); }
  return { current: byId.get(tip)!, predecessors, superseded: tip !== recordId };
}
export interface HistoryIndex { schemaVersion: 1; authority: 'non_authoritative'; gateEvidence: false; complete: true;
  sourceBindings: HistoryInput['sourceBindings']; rows: (HistoryNode & { current: boolean; successorRecordId?: string; predecessors: string[] })[]; indexDigest: string; }
export function buildHistoryIndex(input: HistoryInput): HistoryIndex {
  validateHistoryGraph(input);
  const rows = input.nodes.map(node => {
    const lineage = node.ref ? canonicalCurrent(input, node.ref.recordId) : undefined;
    return { ...node, current: !lineage?.superseded, ...(lineage?.superseded ? { successorRecordId: lineage.current.ref!.recordId } : {}),
      predecessors: lineage?.predecessors.map(row => row.ref!.recordId) ?? [] };
  }).sort((a, b) => a.observationKey.localeCompare(b.observationKey));
  const base = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const, complete: true as const,
    sourceBindings: [...input.sourceBindings].sort((a, b) => a.storyId.localeCompare(b.storyId)), rows };
  return { ...base, indexDigest: identityHash(base) };
}
export const historyQuerySchema = z.object({ storyId: routeText, sourceStoryIds: z.array(routeText).min(1).optional(),
  includeSuperseded: z.boolean().optional(), expectedIndexDigest: routeHash.optional(), path: routeText.optional(), package: routeText.optional(),
  symbol: routeText.optional(), contract: routeText.optional(), canonicalDefectId: routeText.optional(), sourceLineageKey: routeText.optional(), outcome: routeText.optional(), recordId: routeText.optional() }).strict();
export function queryHistoryIndex(index: HistoryIndex, query: z.infer<typeof historyQuerySchema>) {
  const { indexDigest, ...base } = index;
  if (identityHash(base) !== indexDigest || !index.complete || (query.expectedIndexDigest && query.expectedIndexDigest !== indexDigest)) throw new Error('history: stale/incomplete index binding');
  return index.rows.filter(row => (query.includeSuperseded || row.current)
    && (!query.path || row.paths.includes(query.path)) && (!query.package || row.packages.includes(query.package))
    && (!query.symbol || row.symbols.includes(query.symbol)) && (!query.contract || row.contracts.includes(query.contract))
    && (!query.canonicalDefectId || row.canonicalIds.includes(query.canonicalDefectId))
    && (!query.sourceLineageKey || row.sourceLineageKeys.includes(query.sourceLineageKey))
    && (!query.outcome || row.outcome === query.outcome) && (!query.recordId || row.ref?.recordId === query.recordId));
}
export const RECALL_TRIGGERS = ['target_created', 'target_started', 'scope_contract_match', 'severity_escalation', 'owner_invalid', 'target_closed_unfixed', 'expired', 'source_hash_drift', 'runtime_drift'] as const;
export const historyRecallSchema = z.object({ storyId: routeText, idempotencyKey: routeText, route: ledgerRefSchema,
  trigger: z.enum(RECALL_TRIGGERS) }).strict();
export const recallRecordSchema = z.object({ schemaVersion: z.literal(1), ...authority, recallId: routeText,
  trigger: z.enum(RECALL_TRIGGERS), triggerDigest: routeHash, route: ledgerRefSchema, candidateId: routeText,
  currentConsent: z.boolean(), consentDiagnostic: routeText, observedSnapshot: z.record(z.string(), z.unknown()),
  createdAt: routeTime, recordHash: routeHash }).strict();
export function validateRecall(value: unknown): void {
  const row = parseIdentityInput(recallRecordSchema, value); const { recordHash, ...base } = row;
  if (identityHash(value) !== identityHash(row) || identityHash(base) !== recordHash) throw new Error('history: recall digest mismatch');
}

/** Exact JSON digest for nullable measurements. Unlike authority normalization,
 * null is a real value here and must never alias an omitted denominator/result. */
export function scorecardDigest(value: unknown): string {
  const encode = (row: unknown): string => {
    if (row === null || typeof row === 'string' || typeof row === 'boolean') return JSON.stringify(row);
    if (typeof row === 'number' && Number.isFinite(row)) return JSON.stringify(row);
    if (typeof row !== 'object' || !row) throw new Error('scorecard: not exact JSON');
    const keys = Reflect.ownKeys(row);
    if (Array.isArray(row)) {
      if (keys.length !== row.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))
        || Array.from({ length: row.length }, (_, index) => Object.getOwnPropertyDescriptor(row, String(index))).some(d => !d || !d.enumerable || !('value' in d))) throw new Error('scorecard: sparse/decorated array');
      return `[${row.map(encode).join(',')}]`;
    }
    if (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null) throw new Error('scorecard: non-plain object');
    if (keys.some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(row, key)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(row, key)!))) throw new Error('scorecard: decorated/accessor object');
    return `{${(keys as string[]).sort().map(key => `${JSON.stringify(key)}:${encode((row as Record<string, unknown>)[key])}`).join(',')}}`;
  };
  return createHash('sha256').update(encode(value)).digest('hex');
}
export const SCORECARD_KINDS = ['detector_signal', 'candidate', 'candidate_reproduction_attestation', 'canonical_defect', 'canonical_revision', 'route_receipt', 'candidate_route',
  'progress_baseline', 'progress_baseline_set', 'progress_evidence', 'progress_predecessor', 'finding_supersession', 'canonical_defect_supersession', 'history_recall'] as const;
export const scorecardQuerySchema = z.object({ storyId: routeText, sourceStoryIds: z.array(routeText).min(1).optional(),
  expectedInputDigest: routeHash.optional(), mode: z.enum(['observe', 'warn']).optional() }).strict();
const opaque = z.record(z.string(), z.unknown());
const scorecardRowSchema = z.object({ storyId: routeText, recordId: routeText, recordHash: routeHash, kind: z.enum(SCORECARD_KINDS),
  record: opaque, envelope: opaque, receipt: opaque }).strict();
const measurementSchema = z.object({ numerator: z.number().int().nonnegative(), denominator: z.number().int().nonnegative(),
  observed: z.number().min(0).max(1).nullable(), status: z.enum(['observed_sample_only', 'insufficient_evidence']) }).strict();
const detectorMeasurementSchema = z.object({ detectorId: routeText, detectorVersion: routeText, family: routeText,
  signalCount: z.number().int().nonnegative(), candidateCount: z.number().int().nonnegative(),
  adjudicatedPromotionFraction: measurementSchema }).strict();
export const identityScorecardSchema = z.object({ schemaVersion: z.literal(1), ...authority, complete: z.literal(true),
  query: z.object({ storyId: routeText, sourceStoryIds: z.array(routeText), mode: z.enum(['observe', 'warn']) }).strict(),
  inputBindings: z.array(z.object({ storyId: routeText, ledgerDigest: routeHash, snapshotDigest: routeHash,
    headHash: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), materialHash: routeHash.nullable(), storyPhase: routeText.nullable(), storyType: routeText.nullable() }).strict()),
  canonicalCatalogDigest: routeHash, inputDigest: routeHash, rowCounts: z.array(z.object({ kind: z.enum(SCORECARD_KINDS), count: z.number().int().nonnegative() }).strict()),
  rows: z.array(scorecardRowSchema), confirmedGroups: z.array(opaque), detectorMeasurements: z.array(detectorMeasurementSchema),
  qualification: z.object({ enforceEligible: z.literal(false), qualifyingWindow: z.null(), latencyMeasured: z.literal(false),
    precisionRecallMeasured: z.literal(false), jointBatchOperations: z.null(), jointThresholdFulfilled: z.literal(false), jointOwner: z.literal('B-e6d9') }).strict(),
  digest: routeHash }).strict();
export type IdentityScorecard = z.infer<typeof identityScorecardSchema>;
function assertScorecardConsistency(row: IdentityScorecard): void {
  const ids = row.inputBindings.map(binding => binding.storyId);
  if (scorecardDigest(ids) !== scorecardDigest(row.query.sourceStoryIds) || new Set(ids).size !== ids.length
    || scorecardDigest({ inputBindings: row.inputBindings, canonicalCatalogDigest: row.canonicalCatalogDigest }) !== row.inputDigest) throw new Error('scorecard: incomplete input binding');
  if (new Set(row.rows.map(value => value.recordId)).size !== row.rows.length
    || scorecardDigest(row.rowCounts) !== scorecardDigest(SCORECARD_KINDS.map(kind => ({ kind, count: row.rows.filter(value => value.kind === kind).length })))) throw new Error('scorecard: incomplete record inventory');
  for (const value of row.rows) {
    if (!ids.includes(value.storyId) || value.record.recordId !== value.recordId || value.record.recordType !== value.kind
      || value.envelope.kind !== value.kind || value.envelope.storyId !== value.storyId
      || scorecardDigest(value.record.payload) !== scorecardDigest(value.envelope)) throw new Error('scorecard: row/carrier subject mismatch');
  }
  for (const measured of row.detectorMeasurements) {
    const metric = measured.adjudicatedPromotionFraction;
    if (metric.numerator > metric.denominator || metric.denominator > measured.candidateCount
      || metric.observed !== (metric.denominator ? metric.numerator / metric.denominator : null)
      || metric.status !== (metric.denominator ? 'observed_sample_only' : 'insufficient_evidence')) throw new Error('scorecard: inconsistent measurement');
  }
}

/** Descriptive adjudication, NOT detector precision/recall. One candidate counts
 * once in each contributing detector/version/category, never once per retry. */
export function detectorAdjudicationMeasurements(signals: readonly DetectorSignal[], candidates: readonly CandidateFinding[]) {
  const bySignal = new Map(signals.map(signal => [signal.signalId, signal]));
  if (bySignal.size !== signals.length || new Set(candidates.map(candidate => candidate.candidateId)).size !== candidates.length) throw new Error('scorecard: duplicate current signal/candidate');
  const buckets = new Map<string, { detectorId: string; detectorVersion: string; family: string; signalCount: number; candidates: Map<string, CandidateFinding> }>();
  const key = (signal: DetectorSignal) => scorecardDigest([signal.detectorId, signal.detectorVersion, signal.rawCategory]);
  for (const signal of signals) {
    const id = key(signal); const bucket = buckets.get(id) ?? { detectorId: signal.detectorId, detectorVersion: signal.detectorVersion, family: signal.rawCategory, signalCount: 0, candidates: new Map() };
    bucket.signalCount++; buckets.set(id, bucket);
  }
  for (const candidate of candidates) for (const id of candidate.sourceSignalIds) {
    const signal = bySignal.get(id); if (!signal) throw new Error('scorecard: missing detector provenance');
    buckets.get(key(signal))!.candidates.set(candidate.candidateId, candidate);
  }
  return [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([, bucket]) => {
    const rows = [...bucket.candidates.values()]; const denominator = rows.filter(row => row.state !== 'pending_verification').length;
    const numerator = rows.filter(row => row.state === 'promoted').length;
    return { detectorId: bucket.detectorId, detectorVersion: bucket.detectorVersion, family: bucket.family, signalCount: bucket.signalCount,
      candidateCount: rows.length, adjudicatedPromotionFraction: { numerator, denominator, observed: denominator ? numerator / denominator : null,
        status: denominator ? 'observed_sample_only' as const : 'insufficient_evidence' as const } };
  });
}
export function buildIdentityScorecard(input: Pick<IdentityScorecard, 'query' | 'inputBindings' | 'canonicalCatalogDigest' | 'rows' | 'confirmedGroups' | 'detectorMeasurements'>): IdentityScorecard {
  const rows = [...input.rows].sort((a, b) => a.storyId.localeCompare(b.storyId) || a.recordId.localeCompare(b.recordId));
  if (new Set(rows.map(row => row.recordId)).size !== rows.length) throw new Error('scorecard: duplicate durable record');
  const inputBindings = [...input.inputBindings].sort((a, b) => a.storyId.localeCompare(b.storyId));
  const base = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const, complete: true as const,
    query: { ...input.query, sourceStoryIds: [...new Set(input.query.sourceStoryIds)].sort() }, inputBindings, canonicalCatalogDigest: input.canonicalCatalogDigest,
    inputDigest: scorecardDigest({ inputBindings, canonicalCatalogDigest: input.canonicalCatalogDigest }),
    rows, rowCounts: SCORECARD_KINDS.map(kind => ({ kind, count: rows.filter(row => row.kind === kind).length })),
    confirmedGroups: input.confirmedGroups, detectorMeasurements: input.detectorMeasurements,
    qualification: { enforceEligible: false as const, qualifyingWindow: null, latencyMeasured: false as const, precisionRecallMeasured: false as const,
      jointBatchOperations: null, jointThresholdFulfilled: false as const, jointOwner: 'B-e6d9' as const } };
  const result = identityScorecardSchema.parse({ ...base, digest: scorecardDigest(base) }); assertScorecardConsistency(result); return result;
}
/** Caller supplies a trusted current Store projection. A self-consistent caller
 * digest is not authenticity: equality includes every signed carrier and row. */
export function verifyIdentityScorecard(value: unknown, trustedCurrent: IdentityScorecard): asserts value is IdentityScorecard {
  const parsed = identityScorecardSchema.parse(value); const { digest, ...base } = parsed;
  assertScorecardConsistency(parsed);
  if (scorecardDigest(value) !== scorecardDigest(parsed) || scorecardDigest(base) !== digest
    || scorecardDigest(parsed) !== scorecardDigest(trustedCurrent)) throw new Error('scorecard: incomplete/tampered/stale current projection');
}
