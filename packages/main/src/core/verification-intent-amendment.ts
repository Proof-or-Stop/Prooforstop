import { randomUUID } from 'node:crypto';
import type { ChecklistItem, VerificationIntent } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { signValidationArtifact, verifyValidationArtifacts } from './validation-artifact-signing.js';

const lanes = ['happy', 'edge', 'adversarial'] as const;
interface IntentChangeProvenance {
  id: string; storyId: string; itemId: string; reason: string;
  sessionId: string; leaseId: string; createdAt: string; headHash: string;
  scopeHash: string; beforeHash: string; afterHash: string;
  beforeIntent: VerificationIntent;
  previousSignature: string | null; signature: string;
}
export type IntentAmendment = IntentChangeProvenance & ({
  schema: 'proof-or-stop.intent-amendment.v1'; addition: Partial<VerificationIntent>;
} | {
  schema: 'proof-or-stop.intent-revision.v1'; afterIntent: VerificationIntent;
  beforeScopeHash: string; phase: 'INIT' | 'PLAN'; actor: string;
});

export class IntentAmendmentIntegrityError extends Error {
  constructor(readonly code: string, detail = '') { super(code + (detail ? ': ' + detail : '')); this.name = 'IntentAmendmentIntegrityError'; }
}
export function rethrowIntentAmendmentIntegrityError(error: unknown): void {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.startsWith('AMENDMENT_')) throw error;
}
/** Executor-owned pins are independent of the immutable acceptance semantics. */
export function intentSemantics(intent: VerificationIntent): VerificationIntent {
  return Object.fromEntries(lanes.map(lane => [lane, (intent[lane] ?? []).map(({verification: _pin, ...row}) => row)])) as VerificationIntent;
}
export function acceptanceIntentHash(intent: VerificationIntent): string {
  return digestCanonicalJson(intentSemantics(intent));
}
export function acceptanceScopeHash(item: ChecklistItem): string {
  return digestCanonicalJson({title:item.title,context:item.context,userSees:item.userSees,excludes:item.excludes,files:item.files});
}
export function appendAcceptanceIntents(original: VerificationIntent, addition: Partial<VerificationIntent>): VerificationIntent {
  if (!addition || typeof addition !== 'object' || Array.isArray(addition)
      || Object.keys(addition).some(k => !lanes.includes(k as typeof lanes[number]))) throw new Error('AMENDMENT_INVALID_ADDITION');
  const next = structuredClone(original);
  const ids = new Set(lanes.flatMap(lane => (original[lane] ?? []).map(row => row.id).filter(Boolean)));
  let count = 0;
  for (const lane of lanes) {
    const rows = addition[lane] ?? [];
    if (!Array.isArray(rows)) throw new Error('AMENDMENT_INVALID_LANE');
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Object.keys(row).some(k => !['id','desc','type','priority'].includes(k))) throw new Error('AMENDMENT_CALLER_FACT_REFUSED');
      if (typeof row.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{1,99}$/.test(row.id) || ids.has(row.id)) throw new Error('AMENDMENT_DUPLICATE_OR_INVALID_ID');
      if (typeof row.desc !== 'string' || row.desc.trim().length < 10 || row.priority !== 'must'
          || !['cli','logic','browser'].includes(row.type)) throw new Error('AMENDMENT_MUST_REQUIRE_EXECUTABLE_COVERAGE');
      ids.add(row.id); (next[lane] ??= []).push(structuredClone(row)); count++;
    }
  }
  if (!count) throw new Error('AMENDMENT_EMPTY_ADDITION');
  return next;
}
/** A signed local amendment is provenance, never a PASS or scope expansion grant. */
export function createIntentAmendment(args: {
  item: ChecklistItem; storyId: string; expectedIntentHash: string; reason: string;
  addition: Partial<VerificationIntent>; sessionId: string; leaseId: string; headHash: string; gitCwd: string;
}): {intent: VerificationIntent; amendment: IntentAmendment} {
  if (!args.item.verificationIntent) throw new Error('AMENDMENT_ORIGINAL_INTENT_REQUIRED');
  if (args.expectedIntentHash !== acceptanceIntentHash(args.item.verificationIntent)) throw new Error('AMENDMENT_STALE_INTENT');
  if (typeof args.reason !== 'string' || args.reason.trim().length < 30) throw new Error('AMENDMENT_SUBSTANTIVE_REASON_REQUIRED');
  const intent = appendAcceptanceIntents(args.item.verificationIntent, args.addition);
  const payload = {
    schema:'proof-or-stop.intent-amendment.v1' as const, id:randomUUID(), storyId:args.storyId,itemId:args.item.id,
    reason:args.reason.trim(),sessionId:args.sessionId,leaseId:args.leaseId,createdAt:new Date().toISOString(),headHash:args.headHash,
    scopeHash:acceptanceScopeHash(args.item),beforeHash:args.expectedIntentHash,afterHash:acceptanceIntentHash(intent),
    beforeIntent:intentSemantics(args.item.verificationIntent),addition:structuredClone(args.addition),
    previousSignature:args.item.verificationIntentAmendments?.at(-1)?.signature ?? null,
  };
  return {intent, amendment:{...payload,signature:signValidationArtifact(payload,args.gitCwd)}};
}

/** Called only after checklist_update has enforced its existing phase/role/scope rules. */
export function createIntentRevision(args: {
  before: ChecklistItem; after: ChecklistItem; storyId: string; phase: string;
  reason?: string; actor: string; sessionId: string; leaseId: string; headHash: string; gitCwd: string;
}): IntentAmendment {
  if (args.phase !== 'INIT' && args.phase !== 'PLAN') throw new IntentAmendmentIntegrityError('AMENDMENT_REPLAN_REQUIRED', 'return through the authorized INIT/PLAN workflow before revising signed acceptance');
  if (!args.reason || args.reason.trim().length < 30) throw new IntentAmendmentIntegrityError('AMENDMENT_REVISION_REASON_REQUIRED', 'provide reason with at least 30 characters');
  if (!args.before.verificationIntent || !args.after.verificationIntent) throw new IntentAmendmentIntegrityError('AMENDMENT_REVISION_INTENT_REQUIRED');
  assertIntentAmendments(args.before,args.storyId,args.gitCwd);
  const payload = {
    schema:'proof-or-stop.intent-revision.v1' as const, id:randomUUID(), storyId:args.storyId,itemId:args.before.id,
    reason:args.reason.trim(),sessionId:args.sessionId,leaseId:args.leaseId,createdAt:new Date().toISOString(),headHash:args.headHash,
    actor:args.actor,phase:args.phase as 'INIT' | 'PLAN',beforeScopeHash:acceptanceScopeHash(args.before),scopeHash:acceptanceScopeHash(args.after),
    beforeHash:acceptanceIntentHash(args.before.verificationIntent),afterHash:acceptanceIntentHash(args.after.verificationIntent),
    beforeIntent:intentSemantics(args.before.verificationIntent),afterIntent:intentSemantics(args.after.verificationIntent),
    previousSignature:args.before.verificationIntentAmendments?.at(-1)?.signature ?? null,
  };
  return {...payload,signature:signValidationArtifact(payload,args.gitCwd)};
}
/** Every canonical checklist read/write validates the chain before gates consume it. */
export function assertIntentAmendments(item: ChecklistItem, storyId: string, gitCwd: string): void {
  assertIntentAmendmentItems([item],storyId,gitCwd);
}
/** Batch key resolution only; every signature, predecessor and current binding
 * is still checked. There is no trusted-result input or cross-call cache. */
export function assertIntentAmendmentItems(items:ReadonlyArray<ChecklistItem>,storyId:string,gitCwd:string):void {
  const envelopes=items.flatMap(item=>{
    const rows=item.verificationIntentAmendments;
    if(rows===undefined)return [];
    if(!Array.isArray(rows)||!rows.length||!item.verificationIntent||rows.some(record=>!record||typeof record!=='object'))throw new IntentAmendmentIntegrityError('AMENDMENT_INVALID_CHAIN');
    return rows.map(({signature,...value})=>({value,signature}));
  });
  const verified=verifyValidationArtifacts(envelopes,gitCwd);let signatureIndex=0;
  for(const item of items){
  if (item.verificationIntentAmendments === undefined) continue;
  const rows = item.verificationIntentAmendments;
  if (!Array.isArray(rows) || !rows.length || !item.verificationIntent) throw new IntentAmendmentIntegrityError('AMENDMENT_INVALID_CHAIN');
  let previous: IntentAmendment | undefined;
  for (const record of rows) {
    if (!record || typeof record !== 'object') throw new IntentAmendmentIntegrityError('AMENDMENT_INVALID_CHAIN');
    const {signature,...payload} = record;
    if (!['proof-or-stop.intent-amendment.v1','proof-or-stop.intent-revision.v1'].includes(record.schema) || record.storyId !== storyId || record.itemId !== item.id
        || !verified[signatureIndex++]
        || record.previousSignature !== (previous?.signature ?? null)
        || (previous && record.beforeHash !== previous.afterHash)
        || record.beforeHash !== acceptanceIntentHash(record.beforeIntent)) throw new IntentAmendmentIntegrityError('AMENDMENT_INVALID_SIGNATURE_OR_BINDING');
    if (record.schema === 'proof-or-stop.intent-amendment.v1') {
      if ((previous && record.scopeHash !== previous.scopeHash) || record.afterHash !== acceptanceIntentHash(appendAcceptanceIntents(record.beforeIntent,record.addition))) throw new IntentAmendmentIntegrityError('AMENDMENT_INVALID_APPEND');
    } else if (!previous || !['INIT','PLAN'].includes(record.phase) || !record.actor || record.reason.trim().length < 30
      || record.beforeScopeHash !== previous.scopeHash || record.afterHash !== acceptanceIntentHash(record.afterIntent)) throw new IntentAmendmentIntegrityError('AMENDMENT_INVALID_REVISION');
    previous=record;
  }
  if (previous!.scopeHash !== acceptanceScopeHash(item) || previous!.afterHash !== acceptanceIntentHash(item.verificationIntent)) throw new IntentAmendmentIntegrityError('AMENDMENT_CURRENT_INTENT_MISMATCH');
  }
}
