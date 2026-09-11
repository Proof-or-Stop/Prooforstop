/** Per-subject independent gold, called only after the report's exact runtime
 * receipt is covered by a current independent native reviewer PASS. A list of
 * existing record hashes alone is not an adjudication. */
import type { HandlerContext } from './context.js';
import type { JsonValue } from '../core/finding-ledger.js';
import { applicabilityDigest } from '../core/finding-applicability.js';
import { historicalStoryContext, verifiedIdentityCarrier, identityTrust } from './finding-identity-store.js';
import { exactLedgerRecordHash } from './finding-ledger.js';

export interface QualificationSubjectGold {
  ref: { storyId: string; recordId: string; recordHash: string };
  expected: Record<string, string | number | boolean | null>;
  rationale: string;
}
export function qualificationSubjectProjection(kind: string, raw: Record<string, unknown>) {
  const value = (raw.payload && typeof raw.payload === 'object' ? raw.payload : raw) as Record<string, unknown>;
  const fields: Record<string, unknown> = { kind };
  if (kind === 'assessment_proposal') Object.assign(fields, { verdict: value.verdict, owner: value.owner,
    findingId: (value.findingRef as { findingId: string }).findingId });
  else if (kind === 'finding_applicability_assessment') Object.assign(fields, { verdict: value.verdict,
    findingId: value.findingId, dispositionPlan: value.dispositionPlan ?? null, gateImpact: value.gateImpact });
  else if (kind === 'route_receipt') Object.assign(fields, { decision: value.decision, targetStoryId: (value.target as { id: string }).id,
    sourceStoryId: (value.source as { storyId: string }).storyId, sourceRecordId: (value.source as { recordId: string }).recordId, gateEvidence: value.gateEvidence });
  else if (kind === 'candidate_route') Object.assign(fields, { sourceRecordId: (value.source as { recordId: string }).recordId,
    targetStoryId: (value.receipt as { storyId: string }).storyId, gateEvidence: value.gateEvidence });
  else if (kind === 'finding_deferral_disposition') Object.assign(fields, { state: value.state, lineageState: value.lineageState,
    findingId: value.findingId, ownerStoryId: value.ownerStoryId, expiresAt: value.expiresAt, renewalCount: value.renewalCount });
  else if (kind === 'mandatory_repair') Object.assign(fields, { state: value.state, findingId: value.findingId });
  else throw new Error('qualification: subject kind is not in the proposed-subject census');
  if (Object.values(fields).some(value => !['string', 'boolean', 'number'].includes(typeof value) && value !== null)) throw new Error('qualification: incomplete observed subject');
  return fields as QualificationSubjectGold['expected'];
}
export function collectQualificationSubjectAdjudications(ctx: HandlerContext, inputs: QualificationSubjectGold[], adjudicator: string) {
  if (!Array.isArray(inputs)) throw new Error('qualification: per-subject adjudications must be an array');
  const seen = new Set<string>();
  return inputs.map(input => {
    if (!input?.ref || typeof input.rationale !== 'string' || input.rationale.trim().length < 50 || !input.expected
      || typeof input.expected !== 'object' || Array.isArray(input.expected)) throw new Error('qualification: explicit independent per-subject gold and rationale required');
    const key = `${input.ref.storyId}:${input.ref.recordId}`;
    if (seen.has(key)) throw new Error('qualification: duplicate subject adjudication'); seen.add(key);
    const source = historicalStoryContext(ctx, input.ref.storyId);
    const record = verifiedIdentityCarrier(source.store.readFindingLedger<JsonValue>(input.ref.storyId), input.ref.storyId, input.ref.recordId, identityTrust(source)).record;
    if (exactLedgerRecordHash(record) !== input.ref.recordHash) throw new Error('qualification: adjudicated subject substituted');
    const raw = record.payload as Record<string, unknown>;
    const payload = (raw.payload && typeof raw.payload === 'object' ? raw.payload : raw) as Record<string, unknown>;
    let observer = payload.assessedBy;
    if (typeof payload.findingId === 'string') observer = source.store.readFindings(input.ref.storyId).findings.find(row => row.id === payload.findingId)?.agent;
    const routeSource = payload.source as { storyId?: string; recordId?: string } | undefined;
    if (routeSource?.storyId && routeSource.recordId) {
      const origin = historicalStoryContext(ctx, routeSource.storyId);
      const proposal = verifiedIdentityCarrier(origin.store.readFindingLedger<JsonValue>(routeSource.storyId), routeSource.storyId, routeSource.recordId, identityTrust(origin)).record.payload as Record<string, unknown>;
      observer = proposal.assessedBy;
    }
    if (!adjudicator || observer === adjudicator) throw new Error('qualification: subject observer cannot self-adjudicate');
    const observed = qualificationSubjectProjection(record.recordType, record.payload as Record<string, unknown>);
    if (applicabilityDigest(Object.keys(observed).sort()) !== applicabilityDigest(Object.keys(input.expected).sort())) throw new Error('qualification: independent gold omits a subject dimension');
    return { ...input, observed, correct: applicabilityDigest(observed) === applicabilityDigest(input.expected) };
  });
}
