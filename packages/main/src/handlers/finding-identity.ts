/** Candidate IO and reviewer promotion. No Finding/gate mutation is performed. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import { candidateAddSchema, candidateGetSchema, candidateMergeSchema, candidateDisproveSchema, candidatePromoteSchema,
  parseIdentityInput, sourceLineageKeys, candidateSuggestionKey, sortedUnique, sealCandidate, transitionCandidate,
  validateCandidate, validateSignal, identityHash, identityConfirmSchema, identityQuerySchema, assertCauseEvidence,
  validateCanonicalDefect, buildConfirmedCanonicalDefect, materializeCandidateReproductionCommand,
  validateCandidateReproductionAttestation } from '../core/finding-identity.js';
import type { CandidateFinding, CandidateReproductionAttestation, DetectorSignal } from '../core/finding-identity-types.js';
import { appendIdentityTransaction, readIdentityRows, verifiedIdentityCarrier, identityTrust, identitySourceSnapshot,
  assertIdentityAnchorsCurrent, identityStoryContext, withIdentityLedgerLocks, verifiedFindingRef, withIdentityCatalogLock, readCanonicalCatalog, type VerifiedIdentityRow } from './finding-identity-store.js';
import { canonicalCurrent } from '../core/finding-history.js';
import { currentFindingIdentityResolver } from './finding-identity-store.js';
import { resolveCandidateMutationAuthority, type CandidateMutationCommand } from '../core/agent-dispatch-registry.js';
import { assertCurrentReviewRunForEvidence } from '../core/review-run.js';
import { verifyFinding } from '../core/finding-verify.js';
import { verifyCausalEvidenceReceipt } from '../core/causal-evidence.js';
import { currentStoryFilesHash } from '../core/evidence-freshness.js';
import { exactLedgerRecordHash } from './finding-ledger.js';
import { readOwnerLease, isOwnedByCurrentSession } from '../core/story-owner-lease.js';
import type { Finding } from '../core/types.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';

const KINDS = ['detector_signal', 'candidate', 'candidate_reproduction_attestation'] as const;
export function validateCandidatePayload(kind: string, payload: unknown): void {
  if (kind === 'candidate') validateCandidate(payload);
  else if (kind === 'detector_signal') validateSignal(payload);
  else if (kind === 'candidate_reproduction_attestation') validateCandidateReproductionAttestation(payload);
  else throw new Error(`identity: unexpected candidate record kind ${kind}`);
}
export function readCandidates(ctx: HandlerContext, storyId: string): { signals: VerifiedIdentityRow<DetectorSignal>[]; candidates: VerifiedIdentityRow<CandidateFinding>[];
  attestations: VerifiedIdentityRow<CandidateReproductionAttestation>[] } {
  const rows = readIdentityRows<CandidateFinding | CandidateReproductionAttestation | DetectorSignal>(ctx, storyId, KINDS, validateCandidatePayload);
  const signals = rows.filter(row => row.envelope.kind === 'detector_signal') as VerifiedIdentityRow<DetectorSignal>[];
  const versions = rows.filter(row => row.envelope.kind === 'candidate') as VerifiedIdentityRow<CandidateFinding>[];
  const attestations = rows.filter(row => row.envelope.kind === 'candidate_reproduction_attestation') as VerifiedIdentityRow<CandidateReproductionAttestation>[];
  const latest = new Map<string, VerifiedIdentityRow<CandidateFinding>>();
  for (const row of versions) {
    const candidate = row.envelope.payload; const prior = latest.get(candidate.candidateId);
    if (candidate.targetStoryId !== storyId || (prior ? candidate.previousVersionHash !== prior.envelope.payload.currentProjectionHash : candidate.previousVersionHash !== undefined)) throw new Error('identity: missing/forked candidate predecessor');
    if (prior && prior.envelope.payload.state !== 'pending_verification') throw new Error('identity: terminal candidate rewritten');
    const refs = candidate.sourceSignalIds.map(id => signals.find(signal => signal.envelope.payload.signalId === id));
    if (refs.some(row => !row) || refs.some(row => row!.envelope.payload.targetStoryId !== storyId)) throw new Error('identity: candidate signal lineage missing/wrong target');
    if (identityHash(candidate.sourceLineageKeys) !== identityHash(sortedUnique(refs.flatMap(row => row!.envelope.payload.sourceLineageKeys)))) throw new Error('identity: candidate source lineage changed');
    latest.set(candidate.candidateId, row);
  }
  for (const row of attestations) {
    const attestation = row.envelope.payload;
    const source = versions.find(candidate => candidate.envelope.payload.candidateId === attestation.candidateId
      && candidate.envelope.payload.currentProjectionHash === attestation.candidateProjectionHash);
    if (attestation.targetStoryId !== storyId || !source || !source.envelope.payload.reproductionContract
      || identityHash(source.envelope.payload.reproductionContract) !== attestation.reproductionContractHash) {
      throw new Error('identity: candidate reproduction attestation source mismatch');
    }
  }
  return { signals, candidates: [...latest.values()], attestations };
}
function assertActor(ctx: HandlerContext, storyId: string, command: CandidateMutationCommand): string {
  const story = ctx.store.readStory(storyId);
  const actor = resolveCandidateMutationAuthority(command, story.phase);
  if (realpathSync(ctx.store.projectRoot) !== realpathSync(ctx.root)) throw new Error('identity: store/workspace root mismatch');
  if (storyId.startsWith('B-META-') && realpathSync(ctx.root) !== realpathSync(resolveMainRepoRoot(ctx.root))) throw new Error('identity: B-META requires canonical metadata root');
  if (command !== 'finding_candidate_promote' && !storyId.startsWith('B-META-')
    && (!readOwnerLease(ctx.store.storyDirPath(storyId)) || !isOwnedByCurrentSession(ctx.store.storyDirPath(storyId)))) throw new Error('identity: candidate mutation requires the Story owner lease');
  return actor;
}
function currentCandidate(ctx: HandlerContext, storyId: string, candidateId: string, hash: string): VerifiedIdentityRow<CandidateFinding> {
  const row = readCandidates(ctx, storyId).candidates.find(row => row.envelope.payload.candidateId === candidateId);
  if (!row || row.envelope.payload.currentProjectionHash !== hash) throw new Error('identity: candidate missing or expected hash mismatch');
  if (row.envelope.payload.state !== 'pending_verification') throw new Error('identity: unsupported terminal transition');
  return row;
}
function projection(result: ReturnType<typeof appendIdentityTransaction>) {
  return { ...result, gateEvidence: false as const, authority: 'non_authoritative' as const,
    candidates: result.rows.filter(row => row.envelope.kind === 'candidate').map(row => {
      validateCandidate(row.envelope.payload);
      return { ...row.envelope.payload, recordId: row.record.recordId };
    }) };
}
export function createFindingIdentityHandlers(ctx: HandlerContext) {
  return {
    finding_identity_confirm(input: unknown) {
      const args = parseIdentityInput(identityConfirmSchema, input); assertCauseEvidence(args);
      const actor = assertActor(ctx, args.storyId, 'finding_candidate_promote');
      const members = args.memberFindingRefs.map(ref => ({ ref, ctx: identityStoryContext(ctx, ref.storyId) }));
      return withIdentityCatalogLock(ctx, () => withIdentityLedgerLocks([{ ctx, storyId: args.storyId }, ...members.map(row => ({ ctx: row.ctx, storyId: row.ref.storyId }))], () =>
        appendIdentityTransaction(ctx, { ...args, operation: 'append_canonical_defect', request: args,
          validate: (_kind, value) => validateCanonicalDefect(value), prepare: () => {
            const prove = () => {
              assertCurrentReviewRunForEvidence(ctx.store, ctx.store.readStory(args.storyId), ctx.root, actor, args.reviewRunId);
              assertIdentityAnchorsCurrent(ctx, args.evidenceAnchors);
              return members.map(row => verifiedFindingRef(row.ctx, row.ref));
            };
            const verified = prove();
            const refs = [...args.memberFindingRefs].sort((a, b) => a.recordId.localeCompare(b.recordId));
            const catalog = readCanonicalCatalog(ctx);
            const currentFinding = currentFindingIdentityResolver(ctx);
            const existing = catalog.rows.filter(row => !canonicalCurrent(catalog.input, row.record.recordId).superseded);
            if (existing.some(row => (row.envelope.payload as unknown as import('../core/finding-identity-types.js').CanonicalDefect).memberFindingRefs.some(ref => refs.some(member => currentFinding(member).recordId === currentFinding(ref).recordId)))) {
              throw new Error('identity: member already confirmed; use original idempotency key or signed supersession');
            }
            const sources = members.flatMap(({ ctx: source, ref }) => readCandidates(source, ref.storyId).candidates
              .filter(row => row.envelope.payload.promotionFindingRef?.recordId === ref.recordId)
              .flatMap(row => row.envelope.payload.sourceLineageKeys));
            const canonical = buildConfirmedCanonicalDefect(args, { canonicalDefectId: `defect:${randomUUID()}`,
              confirmedBy: actor, confirmedAt: new Date().toISOString(), sourceLineageKeys: sources });
            return { records: [{ kind: 'canonical_defect', payload: canonical }], referencedRecords: verified.filter((_, i) => members[i]!.ref.storyId === args.storyId).map(row => row.record),
              validate: (_kind, value) => validateCanonicalDefect(value), revalidate: () => { prove(); } };
          } })));
    },
    finding_identity_query(input: unknown) {
      const args = parseIdentityInput(identityQuerySchema, input); ctx.store.readStory(args.storyId);
      const catalog = readCanonicalCatalog(ctx);
      const requested = catalog.rows.find(row => row.envelope.payload.canonicalDefectId === args.canonicalDefectId);
      if (args.canonicalDefectId && !requested) throw new Error('identity: canonical identity missing');
      const selected = requested ? [canonicalCurrent(catalog.input, requested.record.recordId).current.ref!.recordId]
        : catalog.rows.filter(row => row.envelope.storyId === args.storyId && !canonicalCurrent(catalog.input, row.record.recordId).superseded).map(row => row.record.recordId);
      const confirmed = catalog.rows.filter(row => selected.includes(row.record.recordId));
      const candidates = readCandidates(ctx, args.storyId).candidates;
      const groups = new Map<string, string[]>();
      for (const row of candidates) { const c = row.envelope.payload; groups.set(c.candidateGroupKey, [...(groups.get(c.candidateGroupKey) ?? []), c.candidateId]); }
      return { authority: 'non_authoritative', gateEvidence: false, suggested: [...groups].map(([suggestionKey, candidateIds]) => ({ identityState: 'suggested', suggestionKey, candidateIds })),
        reviewer_confirmed: confirmed, current: confirmed.map(row => ({ ...row.envelope.payload,
          predecessors: canonicalCurrent(catalog.input, row.record.recordId).predecessors.map(node => ({ ref: node.ref, canonicalDefectId: node.entityId })) })),
        ...(args.includeSuperseded ? { history: catalog.rows, pending: catalog.pending.map(row => ({ ...row, current: false, status: 'pending_unlinked_revision' })) } : {}) };
    },
    finding_candidate_add(input: unknown) {
      const args = parseIdentityInput(candidateAddSchema, input);
      assertActor(ctx, args.storyId, 'finding_candidate_add');
      return projection(appendIdentityTransaction(ctx, { ...args, operation: 'append_candidate', request: args, validate: validateCandidatePayload,
        prepare: () => {
          const snapshot = identitySourceSnapshot(ctx); assertIdentityAnchorsCurrent(ctx, args.signal.anchors);
          const signalBase = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const,
            ...args.signal, sourceIds: sortedUnique(args.signal.sourceIds), signalId: `signal:${randomUUID()}`, observedAt: new Date().toISOString(), targetStoryId: args.storyId, ...snapshot };
          const signal: DetectorSignal = { ...signalBase, sourceLineageKeys: sourceLineageKeys(signalBase) };
          const candidate = sealCandidate({ schemaVersion: 1, authority: 'non_authoritative', gateEvidence: false,
            candidateId: `candidate:${randomUUID()}`, targetStoryId: args.storyId, sourceSignalIds: [signal.signalId],
            sourceLineageKeys: signal.sourceLineageKeys, suspectedDefect: args.candidate.suspectedDefect,
            affectedSymbols: sortedUnique(args.candidate.affectedSymbols), affectedContracts: sortedUnique(args.candidate.affectedContracts),
            candidateGroupKey: candidateSuggestionKey(args.candidate), state: 'pending_verification',
            currentEvidenceRefs: sortedUnique(args.candidate.evidenceRefs), sourceBindings: signal.anchors,
            reproductionContract: args.candidate.reproductionContract });
          return { records: [{ kind: 'detector_signal', payload: signal }, { kind: 'candidate', payload: candidate }], referencedRecords: [], validate: validateCandidatePayload,
            revalidate: () => { assertActor(ctx, args.storyId, 'finding_candidate_add'); assertIdentityAnchorsCurrent(ctx, signal.anchors);
              if (identityHash(snapshot) !== identityHash(identitySourceSnapshot(ctx))) throw new Error('identity: source snapshot changed before append'); } };
        } }));
    },
    finding_candidate_get(input: unknown) {
      const args = parseIdentityInput(candidateGetSchema, input); ctx.store.readStory(args.storyId);
      const current = readCandidates(ctx, args.storyId);
      const candidates = current.candidates.filter(row => !args.candidateId || row.envelope.payload.candidateId === args.candidateId);
      if (args.candidateId && candidates.length !== 1) throw new Error('identity: candidate not found');
      return { storyId: args.storyId, authority: 'non_authoritative', gateEvidence: false,
        candidates: candidates.map(row => ({ ...row.envelope.payload, recordId: row.record.recordId, envelope: row.envelope, ledgerReceipt: row.receipt })),
        signals: current.signals.map(row => ({ ...row.envelope.payload, recordId: row.record.recordId })),
        attestations: current.attestations.filter(row => !args.candidateId || row.envelope.payload.candidateId === args.candidateId)
          .map(row => ({ ...row.envelope.payload, recordId: row.record.recordId, envelope: row.envelope, ledgerReceipt: row.receipt })) };
    },
    finding_candidate_merge(input: unknown) {
      const args = parseIdentityInput(candidateMergeSchema, input); assertActor(ctx, args.storyId, 'finding_candidate_merge');
      if (args.candidateId === args.targetCandidateId) throw new Error('identity: self merge refused');
      return projection(appendIdentityTransaction(ctx, { ...args, operation: 'append_candidate', request: args, validate: validateCandidatePayload,
        prepare: () => {
          const source = currentCandidate(ctx, args.storyId, args.candidateId, args.expectedCandidateHash);
          const target = currentCandidate(ctx, args.storyId, args.targetCandidateId, args.expectedTargetHash);
          const before = source.envelope.payload; const into = target.envelope.payload;
          assertIdentityAnchorsCurrent(ctx, [...before.sourceBindings, ...into.sourceBindings, ...args.evidenceAnchors]);
          const merged = transitionCandidate(before, 'merged', { reason: args.reason, evidenceRefs: args.evidenceRefs, evidenceAnchors: args.evidenceAnchors }, { mergedIntoCandidateId: into.candidateId });
          const { currentProjectionHash, ...base } = into;
          const fields = { affectedContracts: sortedUnique([...into.affectedContracts, ...before.affectedContracts]), affectedSymbols: sortedUnique([...into.affectedSymbols, ...before.affectedSymbols]) };
          const updated = sealCandidate({ ...base, ...fields, candidateGroupKey: candidateSuggestionKey(fields), previousVersionHash: currentProjectionHash,
            sourceSignalIds: sortedUnique([...into.sourceSignalIds, ...before.sourceSignalIds]),
            sourceLineageKeys: sortedUnique([...into.sourceLineageKeys, ...before.sourceLineageKeys]),
            currentEvidenceRefs: sortedUnique([...into.currentEvidenceRefs, ...before.currentEvidenceRefs, ...args.evidenceRefs]),
            sourceBindings: [...into.sourceBindings, ...before.sourceBindings, ...args.evidenceAnchors] });
          return { records: [{ kind: 'candidate', payload: merged }, { kind: 'candidate', payload: updated }], referencedRecords: [source.record, target.record], validate: validateCandidatePayload,
            revalidate: () => { assertActor(ctx, args.storyId, 'finding_candidate_merge'); assertIdentityAnchorsCurrent(ctx, updated.sourceBindings); } };
        } }));
    },
    finding_candidate_disprove(input: unknown) {
      const args = parseIdentityInput(candidateDisproveSchema, input); assertActor(ctx, args.storyId, 'finding_candidate_disprove');
      return projection(appendIdentityTransaction(ctx, { ...args, operation: 'append_candidate', request: args, validate: validateCandidatePayload,
        prepare: () => {
          const source = currentCandidate(ctx, args.storyId, args.candidateId, args.expectedCandidateHash);
          assertIdentityAnchorsCurrent(ctx, args.evidenceAnchors);
          const disproven = transitionCandidate(source.envelope.payload, 'disproven', { reason: args.reason, evidenceRefs: args.evidenceRefs, evidenceAnchors: args.evidenceAnchors });
          return { records: [{ kind: 'candidate', payload: disproven }], referencedRecords: [source.record], validate: validateCandidatePayload,
            revalidate: () => { assertActor(ctx, args.storyId, 'finding_candidate_disprove'); assertIdentityAnchorsCurrent(ctx, args.evidenceAnchors); } };
        } }));
    },
    finding_candidate_promote(input: unknown) {
      const args = parseIdentityInput(candidatePromoteSchema, input); const actor = assertActor(ctx, args.storyId, 'finding_candidate_promote');
      return projection(appendIdentityTransaction(ctx, { ...args, operation: 'append_candidate', request: args, validate: validateCandidatePayload,
        prepare: (ledger, _signer, signing) => {
          const source = currentCandidate(ctx, args.storyId, args.candidateId, args.expectedCandidateHash);
          const candidate = source.envelope.payload;
          const reproductionContract = candidate.reproductionContract;
          if (!reproductionContract) throw new Error('identity: missing preregistered reproduction receipt contract');
          const prove = () => {
            assertActor(ctx, args.storyId, 'finding_candidate_promote');
            const story = ctx.store.readStory(args.storyId);
            assertCurrentReviewRunForEvidence(ctx.store, story, ctx.root, actor, args.reviewRunId);
            assertIdentityAnchorsCurrent(ctx, candidate.sourceBindings);
            const finding = ctx.store.readFindings(args.storyId).findings.find(row => row.id === args.findingId);
            if (!finding || finding.evidenceState !== 'verified' || finding.status !== 'open' || finding.reviewRunId !== args.reviewRunId || !verifyFinding(args.storyId, finding)) throw new Error('identity: promotion requires current verified Finding from the same reviewer run');
            const record = ledger.records.find(row => row.recordType === 'finding' && (row.payload as unknown as Finding).id === finding.id);
            if (!record || finding.recordId !== record.recordId) throw new Error('identity: immutable Finding ledger identity missing');
            verifiedIdentityCarrier(ledger, args.storyId, record.recordId, identityTrust(ctx));
            const receipt = ctx.store.readCausalEvidenceReceipt(args.storyId, args.reproductionExecutionKey);
            const marker = `candidate-reproduced:${candidate.candidateId}:${candidate.currentProjectionHash}`;
            if (args.reproductionAttestation.selector !== reproductionContract.selector) throw new Error('identity: signed reproduction attestation selector does not match preregistered selector');
            const expectedCommand = materializeCandidateReproductionCommand(reproductionContract, marker);
            const snapshot = identitySourceSnapshot(ctx);
            const inputs = receipt?.identity.inputs as Record<string, unknown> | undefined;
            if (!receipt || receipt.receiptHash !== args.reproductionReceiptHash || !verifyCausalEvidenceReceipt(receipt, args.reproductionExecutionKey)
              || receipt.storyId !== args.storyId || receipt.status !== 'pass' || receipt.exitCode !== 0 || !receipt.reusable
              || identityHash(receipt.identity.command) !== identityHash(expectedCommand)
              || realpathSync(receipt.identity.cwd) !== realpathSync(ctx.root) || inputs?.materialHash !== snapshot.materialHash
              || receipt.identity.storyFilesHash !== currentStoryFilesHash(ctx.root, 'HEAD', ctx.root)
              || !receipt.outputProbe.split(/\r?\n/).includes(reproductionContract.selector)
              || !receipt.outputProbe.split(/\r?\n/).includes(marker) || !Number.isFinite(Date.parse(receipt.executedAt))
              || Date.parse(receipt.executedAt) < Date.parse(source.envelope.producedAt) || Date.parse(receipt.executedAt) > Date.now()) throw new Error('identity: missing/stale/wrong-subject signed reproduction receipt');
            return { record, receipt };
          };
          const evidence = prove();
          const findingRef = { storyId: args.storyId, findingId: args.findingId, recordId: evidence.record.recordId, recordHash: exactLedgerRecordHash(evidence.record) };
          const attestation: CandidateReproductionAttestation = { schemaVersion: 1, authority: 'non_authoritative', gateEvidence: false,
            attestationId: `candidate-reproduction-attestation:${randomUUID()}`, targetStoryId: args.storyId,
            candidateId: candidate.candidateId, candidateProjectionHash: candidate.currentProjectionHash,
            reproductionContract, reproductionContractHash: identityHash(reproductionContract),
            reproductionSelector: args.reproductionAttestation.selector, reproductionExecutionKey: args.reproductionExecutionKey,
            reproductionReceiptHash: args.reproductionReceiptHash, findingRef, reviewRunId: args.reviewRunId,
            reviewer: actor, semanticAssertion: args.reproductionAttestation.semanticAssertion,
            evidenceAnchors: candidate.sourceBindings, attestedAt: signing.producedAt };
          validateCandidateReproductionAttestation(attestation);
          const promoted = transitionCandidate(candidate, 'promoted', { reason: 'Current reviewer signed semantic reproduction attestation and linked its verified Finding.',
            evidenceRefs: [evidence.receipt.receiptHash, args.reviewRunId, attestation.attestationId], evidenceAnchors: candidate.sourceBindings },
            { promotionFindingRef: findingRef });
          return { records: [{ kind: 'candidate_reproduction_attestation', payload: attestation }, { kind: 'candidate', payload: promoted }],
            referencedRecords: [source.record, evidence.record], validate: validateCandidatePayload, revalidate: () => { prove(); } };
        } }));
    },
  };
}
