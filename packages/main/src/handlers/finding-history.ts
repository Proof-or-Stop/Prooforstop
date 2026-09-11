/** Signed historical corrections and non-gate recall through existing Store ports. */
import { randomUUID } from 'node:crypto';
import { realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { resolveCandidateMutationAuthority, isTrustedHostActor } from '../core/agent-dispatch-registry.js';
import { readBrandEnv } from '../core/brand-env.js';
import { readOwnerLease, isLeaseStale } from '../core/story-owner-lease.js';
import { getSessionIdentity } from '../core/owner-session.js';
import { assertCurrentReviewRunForEvidence } from '../core/review-run.js';
import { identityHash, parseIdentityInput, validateCanonicalDefect, canonicalIdentityDigest, sortedUnique, sealCandidate,
  sourceLineageKeys, candidateSuggestionKey, validateCandidate, validateSignal, projectConfirmedIdentityGroups,
  validateCandidateReproductionAttestation } from '../core/finding-identity.js';
import { findingSupersessionRequestSchema, canonicalSupersessionRequestSchema, validateSupersession,
  canonicalCurrent, validateHistoryGraph, buildHistoryIndex, queryHistoryIndex, historyQuerySchema,
  historyRecallSchema, validateRecall, type HistorySupersession, SCORECARD_KINDS, scorecardQuerySchema, scorecardDigest,
  buildIdentityScorecard, detectorAdjudicationMeasurements, type IdentityScorecard } from '../core/finding-history.js';
import { appendIdentityTransaction, historicalStoryContext, identityCatalogStoryIds, historicalFindingRef,
  withIdentityCatalogLock, withIdentityLedgerLocks, readHistoryCatalog, readCanonicalCatalog, readIdentityRows,
  assertIdentityAnchorsCurrent, identitySourceSnapshot, identityTrust, verifiedIdentityCarrier, currentFindingIdentityResolver, identityCatalogContributor } from './finding-identity-store.js';
import { exactLedgerRecordHash } from './finding-ledger.js';
import type { CanonicalDefect, CandidateFinding, CandidateReproductionContract, DetectorSignal } from '../core/finding-identity-types.js';
import type { JsonValue } from '../core/finding-ledger.js';
import { createFindingRouteHandlers, routeRuntimeReferences, routeRelevantSourceDigest, targetRouteSnapshot } from './finding-route.js';
import { validateRouteReceipt, validateCandidateRoute, type RouteReceipt } from '../core/finding-route.js';
import { validateBaseline, validateBaselineSet, validateProgress, validateProgressPredecessor } from '../core/finding-progress.js';
import { readCandidates } from './finding-identity.js';
import { verifyFinding } from '../core/finding-verify.js';

/** Internal composition port: its observation can create only a non-gate candidate. */
export type DeferralInvalidationObservationProvider = (ctx: HandlerContext, args: ReturnType<typeof historyRecallSchema.parse>, source: HandlerContext, receipt: RouteReceipt) => object;

function recallObservation(ctx: HandlerContext, args: ReturnType<typeof historyRecallSchema.parse>, provider?: DeferralInvalidationObservationProvider) {
  if ((args.trigger === 'deferral_invalidated') !== !!args.deferral) throw new Error('history: exact deferral reference required only for L4 invalidation');
  const history = historicalStoryContext(ctx, args.route.storyId);
  const records = history.store.readFindingLedger<JsonValue>(args.route.storyId);
  const original = verifiedIdentityCarrier(records, args.route.storyId, args.route.recordId, identityTrust(history));
  if (exactLedgerRecordHash(original.record) !== args.route.recordHash) throw new Error('history: route reference substitution');
  let receiptRef = args.route;
  if (original.record.recordType === 'candidate_route') {
    const row = readIdentityRows(history, args.route.storyId, ['candidate_route'], (_kind, value) => validateCandidateRoute(value)).find(row => row.record.recordId === args.route.recordId)!;
    const payload = row.envelope.payload; validateCandidateRoute(payload); receiptRef = (payload as { receipt: typeof args.route }).receipt;
  } else if (original.record.recordType !== 'route_receipt') throw new Error('history: route profile required');
  const target = historicalStoryContext(ctx, receiptRef.storyId);
  const receiptRow = readIdentityRows<RouteReceipt>(target, receiptRef.storyId, ['route_receipt'], (_kind, value) => validateRouteReceipt(value))
    .find(row => row.record.recordId === receiptRef.recordId && exactLedgerRecordHash(row.record) === receiptRef.recordHash);
  if (!receiptRow) throw new Error('history: missing/tampered historical receipt');
  const receipt = receiptRow.envelope.payload;
  if (![receipt.source.storyId, receipt.target.id].includes(args.storyId)) throw new Error('history: recall destination is neither source nor target');
  const source = historicalStoryContext(ctx, receipt.source.storyId); const targetStory = target.store.readStory(receipt.target.id);
  const bindings = receipt.recallBindings;
  let currentConsent = false; let consentDiagnostic = 'not_verified';
  try { createFindingRouteHandlers(target).finding_route_verify({ storyId: receipt.target.id, receipt: receiptRef }); currentConsent = true; consentDiagnostic = 'fresh_accepted'; }
  catch (error) { consentDiagnostic = error instanceof Error ? error.message : 'invalid consent'; }
  const sourceRecord = source.store.readFindingLedger<JsonValue>(receipt.source.storyId).records.find(row => row.recordId === receipt.source.recordId);
  if (!sourceRecord || exactLedgerRecordHash(sourceRecord) !== receipt.source.recordHash) throw new Error('history: recalled source missing/substituted');
  verifiedIdentityCarrier(source.store.readFindingLedger<JsonValue>(receipt.source.storyId), receipt.source.storyId, sourceRecord.recordId, identityTrust(source));
  let candidate: CandidateFinding | undefined; let reproductionContract: CandidateReproductionContract | undefined; let severity: string | undefined; let sourceUnfixed = false;
  let anchors: CanonicalDefect['evidenceAnchors']; let contracts: readonly string[]; let symbols: readonly string[]; let description: string; let subjectKey: string;
  if (receipt.source.subjectKind === 'candidate_finding') {
    const versions = readIdentityRows<CandidateFinding>(source, receipt.source.storyId, ['candidate'], (_kind, value) => validateCandidate(value));
    candidate = versions.find(row => row.record.recordId === receipt.source.recordId)?.envelope.payload;
    if (!candidate || candidate.candidateId !== receipt.source.subjectId) throw new Error('history: source candidate identity mismatch');
    const current = readCandidates(source, receipt.source.storyId).candidates.find(row => row.envelope.payload.candidateId === candidate!.candidateId)?.envelope.payload;
    if (!current) throw new Error('history: current candidate lineage missing');
    reproductionContract = current.reproductionContract;
    sourceUnfixed = current.state === 'pending_verification';
    if (current?.promotionFindingRef) {
      const currentRef = currentFindingIdentityResolver(ctx)(current.promotionFindingRef);
      const finding = historicalFindingRef(historicalStoryContext(ctx, currentRef.storyId), currentRef).finding;
      severity = finding.severity; sourceUnfixed = finding.status === 'open';
    }
    anchors = candidate.sourceBindings; contracts = candidate.affectedContracts; symbols = candidate.affectedSymbols; description = candidate.suspectedDefect; subjectKey = candidate.candidateId;
  } else {
    const findingRef = (sourceRecord.payload as { findingRef?: { storyId: string; findingId: string; recordId: string } }).findingRef;
    if (!findingRef) throw new Error('history: proposal source Finding missing');
    const finding = source.store.readFindings(receipt.source.storyId, { strictMirror: true }).findings.find(row => row.recordId === findingRef.recordId && row.id === findingRef.findingId);
    if (!finding || !verifyFinding(receipt.source.storyId, finding)) throw new Error('history: historical Finding signature invalid');
    const canonical = readCanonicalCatalog(ctx).rows.find(row => row.record.recordId === receipt.canonicalDefect?.recordId
      && row.envelope.storyId === receipt.canonicalDefect.storyId && exactLedgerRecordHash(row.record) === receipt.canonicalDefect.recordHash)?.envelope.payload;
    if (!canonical) throw new Error('history: canonical historical source missing');
    const graph = readCanonicalCatalog(ctx).input; const lineage = canonicalCurrent(graph, receipt.canonicalDefect!.recordId);
    anchors = canonical.evidenceAnchors; contracts = canonical.affectedContracts; symbols = canonical.affectedSymbols; description = finding.desc;
    const currentRef = currentFindingIdentityResolver(ctx)({ ...findingRef, recordHash: exactLedgerRecordHash(source.store.readFindingLedger<JsonValue>(receipt.source.storyId).records.find(row => row.recordId === findingRef.recordId)!) });
    const currentFinding = historicalFindingRef(historicalStoryContext(ctx, currentRef.storyId), currentRef).finding;
    subjectKey = lineage.predecessors[0]?.entityId ?? lineage.current.entityId; severity = currentFinding.severity; sourceUnfixed = currentFinding.status === 'open';
  }
  const lease = readOwnerLease(target.store.storyDirPath(receipt.target.id));
  const checklist = target.store.readChecklist(receipt.target.id);
  const items = checklist.items.filter(row => receipt.subject.targetChecklistItemRefs.includes(row.id));
  let triggerState: object;
  if (args.trigger === 'deferral_invalidated') {
    if (!provider) throw new Error('history: deferral invalidation provider unavailable');
    triggerState = provider(ctx, args, source, receipt);
  } else if (args.trigger === 'expired') {
    if (Date.now() < Date.parse(receipt.expiresAt)) throw new Error('history: expiry trigger not reached'); triggerState = { expiresAt: receipt.expiresAt };
  } else if (args.trigger === 'owner_invalid') {
    if (receipt.target.kind === 'b_meta_gap') {
      const current = targetRouteSnapshot(target, receipt.target.id, receipt.target.responsibility.workItemRef);
      if (identityHash(current.owner) === identityHash(receipt.target.owner) && current.policyDigest === receipt.policyDigest) throw new Error('history: canonical B-META authority remains valid');
      triggerState = { owner: current.owner, policyDigest: current.policyDigest };
    } else {
    const owner = lease && !isLeaseStale(lease) ? { sessionId: lease.sessionId, acquiredAt: lease.acquiredAt, cwd: lease.cwd } : { state: 'missing_or_stale' };
    if (lease && !isLeaseStale(lease) && lease.sessionId === receipt.target.owner.identity && identityHash(owner) === receipt.target.owner.leaseDigest) throw new Error('history: owner invalidation not observed');
    triggerState = owner;
    }
  } else if (args.trigger === 'target_closed_unfixed') {
    if (!sourceUnfixed) throw new Error('history: source is no longer an unresolved candidate/open Finding');
    if (!['DONE', 'DISCARDED'].includes(targetStory.phase)) throw new Error('history: target closure not observed');
    // A closed target without a current semantic repair proof needs reevaluation;
    // historical DONE or a delivery narrative is not such proof.
    triggerState = { phase: targetStory.phase, itemStates: items.map(row => ({ id: row.id, status: row.status })) };
  } else {
    if (!bindings) throw new Error(`history: incomplete legacy recall bindings for ${args.trigger}`);
    if (args.trigger === 'target_created') {
      if (!bindings.targetCreatedAt || bindings.targetCreatedAt !== targetStory.createdAt) throw new Error('history: bound target-created fact unavailable');
      triggerState = { semantics: 'first_observation_of_existing_target_created_fact', createdAt: targetStory.createdAt };
    } else if (args.trigger === 'target_started') {
      if (!['DEV', 'REVIEW', 'TEST', 'DONE'].includes(targetStory.phase) || !['INIT', 'INIT_CHECK', 'PLAN'].includes(bindings.targetPhase)) throw new Error('history: target start transition not observed');
      triggerState = { startedAt: targetStory.startedAt ?? 'active_phase_observed', state: 'started' };
    } else if (args.trigger === 'scope_contract_match') {
      const paths = sortedUnique(items.flatMap(row => Object.values(row.files ?? {}).flat()));
      const currentContracts = items.flatMap(item => Object.entries(item.verificationIntent ?? {}).flatMap(([kind, rows]) => Array.isArray(rows) ? rows.map((_, index) => `${item.id}:${kind}:${index}`) : []));
      const matchedContracts = receipt.subject.affectedContractRefs.filter(ref => currentContracts.includes(ref));
      if (!anchors.some(anchor => paths.includes(anchor.path)) && !matchedContracts.length) throw new Error('history: affected scope/contract match not observed');
      triggerState = { paths, contracts: matchedContracts };
    } else if (args.trigger === 'severity_escalation') {
      const ranks: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
      if (!severity || (ranks[severity] ?? 0) <= (ranks[bindings.sourceSeverity ?? ''] ?? 0)) throw new Error('history: severity escalation not observed');
      triggerState = { priorSeverity: bindings.sourceSeverity ?? 'unclassified_candidate', severity };
    } else if (args.trigger === 'source_hash_drift') {
      const digest = routeRelevantSourceDigest(target, receipt.subject.sourcePaths);
      const originDigest = routeRelevantSourceDigest(source, bindings.sourceOriginPaths);
      if (digest === bindings.sourcePathsDigest && originDigest === bindings.sourceOriginDigest) throw new Error('history: relevant source unchanged'); triggerState = { digest, originDigest };
    } else {
      const refs = routeRuntimeReferences(target, receipt.target.id);
      if (identityHash(refs) === identityHash(bindings.runtimeRefs)) throw new Error('history: runtime references unchanged'); triggerState = { refs, authority: 'persistence_only' };
    }
  }
  const triggerDigest = identityHash({ subjectKey, targetId: receipt.target.id, trigger: args.trigger, triggerState });
  return { receipt, receiptRow, sourceRecord, target, source, original, currentConsent, consentDiagnostic, triggerState, triggerDigest, anchors, contracts, symbols, description, reproductionContract };
}

/** Read-only trigger selection; automatic and explicit callers share one key. */
export function findingHistoryRecallObservation(ctx: HandlerContext, input: unknown, provider?: DeferralInvalidationObservationProvider) {
  const observation = recallObservation(ctx, parseIdentityInput(historyRecallSchema, input), provider);
  return { triggerDigest: observation.triggerDigest, triggerState: observation.triggerState };
}

function reviewer(ctx: HandlerContext, storyId: string, reviewRunId: string, evidence: Parameters<typeof assertIdentityAnchorsCurrent>[1]): string {
  assertCwdInWorktree(ctx.store, storyId);
  const actor = resolveCandidateMutationAuthority('finding_candidate_promote', ctx.store.readStory(storyId).phase);
  assertCurrentReviewRunForEvidence(ctx.store, ctx.store.readStory(storyId), ctx.root, actor, reviewRunId);
  assertIdentityAnchorsCurrent(ctx, evidence); return actor;
}
function historyValidator(kind: string, value: unknown): void {
  if (kind === 'canonical_revision' || kind === 'canonical_defect') validateCanonicalDefect(value);
  else if (kind === 'finding_supersession' || kind === 'canonical_defect_supersession') validateSupersession(value);
  else if (kind === 'history_recall') validateRecall(value);
  else if (kind === 'detector_signal') validateSignal(value);
  else if (kind === 'candidate') validateCandidate(value);
  else if (kind === 'candidate_reproduction_attestation') validateCandidateReproductionAttestation(value);
  else throw new Error('history: unknown semantic kind');
}
export function createFindingHistoryHandlers(ctx: HandlerContext, provider?: DeferralInvalidationObservationProvider) {
  return {
    finding_identity_scorecard(input: unknown) {
      const args = parseIdentityInput(scorecardQuerySchema, input); ctx.store.readStory(args.storyId);
      const ids = sortedUnique(args.sourceStoryIds ?? identityCatalogStoryIds(ctx));
      const collect = () => {
        const rows: IdentityScorecard['rows'] = []; const inputBindings: IdentityScorecard['inputBindings'] = [];
        const signals: DetectorSignal[] = []; const candidates: CandidateFinding[] = [];
        for (const storyId of ids) {
          const home = identityCatalogContributor(ctx, storyId, SCORECARD_KINDS);
          if (!home) {
            // Use the same strict history port for a genuinely empty catalog.
            // An unresolved unrelated Story may be empty, never a hidden mirror.
            const empty = readHistoryCatalog(ctx, [storyId]);
            if (empty.incomplete.length) throw new Error(`scorecard: incomplete history ${empty.incomplete.join('; ')}`);
            inputBindings.push({ storyId, ledgerDigest: identityHash([]), snapshotDigest: identityHash(empty.input),
              headHash: null, materialHash: null, storyPhase: null, storyType: null });
            continue;
          }
          const ledger = home.store.readFindingLedger<JsonValue>(storyId);
          const findings = home.store.readFindings(storyId, { strictMirror: true });
          const lease = readOwnerLease(home.store.storyDirPath(storyId));
          const sourceSnapshot = identitySourceSnapshot(home); const story = home.store.readStory(storyId);
          inputBindings.push({ storyId, ledgerDigest: ledger.committedLedgerDigest, headHash: sourceSnapshot.headHash, materialHash: sourceSnapshot.materialHash,
            storyPhase: story.phase, storyType: story.type,
            snapshotDigest: scorecardDigest({ source: sourceSnapshot, story,
              findings, checklist: home.store.readChecklist(storyId), scope: home.store.readScopeContract(storyId) ?? null,
              owner: lease ? { sessionId: lease.sessionId, acquiredAt: lease.acquiredAt, cwd: lease.cwd } : null }) });
          const semanticRows = readIdentityRows(home, storyId, SCORECARD_KINDS, (kind, value) => {
            if (kind === 'route_receipt') validateRouteReceipt(value);
            else if (kind === 'candidate_route') validateCandidateRoute(value);
            else if (kind === 'progress_baseline') validateBaseline(value);
            else if (kind === 'progress_baseline_set') validateBaselineSet(value, identityTrust(home));
            else if (kind === 'progress_evidence') validateProgress(value, identityTrust(home));
            else if (kind === 'progress_predecessor') validateProgressPredecessor(value);
            else historyValidator(kind, value);
          });
          for (const verified of semanticRows) {
            const record = verified.record;
            const ref = { storyId, recordId: record.recordId, recordHash: exactLedgerRecordHash(record) };
            // Every explicit immutable reference must still resolve to the exact
            // authenticated carrier. Historical validity is NOT current consent.
            const references = (value: unknown): void => {
              if (!value || typeof value !== 'object') return;
              if (Array.isArray(value)) { value.forEach(references); return; }
              const row = value as Record<string, unknown>;
              if (typeof row.storyId === 'string' && typeof row.recordId === 'string' && typeof row.recordHash === 'string') {
                const target = historicalStoryContext(ctx, row.storyId);
                const bound = verifiedIdentityCarrier(target.store.readFindingLedger<JsonValue>(row.storyId), row.storyId, row.recordId, identityTrust(target));
                if (exactLedgerRecordHash(bound.record) !== row.recordHash) throw new Error('scorecard: substituted evidence reference');
              }
              Object.values(row).forEach(references);
            };
            references(verified.envelope.payload);
            rows.push({ ...ref, kind: record.recordType as typeof SCORECARD_KINDS[number],
              record: verified.record as unknown as Record<string, unknown>, envelope: verified.envelope as unknown as Record<string, unknown>,
              receipt: verified.receipt as unknown as Record<string, unknown> });
          }
          if (ledger.records.some(row => row.recordType === 'candidate' || row.recordType === 'detector_signal')) {
            const current = readCandidates(home, storyId);
            signals.push(...current.signals.map(row => row.envelope.payload)); candidates.push(...current.candidates.map(row => row.envelope.payload));
          }
        }
        const canonical = readCanonicalCatalog(ctx);
        const current = canonical.rows.filter(row => ids.includes(row.envelope.storyId)
          && !canonicalCurrent(canonical.input, row.record.recordId).superseded).map(row => row.envelope.payload);
        return buildIdentityScorecard({ query: { storyId: args.storyId, sourceStoryIds: ids, mode: args.mode ?? 'observe' }, inputBindings, rows,
          canonicalCatalogDigest: identityHash(canonical.input),
          confirmedGroups: projectConfirmedIdentityGroups(current), detectorMeasurements: detectorAdjudicationMeasurements(signals, candidates) });
      };
      // Optimistic read consistency also covers non-ledger writers. Refuse drift;
      // no read creates a signer, receipt, candidate or lifecycle artifact.
      const before = collect(); const after = collect();
      if (before.digest !== after.digest || args.expectedInputDigest && args.expectedInputDigest !== after.inputDigest) throw new Error('scorecard: current source snapshot moved or expected input is stale');
      return after;
    },
    finding_history_recall(input: unknown) {
      const args = parseIdentityInput(historyRecallSchema, input); const destination = historicalStoryContext(ctx, args.storyId);
      const authorize = () => {
        const story = destination.store.readStory(args.storyId); assertCwdInWorktree(destination.store, args.storyId);
        const lease = readOwnerLease(destination.store.storyDirPath(args.storyId));
        if (!['DEV', 'REVIEW', 'TEST'].includes(story.phase) || !isTrustedHostActor(readBrandEnv('AGENT') || 'main')
          || !lease || isLeaseStale(lease) || lease.sessionId !== getSessionIdentity().sessionId || realpathSync(process.cwd()) !== realpathSync(destination.root)) throw new Error('history: current destination owner required');
      };
      authorize();
      return withIdentityCatalogLock(destination, () => {
        const observation = recallObservation(ctx, args, provider);
        return withIdentityLedgerLocks([{ ctx: destination, storyId: args.storyId }, { ctx: observation.target, storyId: observation.receipt.target.id },
          { ctx: observation.source, storyId: observation.receipt.source.storyId }], () => {
          const current = recallObservation(ctx, args, provider);
          for (const storyId of identityCatalogStoryIds(ctx)) {
            const source = identityCatalogContributor(ctx, storyId, ['history_recall']); if (!source) continue;
            const ledger = source.store.readFindingLedger<JsonValue>(storyId);
            if (!ledger.records.some(row => row.recordType === 'history_recall')) continue;
            const prior = readIdentityRows<{ triggerDigest: string; candidateId: string }>(source, storyId, ['history_recall'], (_kind, value) => validateRecall(value))
              .find(row => row.envelope.payload.triggerDigest === current.triggerDigest);
            if (prior && !readCandidates(source, storyId).candidates.some(row => row.envelope.payload.candidateId === prior.envelope.payload.candidateId)) throw new Error('history: recall candidate lineage missing');
            if (prior) return { authority: 'non_authoritative', gateEvidence: false, created: 0, candidateId: prior.envelope.payload.candidateId,
              currentConsent: current.currentConsent, consentDiagnostic: current.consentDiagnostic, recall: prior };
          }
          const result = appendIdentityTransaction(destination, { ...args, operation: 'append_candidate', request: args, validate: historyValidator,
            prepare: (_ledger, _signer, signing) => {
              const snapshot = identitySourceSnapshot(destination);
              const signalBase = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const,
                signalId: `signal:${randomUUID()}`, detectorId: 'historical-route-recall', detectorVersion: '1', observedAt: signing.producedAt,
                targetStoryId: args.storyId, ...snapshot, sourceIds: [identityHash(args.route), current.triggerDigest], outputDigest: current.triggerDigest,
                matchCount: 1, anchors: [...current.anchors], rawCategory: `historical_${args.trigger}` };
              const signal: DetectorSignal = { ...signalBase, sourceLineageKeys: sourceLineageKeys(signalBase) };
              const candidateFields = { suspectedDefect: current.description, affectedSymbols: [...current.symbols], affectedContracts: [...current.contracts] };
              const candidate = sealCandidate({ schemaVersion: 1, authority: 'non_authoritative', gateEvidence: false, candidateId: `candidate:${randomUUID()}`,
                targetStoryId: args.storyId, sourceSignalIds: [signal.signalId], sourceLineageKeys: signal.sourceLineageKeys, ...candidateFields,
                candidateGroupKey: candidateSuggestionKey(candidateFields), state: 'pending_verification', currentEvidenceRefs: [identityHash(args.route), current.triggerDigest], sourceBindings: [...current.anchors],
                ...(current.reproductionContract ? { reproductionContract: current.reproductionContract } : {}) });
              const base = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const,
                recallId: `recall:${randomUUID()}`, trigger: args.trigger, triggerDigest: current.triggerDigest, route: args.route, candidateId: candidate.candidateId,
                currentConsent: current.currentConsent, consentDiagnostic: current.consentDiagnostic, observedSnapshot: current.triggerState,
                createdAt: signing.producedAt };
              const recall = { ...base, recordHash: identityHash(base) };
              return { records: [{ kind: 'detector_signal', payload: signal }, { kind: 'candidate', payload: candidate }, { kind: 'history_recall', payload: recall }],
                referencedRecords: [args.storyId === current.receipt.target.id ? current.receiptRow.record : current.sourceRecord], validate: historyValidator,
                revalidate: () => { authorize(); const latest = recallObservation(ctx, args, provider);
                  if (latest.triggerDigest !== current.triggerDigest || latest.currentConsent !== current.currentConsent || latest.consentDiagnostic !== current.consentDiagnostic) throw new Error('history: recall predicate changed before commit'); } };
            } });
          return { ...result, authority: 'non_authoritative', gateEvidence: false, created: result.replayed ? 0 : 1,
            currentConsent: current.currentConsent, consentDiagnostic: current.consentDiagnostic };
        });
      });
    },
    finding_history_query(input: unknown) {
      const args = parseIdentityInput(historyQuerySchema, input); ctx.store.readStory(args.storyId);
      const data = readHistoryCatalog(ctx, args.sourceStoryIds ?? identityCatalogStoryIds(ctx));
      if (data.incomplete.length) return { authority: 'non_authoritative', gateEvidence: false, complete: false, refused: true, reasons: data.incomplete, rows: [] };
      const index = buildHistoryIndex(data.input);
      const projection = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const,
        complete: true, sourceIndexDigest: index.indexDigest, sourceBindings: index.sourceBindings, query: args, rows: queryHistoryIndex(index, args) };
      return { ...projection, projectionDigest: identityHash(projection) };
    },
    finding_supersession_add(input: unknown) {
      const args = parseIdentityInput(findingSupersessionRequestSchema, input);
      const home = historicalStoryContext(ctx, args.storyId); const predecessorContext = historicalStoryContext(ctx, args.predecessor.storyId); const successor = historicalStoryContext(ctx, args.successor.storyId);
      const actor = reviewer(home, args.storyId, args.reviewRunId, args.evidenceAnchors);
      return withIdentityCatalogLock(home, () => withIdentityLedgerLocks([{ ctx: home, storyId: args.storyId }, { ctx: predecessorContext, storyId: args.predecessor.storyId }, { ctx: successor, storyId: args.successor.storyId }], () =>
        appendIdentityTransaction(home, { ...args, operation: 'append_supersession', request: args, validate: historyValidator, prepare: (_ledger, _signer, signing) => {
          const prior = historicalFindingRef(predecessorContext, args.predecessor); const next = historicalFindingRef(successor, args.successor);
          const { findingId: _priorId, ...predecessor } = args.predecessor; const { findingId: _nextId, ...successorRef } = args.successor;
          const base = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const,
            kind: 'finding_supersession' as const, supersessionId: `supersession:${randomUUID()}`, predecessor, successor: successorRef,
            predecessorEntityId: args.predecessor.findingId, successorEntityId: args.successor.findingId,
            reason: args.reason, evidenceRefs: sortedUnique(args.evidenceRefs), evidenceAnchors: args.evidenceAnchors,
            createdBy: actor, reviewRunId: args.reviewRunId, effectiveAt: signing.producedAt };
          const link: HistorySupersession = { ...base, recordHash: identityHash(base) }; validateSupersession(link);
          const prove = () => {
            reviewer(home, args.storyId, args.reviewRunId, args.evidenceAnchors);
            historicalFindingRef(predecessorContext, args.predecessor); historicalFindingRef(successor, args.successor);
            const catalog = readHistoryCatalog(home, identityCatalogStoryIds(home));
            if (catalog.incomplete.length) throw new Error(`history: incomplete correction inputs: ${catalog.incomplete.join('; ')}`);
            validateHistoryGraph({ ...catalog.input, links: [...catalog.input.links, link] });
          };
          prove(); return { records: [{ kind: 'finding_supersession', payload: link }], referencedRecords: [...(args.predecessor.storyId === args.storyId ? [prior.record] : []), ...(args.successor.storyId === args.storyId ? [next.record] : [])], validate: historyValidator, revalidate: prove };
        } })));
    },
    finding_identity_supersede(input: unknown) {
      const args = parseIdentityInput(canonicalSupersessionRequestSchema, input);
      const home = historicalStoryContext(ctx, args.storyId); const actor = reviewer(home, args.storyId, args.reviewRunId, args.evidenceAnchors);
      const predecessorContext = historicalStoryContext(ctx, args.predecessor.storyId);
      return withIdentityCatalogLock(home, () => withIdentityLedgerLocks([{ ctx: home, storyId: args.storyId }, { ctx: predecessorContext, storyId: args.predecessor.storyId }], () => {
        const original = readCanonicalCatalog(home);
        const before = original.rows.find(row => row.envelope.storyId === args.predecessor.storyId && row.record.recordId === args.predecessor.recordId && exactLedgerRecordHash(row.record) === args.predecessor.recordHash);
        if (!before) throw new Error('history: canonical predecessor missing/substituted');
        const revision = appendIdentityTransaction(home, { ...args, idempotencyKey: `canonical-revision:${args.idempotencyKey}`, operation: 'append_canonical_defect', request: args, validate: historyValidator,
          prepare: (_ledger, _signer, signing) => {
            const current = canonicalCurrent(readCanonicalCatalog(home).input, before.record.recordId);
            if (current.superseded) throw new Error('history: canonical predecessor already superseded');
            const { storyId: _story, idempotencyKey: _key, predecessor: _ref, reason: _reason, ...fields } = args;
            const { rootCause: _oldCause, ...old } = before.envelope.payload;
            const base = { ...old, ...fields, canonicalDefectId: `defect:${randomUUID()}`, confirmedAt: signing.producedAt, confirmedBy: actor };
            const { currentProjectionHash: _hash, ...unsigned } = base;
            const toHash = { ...unsigned, identityDigest: canonicalIdentityDigest(unsigned) };
            const corrected: CanonicalDefect = { ...toHash, currentProjectionHash: identityHash(toHash) };
            validateCanonicalDefect(corrected);
            return { records: [{ kind: 'canonical_revision', payload: corrected }], referencedRecords: args.predecessor.storyId === args.storyId ? [before.record] : [], validate: historyValidator,
              revalidate: () => { reviewer(home, args.storyId, args.reviewRunId, args.evidenceAnchors); if (canonicalCurrent(readCanonicalCatalog(home).input, before.record.recordId).superseded) throw new Error('history: canonical predecessor moved'); } };
          } });
        const after = revision.rows[0]!; const afterPayload = after.envelope.payload; validateCanonicalDefect(afterPayload);
        return appendIdentityTransaction(home, { ...args, idempotencyKey: `canonical-link:${args.idempotencyKey}`, operation: 'append_canonical_defect_supersession', request: args, validate: historyValidator,
          prepare: (_ledger, _signer, signing) => {
            const base = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const,
              kind: 'canonical_defect_supersession' as const, supersessionId: `canonical-supersession:${randomUUID()}`, predecessor: args.predecessor,
              successor: { storyId: args.storyId, recordId: after.record.recordId, recordHash: exactLedgerRecordHash(after.record) },
              predecessorEntityId: before.envelope.payload.canonicalDefectId, successorEntityId: afterPayload.canonicalDefectId,
              reason: args.reason, evidenceRefs: sortedUnique(args.identityEvidenceRefs), evidenceAnchors: args.evidenceAnchors, createdBy: actor, reviewRunId: args.reviewRunId, effectiveAt: signing.producedAt };
            const link: HistorySupersession = { ...base, recordHash: identityHash(base) }; validateSupersession(link);
            const prove = () => { reviewer(home, args.storyId, args.reviewRunId, args.evidenceAnchors); if (canonicalCurrent(readCanonicalCatalog(home).input, before.record.recordId).superseded) throw new Error('history: canonical fork refused'); };
            prove(); return { records: [{ kind: 'canonical_defect_supersession', payload: link }], referencedRecords: [...(args.predecessor.storyId === args.storyId ? [before.record] : []), after.record], validate: historyValidator, revalidate: prove };
          } });
      }));
    },
  };
}
