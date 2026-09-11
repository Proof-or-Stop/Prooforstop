/** Target-owned IO for non-gate route consent and semantic progress. */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { canonicalDigest } from '../core/authority-signing.js';
import { loadConfig } from '../core/config.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { getSessionIdentity } from '../core/owner-session.js';
import { readOwnerLease, isLeaseStale } from '../core/story-owner-lease.js';
import { readBrandEnv } from '../core/brand-env.js';
import { isTrustedHostActor, AGENT_DISPATCH_REGISTRY } from '../core/agent-dispatch-registry.js';
import { currentStoryFilesHash } from '../core/evidence-freshness.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import { verifyCausalEvidenceReceipt } from '../core/causal-evidence.js';
import { recomputeDeliveryCheckHash } from '../core/delivery-check-hash.js';
import { PROOF_OR_STOP_STORY_DIR_NAMES, LEGACY_DOCS_STORY_DIR } from '../core/proof-or-stop-paths.js';
import { identityHash, parseIdentityInput, validateCanonicalDefect, signIdentityEnvelope, verifyIdentityEnvelope } from '../core/finding-identity.js';
import { routeRequestSchema, routeRevokeSchema, routeVerifySchema, candidateRouteRequestSchema, validateRouteReceipt, sealRouteReceipt,
  receiptSubjectDigest, assertReceiptCurrent, validateCandidateRoute, assertCanonicalSubject,
  type RouteReceipt, type RouteSource, type TargetSnapshot, type RouteSubject, type IdentityLedgerRef } from '../core/finding-route.js';
import { PROGRESS_KINDS, validateBaseline, validateBaselineSet, validateProgress, progressCaptureSchema, absenceDigest, semanticProjection,
  assertProgressTransition, targetEvidenceSchema, type ProgressProjection, type ProgressBaseline, type BaselineSet, type ProgressBinding } from '../core/finding-progress.js';
import { progressPredecessorRequestSchema, validateProgressPredecessor, type ProgressPredecessor } from '../core/finding-progress.js';
import { identityStoryContext, identityTrust, identitySourceSnapshot, readIdentityRows, verifiedIdentityCarrier, verifiedFindingRef,
  withIdentityLedgerLocks, appendIdentityTransaction, readCanonicalCatalog, type VerifiedIdentityRow } from './finding-identity-store.js';
import { canonicalCurrent } from '../core/finding-history.js';
import { assertIdentityAnchorsCurrent, currentFindingIdentityResolver } from './finding-identity-store.js';
import { readCandidates } from './finding-identity.js';
import { verifyAssessmentProposal, exactLedgerRecordHash } from './finding-ledger.js';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import type { CanonicalDefect, IdentitySemanticEnvelope } from '../core/finding-identity-types.js';
import type { JsonValue } from '../core/finding-ledger.js';

const VERSION = 'story2-target-route-v1';
export const ROUTE_POLICY = { version: VERSION, acceptedPhases: ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST'],
  maxConsentMs: 30 * 24 * 60 * 60 * 1000, statusOrder: ['pending', 'in_progress', 'done'], gateEvidence: false } as const;
export function proposalAuthorityDigest(actor: string): string {
  const entry = AGENT_DISPATCH_REGISTRY.find(row => row.canonicalName === actor && row.reviewerLane);
  if (!entry) throw new Error('route: proposal signer is not an eligible reviewer');
  return canonicalDigest({ profile: 'story2-current-proposal-authority-v1', entry });
}
export function proposalScopeDigest(ctx: HandlerContext, storyId: string): string {
  return canonicalDigest({ scope: ctx.store.readScopeContract(storyId), checklist: ctx.store.readChecklist(storyId).items.map(scopeItem) });
}
export function proposalFindingHash(ctx: HandlerContext, ref: import('../core/finding-identity-types.js').FindingIdentityRef): string {
  return canonicalDigest(verifiedFindingRef(ctx, ref).finding);
}
/** Exact signed durable references, not a claim of Story3B runtime validity. */
export function routeRuntimeReferences(ctx: HandlerContext, storyId: string): IdentityLedgerRef[] {
  const ledger = ctx.store.readFindingLedger<JsonValue>(storyId);
  return ledger.records.filter(row => row.recordType === 'runtime_evidence_receipt').map(row => {
    verifiedIdentityCarrier(ledger, storyId, row.recordId, identityTrust(ctx));
    return { storyId, recordId: row.recordId, recordHash: exactLedgerRecordHash(row) };
  }).sort((a, b) => a.recordId.localeCompare(b.recordId));
}
export function routeRelevantSourceDigest(ctx: HandlerContext, paths: readonly string[]): string {
  return identityHash(paths.map(path => {
    const full = resolve(ctx.root, path); const rel = relative(realpathSync(ctx.root), existsSync(full) ? realpathSync(full) : full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('history: relevant source path escapes workspace');
    return { path, digest: existsSync(full) ? createHash('sha256').update(readFileSync(full)).digest('hex') : 'absent' };
  }));
}
function validator(ctx: HandlerContext) {
  return (kind: string, value: unknown) => {
    if (kind === 'route_receipt') validateRouteReceipt(value);
    else if (kind === 'candidate_route') validateCandidateRoute(value);
    else if (kind === 'progress_baseline') validateBaseline(value);
    else if (kind === 'progress_baseline_set') validateBaselineSet(value, identityTrust(ctx));
    else if (kind === 'progress_evidence') validateProgress(value, identityTrust(ctx));
    else if (kind === 'progress_predecessor') validateProgressPredecessor(value);
    else throw new Error(`route: unsupported semantic kind ${kind}`);
  };
}
export function exactSemanticRef(ctx: HandlerContext, ref: IdentityLedgerRef, kind: string): VerifiedIdentityRow<object> {
  const rows = readIdentityRows(ctx, ref.storyId, [kind], validator(ctx));
  const row = rows.find(row => row.record.recordId === ref.recordId);
  if (!row || exactLedgerRecordHash(row.record) !== ref.recordHash) throw new Error('route: missing/substituted signed record');
  return row;
}
export function sourceRouteRecord(ctx: HandlerContext, source: RouteSource, requireCurrentReviewerEvidence = true) {
  const ledger = ctx.store.readFindingLedger<JsonValue>(source.storyId);
  const bound = verifiedIdentityCarrier(ledger, source.storyId, source.recordId, identityTrust(ctx));
  if (exactLedgerRecordHash(bound.record) !== source.recordHash) throw new Error('route: source record hash mismatch');
  if (source.subjectKind === 'candidate_finding') {
    const row = readCandidates(ctx, source.storyId).candidates.find(row => row.record.recordId === source.recordId);
    if (!row || row.envelope.payload.candidateId !== source.subjectId || row.envelope.payload.currentProjectionHash !== source.subjectHash
      || row.envelope.payload.state !== 'pending_verification') throw new Error('route: candidate source moved or substituted');
    assertIdentityAnchorsCurrent(ctx, row.envelope.payload.sourceBindings);
    return { bound, candidate: row.envelope.payload };
  }
  const proposal = bound.record.payload as Record<string, unknown>;
  if (bound.record.recordType !== 'assessment_proposal' || proposal.proposalId !== source.subjectId || proposal.proposalDigest !== source.subjectHash) throw new Error('route: proposal source mismatch');
  const actor = String(proposal.assessedBy); const trust = identityTrust(ctx); const snapshot = identitySourceSnapshot(ctx);
  const ref = proposal.findingRef as { storyId: string; findingId: string; recordId: string };
  const findingRecord = ledger.records.find(row => row.recordId === ref.recordId);
  if (!findingRecord || ref.storyId !== source.storyId) throw new Error('route: proposal Finding subject missing');
  const currentFinding = currentFindingIdentityResolver(ctx)({ ...ref, recordHash: exactLedgerRecordHash(findingRecord) });
  if (currentFinding.recordId !== ref.recordId) throw new Error('route: source Finding superseded; bind exact current successor');
  const currentFindingHash = proposalFindingHash(ctx, { ...ref, recordHash: exactLedgerRecordHash(findingRecord) });
  if (requireCurrentReviewerEvidence) {
    const reviewerState = collectReviewerEvidenceState(ctx.store, source.storyId, ctx.root);
    if (!reviewerState.valid.some(row => row.kind === 'finding' && row.id === ref.findingId && row.agent === actor && row.reviewRunId === proposal.reviewRunId)) throw new Error('route: proposal reviewer evidence not current/eligible');
  }
  const result = verifyAssessmentProposal(proposal, { publicKey: trust.publicKey, expectedAuthorityDigest: proposalAuthorityDigest(actor),
    expectedFindingHash: currentFindingHash, expectedHeadHash: snapshot.headHash, expectedMaterialHash: snapshot.materialHash,
    expectedStoryFilesHash: currentStoryFilesHash(ctx.root, 'HEAD', ctx.root), receipt: bound.receipt, receiptTrust: trust,
    proposalRecord: bound.record, requireReceipt: true, receiptIsCurrent: true });
  if (!result.valid || Date.parse(String(proposal.issuedAt)) > Date.now() || proposal.scopeDigest !== proposalScopeDigest(ctx, source.storyId)) throw new Error(`route: invalid proposal ${result.rejection ?? 'scope/future issuance'}`);
  return { bound, proposal };
}
function targetItem(ctx: HandlerContext, storyId: string, itemId: string) {
  const item = ctx.store.readChecklist(storyId).items.find(row => row.id === itemId);
  if (!item || !['pending', 'in_progress', 'done'].includes(item.status)) throw new Error('route: target responsibility missing/invalid');
  return item;
}
function scopeItem(item: ReturnType<typeof targetItem>) {
  return { id: item.id, title: item.title, context: item.context, files: item.files ?? {}, verificationIntent: item.verificationIntent ?? {} };
}
export function targetRouteSnapshot(ctx: HandlerContext, storyId: string, itemId: string, requireActor = false, allowCompleted = false): TargetSnapshot {
  const story = ctx.store.readStory(storyId); const item = targetItem(ctx, storyId, itemId); const meta = storyId.startsWith('B-META-');
  if (!(ROUTE_POLICY.acceptedPhases as readonly string[]).includes(story.phase)) throw new Error('route: target closed');
  if (item.status === 'done' && !allowCompleted) throw new Error('route: target responsibility closed');
  const lease = readOwnerLease(ctx.store.storyDirPath(storyId));
  if (!meta && (!lease || isLeaseStale(lease))) throw new Error('route: target owner lease missing/stale');
  const identity = getSessionIdentity();
  if (requireActor) {
    assertCwdInWorktree(ctx.store, storyId);
    if (realpathSync(process.cwd()) !== realpathSync(ctx.root) || (!meta && identity.sessionId !== lease!.sessionId)) throw new Error('route: target owner/cwd authority required');
    if (!isTrustedHostActor(readBrandEnv('AGENT') || 'main')) throw new Error('route: target owner command-policy actor required');
  }
  const scope = ctx.store.readScopeContract(storyId);
  const { headHash, materialHash } = identitySourceSnapshot(ctx);
  const storyFilesHash = currentStoryFilesHash(ctx.root, 'HEAD', ctx.root);
  if (!storyFilesHash) throw new Error('route: target source snapshot missing');
  return { kind: meta ? 'b_meta_gap' : 'existing_story', id: storyId, state: meta ? 'audit_open' : ['INIT', 'INIT_CHECK', 'PLAN'].includes(story.phase) ? 'planned' : 'active',
    scopeDigest: canonicalDigest({ scope, item: scopeItem(item) }), headHash, materialHash, storyFilesHash,
    responsibility: { workItemRef: item.id, workItemHash: canonicalDigest(item), state: item.status as 'pending' | 'in_progress' | 'done' }, stateDigest: canonicalDigest({ phase: story.phase, itemStatus: item.status }),
    owner: { identity: meta ? `canonical-main:${ctx.root}` : lease!.sessionId, authority: meta ? 'b_meta_canonical_audit' : 'target_story_owner', leaseId: meta ? 'canonical-main-write-policy' : lease!.sessionId,
      leaseDigest: canonicalDigest(meta ? { root: ctx.root, policy: VERSION } : { sessionId: lease!.sessionId, acquiredAt: lease!.acquiredAt, cwd: lease!.cwd }), authorityPolicyVersion: VERSION },
    policyDigest: canonicalDigest({ route: ROUTE_POLICY, command: COMMAND_POLICIES.finding_route_accept, phaseTools: loadConfig(ctx.root).phaseTools ?? null }) };
}
function optionalArtifact<T>(ctx: HandlerContext, storyId: string, file: string, read: () => T | null): T | null {
  const value = read();
  const roots = [loadConfig(ctx.root).storyDir, LEGACY_DOCS_STORY_DIR, ...PROOF_OR_STOP_STORY_DIR_NAMES];
  if (value === null && roots.some(root => existsSync(join(ctx.root, root, storyId, file)))) throw new Error(`progress: corrupt/untrusted optional ${file}`);
  return value;
}
function assertSubject(ctx: HandlerContext, storyId: string, itemId: string, subject: RouteSubject): void {
  assertCanonicalSubject(subject);
  if (subject.targetChecklistItemRefs.length !== 1 || subject.targetChecklistItemRefs[0] !== itemId || subject.targetAcceptanceRefs.length) throw new Error('route: exact checklist subject required');
  const item = targetItem(ctx, storyId, itemId); const declared = Object.values(item.files ?? {}).flat();
  for (const path of subject.sourcePaths) {
    if (!declared.includes(path) || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('route: source outside target responsibility');
  }
  // Contract IDs are explicit target checklist intent references, not arbitrary source claims.
  const refs = Object.entries(item.verificationIntent ?? {}).flatMap(([kind, rows]) => Array.isArray(rows) ? rows.map((_, index) => `${itemId}:${kind}:${index}`) : []);
  if (subject.affectedContractRefs.some(ref => !refs.includes(ref))) throw new Error('route: contract outside target responsibility');
}
function currentProjection(ctx: HandlerContext, receipt: Pick<RouteReceipt, 'target' | 'subject' | 'canonicalDefect'>,
  kind: typeof PROGRESS_KINDS[number], canonicalDefectId: string, executionKey?: string, initial = false): ProgressProjection | null {
  const subject = receipt.subject; const storyId = receipt.target.id; const item = targetItem(ctx, storyId, receipt.target.responsibility.workItemRef);
  if (kind === 'target_source_change') {
    if (!subject.sourcePaths.length) return null;
    const paths = subject.sourcePaths.map(path => {
      const full = resolve(ctx.root, path); if (!existsSync(full)) return { path, absent: true };
      const rel = relative(realpathSync(ctx.root), realpathSync(full)); if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('progress: escaped source realpath');
      return { path, digest: createHash('sha256').update(readFileSync(full)).digest('hex') };
    });
    if (paths.every(row => row.absent)) return null;
    return { kind, affectedContractRefs: subject.affectedContractRefs, sourcePaths: subject.sourcePaths, relevantSourceDigest: identityHash(paths) };
  }
  if (kind === 'target_test_result') {
    if (!subject.command) return null;
    if (!executionKey) {
      optionalArtifact(ctx, storyId, 'test-evidence.json', () => ctx.store.readTestEvidence(storyId));
      executionKey = item.verificationEvidence?.filter(row => subject.affectedContractRefs.includes(row.intentRef) && row.mechanical && row.receipt?.executionKey).at(-1)?.receipt?.executionKey;
      if (!executionKey) return null;
    }
    const evidence = ctx.store.readCausalEvidenceReceipt(storyId, executionKey);
    const command = { executable: subject.command.executable, args: subject.command.args, shell: false };
    const marker = `defect-progress:${canonicalDefectId}:${item.id}`;
    if (!evidence || !verifyCausalEvidenceReceipt(evidence, executionKey) || !evidence.reusable || evidence.storyId !== storyId
      || realpathSync(evidence.identity.cwd) !== realpathSync(ctx.root) || canonicalDigest(evidence.identity.command) !== canonicalDigest(command)
      || !evidence.outputProbe.split(/\r?\n/).includes(marker) || !evidence.outputProbe.includes(subject.command.selector)
      || (evidence.identity.inputs as Record<string, unknown>)?.materialHash !== identitySourceSnapshot(ctx).materialHash
      || evidence.identity.storyFilesHash !== currentStoryFilesHash(ctx.root, 'HEAD', ctx.root)) throw new Error('progress: invalid current defect-bound execution');
    return { kind, commandDigest: canonicalDigest(command), selectorDigest: identityHash(subject.command.selector), outcome: evidence.status === 'pass' && evidence.exitCode === 0 ? 'pass' : 'fail', executionKey, receiptHash: evidence.receiptHash };
  }
  if (kind === 'target_delivery_state') {
    const evidence = optionalArtifact(ctx, storyId, 'delivery-check.json', () => ctx.store.readDeliveryCheck(storyId));
    if (!evidence) return null;
    if (evidence.storyId !== storyId || evidence._hash !== recomputeDeliveryCheckHash(storyId, ctx.store)
      || evidence.materialHash !== identitySourceSnapshot(ctx).materialHash) throw new Error('progress: invalid delivery integrity/freshness');
    // SHA here is integrity only. Target-owned Ed25519 capture below supplies authority.
    if (item.status !== 'done') throw new Error('progress: delivery target item not completed');
    return { kind, itemId: item.id, signedState: item.status, stateEvidenceHash: canonicalDigest(evidence) };
  }
  if (initial) return null; // No signed defect-bound transition exists yet; initial work-item state is separately signed in targetSnapshot.
  return { kind, itemId: item.id, state: item.status as 'pending' | 'in_progress' | 'done', transitionPolicyDigest: canonicalDigest(ROUTE_POLICY.statusOrder) };
}
function routeRows(ctx: HandlerContext, storyId: string): VerifiedIdentityRow<RouteReceipt>[] {
  return readIdentityRows<RouteReceipt>(ctx, storyId, ['route_receipt'], validator(ctx));
}
function exactReceipt(ctx: HandlerContext, ref: IdentityLedgerRef, latest = true): VerifiedIdentityRow<RouteReceipt> {
  const row = exactSemanticRef(ctx, ref, 'route_receipt') as VerifiedIdentityRow<RouteReceipt>;
  if (latest && routeRows(ctx, ref.storyId).some(other => other.envelope.payload.supersedesRouteReceiptId === row.envelope.payload.routeReceiptId)) throw new Error('route: receipt superseded');
  return row;
}
function baselineSetForReceipt(ctx: HandlerContext, receipt: RouteReceipt): VerifiedIdentityRow<BaselineSet> {
  if (!receipt.initialProgressBaselineSet) throw new Error('progress: initial baseline reference missing');
  const rows = readIdentityRows<BaselineSet>(ctx, receipt.target.id, ['progress_baseline_set'], validator(ctx));
  const row = rows.find(row => row.envelope.payload.baselineSetId === receipt.initialProgressBaselineSet!.baselineSetId);
  if (!row || row.envelope.payload.baselineSetHash !== receipt.initialProgressBaselineSet.baselineSetHash
    || row.envelope.payload.capturedAt !== receipt.acceptedAt
    || row.envelope.payload.routeReceiptId !== receipt.routeReceiptId || row.envelope.payload.routeSubjectDigest !== receipt.routeSubjectDigest
    || identityHash(row.envelope.payload.targetSnapshot) !== identityHash(receipt.target) || identityHash(row.envelope.payload.subject) !== identityHash(receipt.subject)
    || row.envelope.payload.signedBy !== receipt.signedBy || row.envelope.payload.signedByAuthority !== receipt.signedByAuthority) throw new Error('progress: exact initial baseline set missing');
  // Verify each embedded entry is also an exact member of the same atomic transaction.
  const entries = readIdentityRows<ProgressBaseline>(ctx, receipt.target.id, ['progress_baseline'], validator(ctx));
  for (const envelope of row.envelope.payload.baselines) {
    const entry = entries.find(entry => identityHash(entry.envelope) === identityHash(envelope));
    if (!entry || entry.receipt.receiptId !== row.receipt.receiptId) throw new Error('progress: partial baseline publication');
  }
  const receiptRow = routeRows(ctx, receipt.target.id).find(row => row.envelope.payload.routeReceiptId === receipt.routeReceiptId);
  if (!receiptRow || receiptRow.receipt.receiptId !== row.receipt.receiptId) throw new Error('progress: receipt/baseline transaction mismatch');
  return row;
}
function canonicalForRoute(ctx: HandlerContext, ref: IdentityLedgerRef, sourceFindingId?: string): CanonicalDefect {
  const catalog = readCanonicalCatalog(ctx);
  const currentFinding = currentFindingIdentityResolver(ctx);
  const row = catalog.rows.find(row => row.envelope.storyId === ref.storyId && row.record.recordId === ref.recordId && exactLedgerRecordHash(row.record) === ref.recordHash);
  if (!row || (sourceFindingId && !row.envelope.payload.memberFindingRefs.some(member => currentFinding(member).recordId === sourceFindingId))) throw new Error('route: canonical defect source mismatch');
  if (canonicalCurrent(catalog.input, ref.recordId).superseded) throw new Error('route: canonical defect superseded; bind exact current successor');
  return row.envelope.payload;
}
function progressBase(receipt: RouteReceipt, canonicalDefectId: string, target: TargetSnapshot, capturedAt: string) {
  return { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const,
    canonicalDefectId, routeReceiptId: receipt.routeReceiptId, routeSubjectDigest: receipt.routeSubjectDigest, subject: receipt.subject,
    targetSnapshot: target, capturedAt, derivedBy: { producer: 'cli' as const, producerVersion: VERSION, commandOrHandlerDigest: canonicalDigest({ policy: ROUTE_POLICY, handler: 'finding-route' }) },
    signedBy: target.owner.identity, signedByAuthority: target.owner.authority };
}
function receiptOwnerStillValid(old: RouteReceipt, current: TargetSnapshot): void {
  if (old.decision !== 'accepted' || old.revokedAt || Date.now() >= Date.parse(old.expiresAt)
    || old.target.id !== current.id || old.target.scopeDigest !== current.scopeDigest || identityHash(old.target.owner) !== identityHash(current.owner)
    || old.policyDigest !== current.policyDigest) throw new Error('progress: predecessor consent/owner/scope/policy invalid');
}
/** Public read-only Story 2 query for the exact acceptance/baseline/progress tuple.
 * The consumer supplies its own prior record; a neutral predecessor is not proof
 * that the record is a deferral. This function does not make a gate decision. */
export function readFindingRouteProgressProof(ctx: HandlerContext, ref: IdentityLedgerRef, priorSource?: IdentityLedgerRef) {
  const target = identityStoryContext(ctx, ref.storyId);
  const row = exactReceipt(target, ref); const receipt = row.envelope.payload;
  const current = targetRouteSnapshot(target, ref.storyId, receipt.target.responsibility.workItemRef);
  assertReceiptCurrent(receipt, current);
  if (receipt.evidenceAuthority.profile !== 'finding_route' || receipt.decision !== 'accepted' || !receipt.canonicalDefect) throw new Error('progress: accepted Finding route required');
  const canonical = canonicalForRoute(ctx, receipt.canonicalDefect);
  let initial = receipt; const visited = new Set<string>();
  while (initial.predecessor) {
    if (visited.has(initial.routeReceiptId)) throw new Error('progress: cyclic receipt lineage');
    visited.add(initial.routeReceiptId);
    initial = exactReceipt(target, initial.predecessor, false).envelope.payload;
    if (initial.target.id !== receipt.target.id || identityHash(initial.subject) !== identityHash(receipt.subject)
      || identityHash(initial.canonicalDefect) !== identityHash(receipt.canonicalDefect)) throw new Error('progress: initial subject changed');
  }
  const baseline = baselineSetForReceipt(target, initial);
  let progress: ProgressBinding | undefined;
  if (priorSource) {
    if (!receipt.progress || !receipt.predecessor) throw new Error('progress: renewal requires new target acceptance and typed progress');
    progress = exactSemanticRef(target, receipt.progress, 'progress_evidence').envelope.payload as ProgressBinding;
    const source = identityStoryContext(ctx, priorSource.storyId);
    const predecessor = exactSemanticRef(source, progress.previousDeferralRef, 'progress_predecessor').envelope.payload as ProgressPredecessor;
    if (identityHash(predecessor.sourceRecord) !== identityHash(priorSource)
      || progress.canonicalDefectId !== canonical.canonicalDefectId
      || predecessor.baselineSetRef.recordId !== baseline.record.recordId
      || predecessor.baselineSetRef.recordHash !== exactLedgerRecordHash(baseline.record)
      || identityHash(progress.targetSnapshot) !== identityHash(current)) throw new Error('progress: exact prior deferral/baseline/current-target mismatch');
    const before = baseline.envelope.payload.baselines.find(entry => (entry.payload as ProgressBaseline).kind === progress!.kind)?.payload as ProgressBaseline | undefined;
    if (!before) throw new Error('progress: same-kind initial baseline missing');
    assertProgressTransition(before, progress);
    const projection = currentProjection(target, receipt, progress.kind, canonical.canonicalDefectId,
      progress.projection.kind === 'target_test_result' ? progress.projection.executionKey : undefined);
    if (identityHash(projection) !== identityHash(progress.projection)) throw new Error('progress: target projection changed after capture');
  } else if (receipt.predecessor) throw new Error('progress: renewed route cannot reset deferral lineage');
  return { receipt, receiptRecord: row.record, baseline: baseline.envelope.payload, baselineRecord: baseline.record, progress, canonicalDefect: canonical,
    authority: 'non_authoritative' as const, gateEvidence: false as const };
}
export function createFindingRouteHandlers(ctx: HandlerContext) {
  function acceptOrReject(input: unknown, decision: 'accepted' | 'rejected') {
    const args = parseIdentityInput(routeRequestSchema, input);
    if ((args.predecessor && args.predecessor.storyId !== args.storyId) || (args.progress && args.progress.storyId !== args.storyId)) throw new Error('route: target ledger reference mismatch');
    const target = identityStoryContext(ctx, args.storyId); const source = identityStoryContext(ctx, args.source.storyId);
    targetRouteSnapshot(target, args.storyId, args.targetItemId, true);
    const contexts = [{ ctx: target, storyId: args.storyId }, { ctx: source, storyId: args.source.storyId }];
    if (args.canonicalDefect) contexts.push({ ctx: identityStoryContext(ctx, args.canonicalDefect.storyId), storyId: args.canonicalDefect.storyId });
    return withIdentityLedgerLocks(contexts, () => appendIdentityTransaction(target, { ...args, operation: 'append_route_receipt', request: { ...args, decision }, validate: validator(target), prepare: (_ledger, signer, signing) => {
      const snapshot = targetRouteSnapshot(target, args.storyId, args.targetItemId, true); assertSubject(target, args.storyId, args.targetItemId, args.subject);
      const sourceRow = sourceRouteRecord(source, args.source);
      const targetStory = target.store.readStory(args.storyId);
      const sourceFinding = sourceRow.proposal ? source.store.readFindings(args.source.storyId, { strictMirror: true }).findings.find(row => row.recordId === (sourceRow.proposal!.findingRef as { recordId: string }).recordId) : undefined;
      const sourceOriginPaths = [...new Set(sourceFinding?.files ?? sourceRow.candidate?.sourceBindings.map(anchor => anchor.path) ?? [])].sort();
      const recallBindings = { schemaVersion: 1 as const, ...(targetStory.createdAt ? { targetCreatedAt: targetStory.createdAt } : {}),
        ...(targetStory.startedAt ? { targetStartedAt: targetStory.startedAt } : {}), targetPhase: targetStory.phase,
        ...(sourceFinding ? { sourceSeverity: sourceFinding.severity } : {}), sourcePathsDigest: routeRelevantSourceDigest(target, args.subject.sourcePaths),
        sourceOriginPaths, sourceOriginDigest: routeRelevantSourceDigest(source, sourceOriginPaths),
        runtimeReferenceAuthority: 'persistence_only' as const, runtimeRefs: routeRuntimeReferences(target, args.storyId) };
      const profile = args.source.subjectKind === 'candidate_finding' ? 'candidate_route' as const : 'finding_route' as const;
      if (args.source.storyId === args.storyId) throw new Error('route: cyclic self forwarding');
      const now = signing.producedAt; const expiry = Date.parse(args.expiresAt);
      if (expiry <= Date.parse(now) || expiry > Date.parse(now) + ROUTE_POLICY.maxConsentMs) throw new Error('route: finite future expiry required');
      const previous = args.predecessor ? exactReceipt(target, args.predecessor) : undefined;
      if (previous && (previous.envelope.payload.target.id !== args.storyId || identityHash(previous.envelope.payload.source) !== identityHash(args.source))) throw new Error('route: predecessor subject mismatch');
      if (!previous && routeRows(target, args.storyId).some(row => identityHash(row.envelope.payload.source) === identityHash(args.source))) throw new Error('route: existing receipt chain requires exact predecessor');
      const ancestorRoutes = readIdentityRows(source, args.source.storyId, ['candidate_route'], validator(source)).filter(row =>
        (row.envelope.payload as { source: RouteSource }).source.subjectId === args.source.subjectId);
      const visited = [...new Set([identityHash(args.source.storyId), ...ancestorRoutes.flatMap(row => (row.envelope.payload as { visitedTargetDigests: string[] }).visitedTargetDigests)])];
      const targetDigest = identityHash(args.storyId); if (visited.includes(targetDigest)) throw new Error('route: forwarding cycle'); visited.push(targetDigest);
      const base = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const,
        evidenceAuthority: { profile, authority: 'target_route_semantic_only' as const, gateEvidence: false as const }, routeReceiptId: `route:${randomUUID()}`,
        source: args.source, target: snapshot, subject: args.subject, decision, ...(decision === 'accepted' ? { acceptedAt: now } : { rejectedAt: now }),
        expiresAt: args.expiresAt, ...(previous ? { predecessor: args.predecessor!, supersedesRouteReceiptId: previous.envelope.payload.routeReceiptId } : {}),
        ...(args.canonicalDefect ? { canonicalDefect: args.canonicalDefect } : {}), visitedTargetDigests: visited,
        routeChainDigest: identityHash({ predecessor: previous?.envelope.payload.routeChainDigest ?? 'root', source: args.source, target: snapshot.id, visited }),
        policyDigest: snapshot.policyDigest, signedBy: snapshot.owner.identity, signedByAuthority: snapshot.owner.authority, recallBindings };
      const draft = { ...base, routeSubjectDigest: receiptSubjectDigest(base) };
      const records: { kind: string; payload: object }[] = [];
      let initialProgressBaselineSet: RouteReceipt['initialProgressBaselineSet'];
      if (profile === 'finding_route' && decision === 'accepted') {
        if (!args.canonicalDefect) throw new Error('route: canonical defect required');
        const findingRef = sourceRow.proposal!.findingRef as { recordId: string };
        const canonical = canonicalForRoute(ctx, args.canonicalDefect, findingRef.recordId);
        if (!previous) {
          const capture = progressBase(draft as RouteReceipt, canonical.canonicalDefectId, snapshot, now);
          const envelopes = PROGRESS_KINDS.map(kind => {
            const projection = currentProjection(target, draft, kind, canonical.canonicalDefectId, undefined, true);
            const core = { ...capture, kind, evidenceAuthority: { profile: 'progress_baseline' as const, authority: 'target_route_semantic_only' as const, gateEvidence: false as const },
              ...(projection ? { projectionState: 'present' as const, projection, projectionDigest: identityHash(semanticProjection(projection)) }
                : { projectionState: 'absent' as const, absenceDigest: absenceDigest({ ...capture, kind }) }) };
            const baseline = { ...core, baselineHash: identityHash(core) }; validateBaseline(baseline);
            records.push({ kind: 'progress_baseline', payload: baseline });
            return signIdentityEnvelope({ kind: 'progress_baseline', storyId: args.storyId, requestDigest: signing.requestDigest, producedAt: now, payload: baseline }, signer, validateBaseline);
          });
          const setBase = { ...capture, evidenceAuthority: { profile: 'progress_baseline' as const, authority: 'target_route_semantic_only' as const, gateEvidence: false as const }, baselineSetId: `baseline-set:${randomUUID()}`, baselines: envelopes };
          const set = { ...setBase, baselineSetHash: identityHash(setBase) };
          validateBaselineSet(set, identityTrust(target)); records.push({ kind: 'progress_baseline_set', payload: set });
          initialProgressBaselineSet = { baselineSetId: set.baselineSetId, baselineSetHash: set.baselineSetHash };
        } else {
          if (!args.progress) throw new Error('route: finding renewal requires target progress');
          const progress = exactSemanticRef(target, args.progress, 'progress_evidence').envelope.payload as unknown as ProgressBinding;
          if (progress.targetSnapshot.id !== args.storyId || identityHash(progress.targetSnapshot) !== identityHash(snapshot)
            || progress.routeReceiptId !== previous.envelope.payload.routeReceiptId || progress.canonicalDefectId !== canonical.canonicalDefectId) throw new Error('route: renewal progress current subject mismatch');
        }
      }
      if (profile === 'candidate_route' && (args.canonicalDefect || args.progress)) throw new Error('route: candidate baseline/progress forbidden');
      const receipt = sealRouteReceipt({ ...draft, ...(initialProgressBaselineSet ? { initialProgressBaselineSet } : {}), ...(args.progress ? { progress: args.progress } : {}) });
      records.unshift({ kind: 'route_receipt', payload: receipt });
      const revalidate = () => {
        if (identityHash(targetRouteSnapshot(target, args.storyId, args.targetItemId, true)) !== identityHash(snapshot)) throw new Error('route: target moved before commit');
        sourceRouteRecord(source, args.source); if (args.predecessor) exactReceipt(target, args.predecessor);
        const liveStory = target.store.readStory(args.storyId);
        if ((liveStory.createdAt ?? '') !== (targetStory.createdAt ?? '') || (liveStory.startedAt ?? '') !== (targetStory.startedAt ?? '')
          || routeRelevantSourceDigest(target, args.subject.sourcePaths) !== recallBindings.sourcePathsDigest
          || routeRelevantSourceDigest(source, sourceOriginPaths) !== recallBindings.sourceOriginDigest
          || identityHash(routeRuntimeReferences(target, args.storyId)) !== identityHash(recallBindings.runtimeRefs)) throw new Error('route: recall bindings moved before commit');
        if (Date.now() >= expiry) throw new Error('route: expiry reached before commit');
      };
      return { records, referencedRecords: previous ? [previous.record] : [], validate: validator(target), revalidate };
    } }));
  }
  return {
    finding_progress_predecessor(input: unknown) {
      const args = parseIdentityInput(progressPredecessorRequestSchema, input);
      const source = identityStoryContext(ctx, args.storyId); const target = identityStoryContext(ctx, args.routeReceiptRef.storyId);
      const lease = readOwnerLease(source.store.storyDirPath(args.storyId));
      if (!lease || isLeaseStale(lease) || lease.sessionId !== getSessionIdentity().sessionId || realpathSync(process.cwd()) !== realpathSync(source.root)
        || !isTrustedHostActor(readBrandEnv('AGENT') || 'main')) throw new Error('progress: source owner required');
      if (args.sourceRecord.storyId !== args.storyId) throw new Error('progress: source reference wrong Story');
      return withIdentityLedgerLocks([{ ctx: source, storyId: args.storyId }, { ctx: target, storyId: args.routeReceiptRef.storyId }], () => appendIdentityTransaction(source, {
        ...args, operation: 'append_progress_baseline_set', request: args, validate: validator(source), prepare: (ledger, _signer, signing) => {
          const prove = () => {
            const row = exactReceipt(target, args.routeReceiptRef); const receipt = row.envelope.payload;
            if (receipt.source.storyId !== args.storyId || receipt.evidenceAuthority.profile !== 'finding_route') throw new Error('progress: source/target reference mismatch');
            sourceRouteRecord(source, receipt.source);
            const set = baselineSetForReceipt(target, receipt);
            if (args.baselineSetRef.storyId !== receipt.target.id || args.baselineSetRef.recordId !== set.record.recordId || args.baselineSetRef.recordHash !== exactLedgerRecordHash(set.record)) throw new Error('progress: baseline reference mismatch');
            const record = verifiedIdentityCarrier(ledger, args.storyId, args.sourceRecord.recordId, identityTrust(source));
            if (exactLedgerRecordHash(record.record) !== args.sourceRecord.recordHash) throw new Error('progress: source record substitution');
            return { receipt, set, record };
          };
          const evidence = prove();
          const base = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const,
            sourceRecord: args.sourceRecord, routeReceiptRef: args.routeReceiptRef, baselineSetRef: args.baselineSetRef,
            canonicalDefectId: evidence.set.envelope.payload.canonicalDefectId, routeReceiptId: evidence.receipt.routeReceiptId, routeSubjectDigest: evidence.receipt.routeSubjectDigest,
            createdAt: signing.producedAt, sourceOwner: lease.sessionId, sourceLeaseDigest: canonicalDigest({ sessionId: lease.sessionId, acquiredAt: lease.acquiredAt, cwd: lease.cwd }) };
          return { records: [{ kind: 'progress_predecessor', payload: { ...base, bindingHash: identityHash(base) } }], referencedRecords: [evidence.record.record], validate: validator(source), revalidate: () => { prove();
            const current = readOwnerLease(source.store.storyDirPath(args.storyId)); if (!current || isLeaseStale(current) || current.sessionId !== lease.sessionId || current.acquiredAt !== lease.acquiredAt) throw new Error('progress: source owner moved'); } };
        } }));
    },
    finding_route_accept: (input: unknown) => acceptOrReject(input, 'accepted'),
    finding_route_reject: (input: unknown) => acceptOrReject(input, 'rejected'),
    finding_route_revoke(input: unknown) {
      const args = parseIdentityInput(routeRevokeSchema, input); const target = identityStoryContext(ctx, args.storyId);
      if (args.receipt.storyId !== args.storyId) throw new Error('route: target ledger reference mismatch');
      const old = exactReceipt(target, args.receipt, false); targetRouteSnapshot(target, args.storyId, old.envelope.payload.target.responsibility.workItemRef, true);
      return withIdentityLedgerLocks([{ ctx: target, storyId: args.storyId }], () => appendIdentityTransaction(target, { ...args, operation: 'append_route_receipt', request: args,
        validate: validator(target), prepare: () => {
          const original = exactReceipt(target, args.receipt); const prior = original.envelope.payload; const now = new Date().toISOString();
          const snapshot = targetRouteSnapshot(target, args.storyId, prior.target.responsibility.workItemRef, true);
          const { receiptHash: _hash, routeSubjectDigest: _subject, initialProgressBaselineSet: _baselines, progress: _progress, acceptedAt: _accepted, ...rest } = prior;
          const base = { ...rest, target: snapshot, signedBy: snapshot.owner.identity, signedByAuthority: snapshot.owner.authority, policyDigest: snapshot.policyDigest,
            routeReceiptId: `route:${randomUUID()}`, decision: 'rejected' as const, rejectedAt: now, revokedAt: now, revocationReason: args.reason,
            expiresAt: new Date(Date.now() + 1000).toISOString(), predecessor: args.receipt, supersedesRouteReceiptId: prior.routeReceiptId,
            routeChainDigest: identityHash({ predecessor: prior.routeChainDigest, reason: args.reason }) };
          const receipt = sealRouteReceipt({ ...base, routeSubjectDigest: receiptSubjectDigest(base) });
          return { records: [{ kind: 'route_receipt', payload: receipt }], referencedRecords: [original.record], validate: validator(target),
            revalidate: () => { exactReceipt(target, args.receipt); targetRouteSnapshot(target, args.storyId, prior.target.responsibility.workItemRef, true); } };
        } }));
    },
    finding_route_verify(input: unknown) {
      const args = parseIdentityInput(routeVerifySchema, input); const target = identityStoryContext(ctx, args.storyId);
      if (args.receipt.storyId !== args.storyId) throw new Error('route: target ledger reference mismatch');
      const row = exactReceipt(target, args.receipt); const receipt = row.envelope.payload;
      // The target already accepted the exact signed proposal while its reviewer
      // evidence was current. Later read-only verification must preserve that
      // historical authority across a source phase-only transition; the signed
      // proposal and exact source/head/material bindings below still fail closed.
      const source = identityStoryContext(ctx, receipt.source.storyId); sourceRouteRecord(source, receipt.source, false);
      if (receipt.canonicalDefect) canonicalForRoute(ctx, receipt.canonicalDefect);
      assertReceiptCurrent(receipt, targetRouteSnapshot(target, args.storyId, receipt.target.responsibility.workItemRef));
      if (receipt.initialProgressBaselineSet) baselineSetForReceipt(target, receipt);
      return { ...row, valid: true, gateEvidence: false };
    },
    finding_candidate_route(input: unknown) {
      const args = parseIdentityInput(candidateRouteRequestSchema, input); const source = identityStoryContext(ctx, args.storyId);
      const target = identityStoryContext(ctx, args.receipt.storyId);
      assertCwdInWorktree(source.store, args.storyId);
      const lease = readOwnerLease(source.store.storyDirPath(args.storyId));
      if (!lease || isLeaseStale(lease) || lease.sessionId !== getSessionIdentity().sessionId || realpathSync(process.cwd()) !== realpathSync(source.root)
        || !isTrustedHostActor(readBrandEnv('AGENT') || 'main')) throw new Error('route: source owner required');
      if (args.candidate.storyId !== args.storyId || args.candidate.subjectKind !== 'candidate_finding') throw new Error('route: source candidate profile required');
      return withIdentityLedgerLocks([{ ctx: source, storyId: args.storyId }, { ctx: target, storyId: args.receipt.storyId }], () => appendIdentityTransaction(source, {
        ...args, operation: 'append_candidate_route', request: args, validate: validator(source), prepare: () => {
          const prove = () => {
            sourceRouteRecord(source, args.candidate); const row = exactReceipt(target, args.receipt); const receipt = row.envelope.payload;
            if (receipt.evidenceAuthority.profile !== 'candidate_route' || identityHash(receipt.source) !== identityHash(args.candidate)) throw new Error('route: exact receipt profile/source mismatch');
            assertReceiptCurrent(receipt, targetRouteSnapshot(target, args.receipt.storyId, receipt.target.responsibility.workItemRef)); return row;
          };
          const row = prove(); const receipt = row.envelope.payload;
          const base = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const, candidateRouteId: `candidate-route:${randomUUID()}`,
            source: args.candidate, receipt: args.receipt, routeReceiptId: receipt.routeReceiptId, routeReceiptHash: receipt.receiptHash, routeReceiptProfile: 'candidate_route' as const,
            targetId: receipt.target.id, targetOwner: receipt.target.owner.identity, uncertaintyReason: args.uncertaintyReason, evidenceRefs: args.evidenceRefs,
            severity: args.severity, recheckTriggers: args.recheckTriggers, visitedTargetDigests: receipt.visitedTargetDigests, createdAt: new Date().toISOString(), expiresAt: receipt.expiresAt };
          return { records: [{ kind: 'candidate_route', payload: { ...base, currentProjectionHash: identityHash(base) } }],
            referencedRecords: [sourceRouteRecord(source, args.candidate).bound.record], validate: validator(source), revalidate: () => { prove(); } };
        } }));
    },
    finding_progress_capture(input: unknown) {
      const args = parseIdentityInput(progressCaptureSchema, input); const target = identityStoryContext(ctx, args.storyId);
      if (args.receipt.storyId !== args.storyId) throw new Error('progress: target ledger reference mismatch');
      const currentReceipt = exactReceipt(target, args.receipt, false); const receipt = currentReceipt.envelope.payload;
      targetRouteSnapshot(target, args.storyId, receipt.target.responsibility.workItemRef, true, true);
      const source = identityStoryContext(ctx, receipt.source.storyId);
      return withIdentityLedgerLocks([{ ctx: target, storyId: args.storyId }, { ctx: source, storyId: receipt.source.storyId }], () => appendIdentityTransaction(target, {
        ...args, operation: 'append_progress_baseline_set', request: args, validate: validator(target), prepare: (ledger, signer) => {
          exactReceipt(target, args.receipt); sourceRouteRecord(source, receipt.source, false);
          if (receipt.canonicalDefect) canonicalForRoute(ctx, receipt.canonicalDefect);
          if (receipt.evidenceAuthority.profile !== 'finding_route' || !receipt.canonicalDefect) throw new Error('progress: finding receipt required');
          const snapshot = targetRouteSnapshot(target, args.storyId, receipt.target.responsibility.workItemRef, true, true); receiptOwnerStillValid(receipt, snapshot);
          const setRow = baselineSetForReceipt(target, receipt);
          if (args.predecessor.storyId !== args.storyId || args.predecessor.recordId !== setRow.record.recordId || args.predecessor.recordHash !== exactLedgerRecordHash(setRow.record)) throw new Error('progress: caller replaced verifier-selected baseline');
          if (args.previousDeferralRef.storyId !== receipt.source.storyId) throw new Error('progress: previous reference source mismatch');
          const previous = verifiedIdentityCarrier(source.store.readFindingLedger<JsonValue>(receipt.source.storyId), receipt.source.storyId, args.previousDeferralRef.recordId, identityTrust(source));
          if (exactLedgerRecordHash(previous.record) !== args.previousDeferralRef.recordHash) throw new Error('progress: previous reference tampered');
          // Neutral ledger reference must demonstrably bind this route. No Story1 schema import.
          const priorPayload = previous.record.payload as Record<string, unknown>;
          verifyIdentityEnvelope(priorPayload, identityTrust(source), validateProgressPredecessor);
          const priorSemantic = priorPayload.payload as unknown as ProgressPredecessor;
          if (previous.record.recordType !== 'progress_predecessor' || priorSemantic.routeReceiptId !== receipt.routeReceiptId || priorSemantic.routeSubjectDigest !== receipt.routeSubjectDigest
            || identityHash(priorSemantic.routeReceiptRef) !== identityHash(args.receipt) || identityHash(priorSemantic.baselineSetRef) !== identityHash(args.predecessor)
            || priorSemantic.canonicalDefectId !== setRow.envelope.payload.canonicalDefectId || priorSemantic.sourceRecord.storyId !== receipt.source.storyId) throw new Error('progress: neutral predecessor exact binding mismatch');
          const underlying = verifiedIdentityCarrier(source.store.readFindingLedger<JsonValue>(receipt.source.storyId), receipt.source.storyId, priorSemantic.sourceRecord.recordId, identityTrust(source));
          if (exactLedgerRecordHash(underlying.record) !== priorSemantic.sourceRecord.recordHash) throw new Error('progress: neutral predecessor source record invalid');
          // Source ownership is historical signed capture provenance. Target
          // ownership remains live; finishing the source does not erase its checkpoint.
          const selected = setRow.envelope.payload.baselines[PROGRESS_KINDS.indexOf(args.kind)]! as unknown as IdentitySemanticEnvelope<ProgressBaseline>;
          const projection = currentProjection(target, receipt, args.kind, setRow.envelope.payload.canonicalDefectId, args.executionKey);
          if (!projection) throw new Error('progress: no present target progress');
          if (projection.kind === 'target_test_result') {
            const execution = target.store.readCausalEvidenceReceipt(args.storyId, projection.executionKey)!;
            if (Date.parse(execution.executedAt) <= Math.max(Date.parse(previous.record.createdAt), Date.parse(selected.payload.capturedAt))) throw new Error('progress: execution predates exact predecessor');
          }
          const now = new Date().toISOString();
          if (Date.parse(now) <= Date.parse(previous.record.createdAt)) throw new Error('progress: evidence predates predecessor');
          const base = progressBase(receipt, setRow.envelope.payload.canonicalDefectId, snapshot, now);
          const evidencePayload = { ...base, kind: args.kind, projection };
          const evidence = signIdentityEnvelope({ kind: 'target_progress_evidence', storyId: args.storyId, producedAt: now, requestDigest: identityHash(args), payload: evidencePayload }, signer,
            value => { parseIdentityInput(targetEvidenceSchema, value); });
          const tuple = { ...base, kind: args.kind, projection, projectionDigest: identityHash(semanticProjection(projection)), predecessor: args.predecessor,
            previousDeferralRef: args.previousDeferralRef, predecessorBaselineDigest: selected.payload.baselineHash,
            predecessorProjectionDigest: selected.payload.projectionDigest ?? selected.payload.absenceDigest!, evidence };
          const binding = { ...tuple, tupleDigest: identityHash(tuple) }; validateProgress(binding, identityTrust(target)); assertProgressTransition(selected.payload, binding);
          const priorProgress = readIdentityRows<ProgressBinding>(target, args.storyId, ['progress_evidence'], validator(target));
          if (priorProgress.some(row => row.envelope.payload.routeReceiptId === receipt.routeReceiptId && row.envelope.payload.kind === args.kind
            && row.envelope.payload.projectionDigest === binding.projectionDigest)) throw new Error('progress: replay/no-op resigning');
          return { records: [{ kind: 'progress_evidence', payload: binding }], referencedRecords: [currentReceipt.record, setRow.record], validate: validator(target),
            revalidate: () => { exactReceipt(target, args.receipt); sourceRouteRecord(source, receipt.source, false);
              if (identityHash(targetRouteSnapshot(target, args.storyId, receipt.target.responsibility.workItemRef, true, true)) !== identityHash(snapshot)
                || identityHash(currentProjection(target, receipt, args.kind, binding.canonicalDefectId, args.executionKey)) !== identityHash(projection)) throw new Error('progress: capture moved before commit'); } };
        } }));
    },
  };
}
