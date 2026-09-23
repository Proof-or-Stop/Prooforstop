import {reportHealthIssue} from './health.js';
import {isVerifiedEvidenceRefreshCommit, isOwnerLeaseHeartbeatOnly} from './review-evidence-refresh.js';
/** Narrow writer/consumer compatibility for authenticated review bookkeeping. */
import { execFileSync } from 'node:child_process';
import { REVIEW_MAINTENANCE_GIT_MAX_BUFFER_BYTES } from './runtime-fact-registry.js';
import { relative } from 'node:path';
import { realpathSync } from 'node:fs';
import { StoryStore } from './store.js';
import { matchesRuntimeCommitSubject } from './auto-commit-metadata.js';
import { REVIEW_EPOCH_COMMIT_ARTIFACTS, isMissingReviewSnapshotError } from './review-metadata-surface.js';
import { isPromptBodyArtifactPath } from './prompt-body-store.js';
import { verifyReviewInventoryEpoch, verifyReviewInventoryReceipt } from './review-inventory-epoch.js';
import { digestCanonicalJson } from './digest.js';
import { CERTIFICATION_WINDOW_FILE, CERTIFICATION_WINDOW_FILE_SCHEMA, PRECERT_RECEIPT_SCHEMA, verifyCertificationWindow, verifyPrecertReceipt, verifyPrecertCheapCheckReceipt, isCertificationRunningOnlyAdvance, type CertificationWindowData } from './certification-window.js';
import { CLOSEOUT_WRITE_RECEIPTS_PATH, closeoutArtifactPolicyFor, verifyCloseoutWriteReceipt, type CloseoutWriteReceipt } from './closeout-trust.js';
import { evaluatePersistedReviewToTestIndexTransition } from './review-test-index-transition.js';
import type { ReviewInventoryEpochData } from './types.js';

export function isVerifiedReviewMaintenanceCommit(args: {
  gitCwd: string; metadataRoot: string; storyId: string; commit: string; reviewedHeadHash: string; reviewedMaterialHash?: string; reviewedStoryFilesHash?: string;
}): boolean {
  const { gitCwd, metadataRoot, storyId, commit, reviewedHeadHash } = args;
  const git = (argv: string[]) => execFileSync('git', argv, { cwd: gitCwd, encoding: 'utf8', maxBuffer: REVIEW_MAINTENANCE_GIT_MAX_BUFFER_BYTES, stdio: ['ignore','pipe','pipe'] }).trim();
  try {
    const store = new StoryStore(metadataRoot);
    const prefix = relative(realpathSync(gitCwd), realpathSync(store.storyDirPath(storyId))).replaceAll('\\','/') + '/';
    if (prefix.startsWith('../') || prefix.startsWith('/') || prefix === './') return false;
    const parents = git(['show','-s','--format=%P',commit]).split(/\s+/);
    if (parents.length !== 1 || !parents[0]) return false;
    const subject = git(['show','-s','--format=%s',commit]);
    const paths = git(['diff-tree','--no-commit-id','--name-only','-r',commit]).split('\n').filter(Boolean);
    if (!paths.length || paths.some(p => !p.startsWith(prefix))) return false;
    const artifacts = paths.map(p => p.slice(prefix.length));
    const readAt = (ref: string, name: string) => JSON.parse(git(['show',`${ref}:${prefix}${name}`]));
    if (matchesRuntimeCommitSubject(subject, `record ${storyId} review epoch metadata`)) {
      if (!artifacts.includes('review-inventory-epochs.json') || artifacts.some(p =>
        !(REVIEW_EPOCH_COMMIT_ARTIFACTS as readonly string[]).includes(p) && !isPromptBodyArtifactPath(p))) return false;
      const data = readAt(commit,'review-inventory-epochs.json') as ReviewInventoryEpochData;
      const epoch = data.epochs.at(-1);
      if (!epoch || epoch.storyId !== storyId || epoch.state !== 'FINALIZED' || !verifyReviewInventoryEpoch(epoch)
        || (args.reviewedMaterialHash !== undefined && epoch.cutoff.materialHash !== args.reviewedMaterialHash)
        || (args.reviewedStoryFilesHash !== undefined && epoch.cutoff.storyFilesHash !== args.reviewedStoryFilesHash)) return false;
      if (epoch.cutoff.headHash !== reviewedHeadHash && (!args.reviewedMaterialHash || !args.reviewedStoryFilesHash)) return false;
      // An OPEN epoch freezes the cutoff before its reviewers; a direct
      // finalize freezes it after managed reviewer imports. Both are valid on
      // one ancestry chain. The outer live-binding reader separately verifies
      // each intervening importer commit. A sibling cutoff is never admitted.
      const isAncestor = (older: string, newer: string): boolean => {
        try { git(['merge-base','--is-ancestor',older,newer]); return true; }
        catch (error) {
          if (error && typeof error === 'object' && 'status' in error && error.status === 1) return false;
          throw error;
        }
      };
      if (!isAncestor(reviewedHeadHash,parents[0])
        || !isAncestor(epoch.cutoff.headHash,parents[0])
        || (!isAncestor(epoch.cutoff.headHash,reviewedHeadHash)
          && !isAncestor(reviewedHeadHash,epoch.cutoff.headHash))) return false;
      if (artifacts.includes('process-metrics.json')) {
        const metrics = readAt(commit,'process-metrics.json');
        if (metrics.storyId !== storyId || typeof metrics.generatedAt !== 'string' || !metrics.sourceSnapshot || !metrics.dimensions) return false;
      }
      const receipt = data.receipts.find(r => r.receiptId === epoch.receiptId);
      if (!receipt || !verifyReviewInventoryReceipt(receipt) || receipt.invalidatedAt
        || receipt.storyId !== storyId || receipt.epochId !== epoch.epochId
        || receipt.reviewRound !== epoch.reviewRound || receipt.scopeDigest !== epoch.scopeDigest
        || digestCanonicalJson(receipt.requiredLanes) !== digestCanonicalJson(epoch.requiredLanes) || digestCanonicalJson(receipt.cutoff) !== digestCanonicalJson(epoch.cutoff)) return false;
      // A copied signed epoch under a forged publisher subject is not a new publication.
      let previous: ReviewInventoryEpochData | undefined;
      try { git(['cat-file','-e',`${parents[0]}:${prefix}review-inventory-epochs.json`]);
        previous = readAt(parents[0],'review-inventory-epochs.json');
      } catch (error) {
        // Only a missing file is an initial publication; malformed existing data fails closed.
        try { git(['cat-file','-e',`${parents[0]}:${prefix}review-inventory-epochs.json`]); return false; } catch { /* absent */ }
      }
      if (previous?.epochs.some(e => e.epochId === epoch.epochId && e.state !== 'OPEN')) return false;
      // Only the authenticated terminal target may be newly appended. Prefix
      // preservation alone must not admit unrelated unsigned history rows.
      const priorEpochs = previous?.epochs ?? [];
      const priorReceipts = previous?.receipts ?? [];
      if (data.epochs.length !== priorEpochs.length + (priorEpochs.some(row => row.epochId === epoch.epochId) ? 0 : 1)
        || data.receipts.length !== priorReceipts.length + (priorReceipts.some(row => row.receiptId === receipt.receiptId) ? 0 : 1)) return false;
      if (previous && (digestCanonicalJson(data.epochs.slice(0,previous.epochs.length))
        !== digestCanonicalJson(previous.epochs.map(row => row.epochId === epoch.epochId ? epoch : row))
        || digestCanonicalJson(data.receipts.slice(0,previous.receipts.length)) !== digestCanonicalJson(previous.receipts))) return false;
      // Finalization may append independent review records; it cannot erase or
      // rewrite earlier observations under the batch publisher's subject.
      for (const [path,key] of [['review-runs.json','runs'],['review-passes.json','passes'],['findings.json','findings'],['prompt-envelopes.json','envelopes'],['finding-ledger.json','records'],['finding-ledger.json','receipts'],['convergence-progress.json','completedEpochBindings'],['convergence-progress.json','revokedCompletedEpochIds'],['convergence-progress.json','humanDecisions']]) {
        if (!artifacts.includes(path)) continue;
        const next = readAt(commit,path);
        const prior = git(['ls-tree','--name-only',parents[0],'--',prefix + path]) ? readAt(parents[0],path) : {[key]:[]};
        if (path === 'convergence-progress.json' && key === 'humanDecisions') { next[key] ??= []; prior[key] ??= []; }
        if (!Array.isArray(next[key]) || !Array.isArray(prior[key])
          || digestCanonicalJson(next[key].slice(0,prior[key].length)) !== digestCanonicalJson(prior[key])) return false;
      }
      const current = store.readReviewInventoryEpochs(storyId);
      const live = current.epochs.find(e => e.epochId === epoch.epochId);
      const liveReceipt = current.receipts.find(r => r.receiptId === receipt.receiptId);
      return !!live && verifyReviewInventoryEpoch(live) && live.state === 'FINALIZED'
        && !!liveReceipt && verifyReviewInventoryReceipt(liveReceipt) && !liveReceipt.invalidatedAt
        && liveReceipt.epochId === epoch.epochId && liveReceipt.storyId === storyId
        && liveReceipt.reviewRound === epoch.reviewRound && digestCanonicalJson(liveReceipt.cutoff) === digestCanonicalJson(receipt.cutoff)
        && live.receiptId === receipt.receiptId && digestCanonicalJson(live.cutoff) === digestCanonicalJson(epoch.cutoff);
    }
    if (matchesRuntimeCommitSubject(subject, `record ${storyId} verification_evidence_add metadata`)) {
      return isVerifiedEvidenceRefreshCommit({...args,isProtectedArtifact:closeoutArtifactPolicyFor});
    }
    // Official certification and validation publications retain code review only.
    // Their specialized gates still decide whether certification/validation passes.
    const writer = ['certification_window_begin', 'validate', 'test-transition'].find(command =>
      matchesRuntimeCommitSubject(subject, `record ${storyId} ${command} metadata`));
    if (!writer) return false;
    // Bookkeeping never supplies a validation verdict here. Require parseable,
    // subject-bound projections; owner-lease changes retain only an unchanged owner and a heartbeat/PID update.
    const incidental = new Set(['process-events.jsonl', 'process-metrics.json', 'test-runs.json', 'owner-lease.json']);
    if (artifacts.some(path => incidental.has(path) && closeoutArtifactPolicyFor(path))) return false;
    if (artifacts.includes('owner-lease.json') && (!git(['ls-tree','--name-only',parents[0],'--',prefix + 'owner-lease.json'])
      || !isOwnerLeaseHeartbeatOnly(readAt(parents[0],'owner-lease.json'),readAt(commit,'owner-lease.json')))) return false;
    if (artifacts.includes('process-metrics.json')) {
      const metrics = readAt(commit,'process-metrics.json');
      if (metrics.storyId !== storyId || typeof metrics.generatedAt !== 'string' || !metrics.sourceSnapshot || !metrics.dimensions) return false;
    }
    if (artifacts.includes('test-runs.json')) {
      const runs = readAt(commit,'test-runs.json').runs;
      if (!Array.isArray(runs) || runs.some(row => !row || typeof row.timestamp !== 'string' || typeof row.command !== 'string'
        || !['PASS','FAIL'].includes(row.result) || ['totalCases','passedCases','failedCases','durationMs'].some(key => !Number.isFinite(row[key]) || row[key] < 0)
        || row.totalCases !== row.passedCases + row.failedCases)) return false;
    }
    const substantive = artifacts.filter(path => !incidental.has(path) && path !== CLOSEOUT_WRITE_RECEIPTS_PATH);
    if (!substantive.length) return false;
    const priorExists = (path: string) => Boolean(git(['ls-tree','--name-only',parents[0],'--',prefix + path]));
    const rawAt = (ref: string, path: string) => execFileSync('git',['show',`${ref}:${prefix}${path}`], { cwd: gitCwd, encoding: 'utf8', maxBuffer: REVIEW_MAINTENANCE_GIT_MAX_BUFFER_BYTES, stdio: ['ignore','pipe','pipe'] });
    const readReceipts = (ref: string): CloseoutWriteReceipt[] => rawAt(ref,CLOSEOUT_WRITE_RECEIPTS_PATH).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const priorReceipts = priorExists(CLOSEOUT_WRITE_RECEIPTS_PATH) ? readReceipts(parents[0]) : [];
    const receipts = artifacts.includes(CLOSEOUT_WRITE_RECEIPTS_PATH) ? readReceipts(commit) : priorReceipts;
    if (digestCanonicalJson(receipts.slice(0,priorReceipts.length)) !== digestCanonicalJson(priorReceipts)) return false;
    const addedReceipts = receipts.slice(priorReceipts.length);
    const closeoutPaths = substantive.filter(path => closeoutArtifactPolicyFor(path)?.artifactClass === 'closeout-evidence');
    if (addedReceipts.length !== closeoutPaths.length) return false;
    for (const path of substantive) {
      if (path === CERTIFICATION_WINDOW_FILE) {
        if (writer === 'test-transition') return false;
        const after = readAt(commit,path) as CertificationWindowData;
        const before: CertificationWindowData = priorExists(path) ? readAt(parents[0],path) as CertificationWindowData : {schemaVersion:CERTIFICATION_WINDOW_FILE_SCHEMA,windows:[],receipts:[]};
        if (after.schemaVersion !== CERTIFICATION_WINDOW_FILE_SCHEMA || !Array.isArray(after.windows) || !Array.isArray(after.receipts)) return false;
        if (after.windows.some(window => window.storyId !== storyId || !verifyCertificationWindow(window))) return false;
        if (after.receipts.some(receipt => receipt.storyId !== storyId || !(receipt.schemaVersion === PRECERT_RECEIPT_SCHEMA ? verifyPrecertReceipt(receipt) : verifyPrecertCheapCheckReceipt(receipt)))) return false;
        if (isCertificationRunningOnlyAdvance(before,after,storyId)) continue;
        // Admission and cheap checks append to existing history; they cannot
        // rewrite an earlier window or replace a prior receipt.
        if (digestCanonicalJson(after.windows.slice(0,before.windows.length)) !== digestCanonicalJson(before.windows)
          || digestCanonicalJson(after.receipts.slice(0,before.receipts.length)) !== digestCanonicalJson(before.receipts)) return false;
        if (writer === 'certification_window_begin') {
          if (after.windows.length !== before.windows.length + 1) return false;
          const window = after.windows.at(-1)!;
          if (window.state === 'BLOCKED') {
            // A refused begin publishes diagnostics, not admission. Preserve the
            // review lineage so its prescribed cheap-check retry can use the
            // same finalized inventory. Never accept heavy authority here.
            const diagnosticKeys = new Set(['schemaVersion', 'windowId', 'storyId', 'state',
              'createdAt', 'updatedAt', 'blockerCode', 'blockerDetail', 'inventory', '_hash']);
            if (Object.keys(window).some(key => !diagnosticKeys.has(key))
              || !window.blockerCode?.trim() || !window.blockerDetail?.trim()
              || after.receipts.slice(before.receipts.length).some(row => row.schemaVersion === PRECERT_RECEIPT_SCHEMA)
              || substantive.some(path => path !== CERTIFICATION_WINDOW_FILE)) return false;
            continue;
          }
          if (window.state !== 'ADMITTED') return false;
          const receipt = after.receipts.find(row => row.receiptId === window.receiptId);
          if (!receipt || receipt.schemaVersion !== PRECERT_RECEIPT_SCHEMA || receipt.windowId !== window.windowId
            || digestCanonicalJson(receipt.frozen) !== digestCanonicalJson(window.frozen)) return false;
        } else if (after.windows.length !== before.windows.length || after.receipts.length <= before.receipts.length
          || after.receipts.slice(before.receipts.length).some(row => row.schemaVersion === PRECERT_RECEIPT_SCHEMA)) return false;
        continue;
      }
      if (path === 'review-inventory-epochs.json') {
        if (writer !== 'certification_window_begin' || !artifacts.includes(CERTIFICATION_WINDOW_FILE)) return false;
        const before = readAt(parents[0],path) as ReviewInventoryEpochData;
        const after = readAt(commit,path) as ReviewInventoryEpochData;
        const window = (readAt(commit,CERTIFICATION_WINDOW_FILE) as CertificationWindowData).windows.at(-1);
        if (!window || window.state !== 'ADMITTED' || !verifyCertificationWindow(window)) return false;
        const epoch = after.epochs.find(row => row.epochId === window.inventory?.epochId);
        const receipt = after.receipts.find(row => row.receiptId === window.inventory?.receiptId);
        const oldEpoch = before.epochs.find(row => row.epochId === epoch?.epochId);
        const oldReceipt = before.receipts.find(row => row.receiptId === receipt?.receiptId);
        if (!epoch || !receipt || !oldEpoch || !oldReceipt || oldEpoch.consumedAt || oldReceipt.consumedAt
          || !verifyReviewInventoryEpoch(epoch) || !verifyReviewInventoryReceipt(receipt)
          || epoch.storyId !== storyId || receipt.storyId !== storyId || epoch.state !== 'FINALIZED' || receipt.invalidatedAt
          || !epoch.consumedAt || epoch.consumedAt !== receipt.consumedAt
          || epoch.consumedByCertificationWindowId !== window.windowId || receipt.consumedByCertificationWindowId !== window.windowId
          || epoch.consumedByReviewRound !== epoch.reviewRound) return false;
        const expected = {...before,
          epochs:before.epochs.map(row => row.epochId === epoch.epochId ? {...row,consumedAt:epoch.consumedAt,consumedByCertificationWindowId:window.windowId,consumedByReviewRound:row.reviewRound,updatedAt:epoch.consumedAt,_hash:epoch._hash} : row),
          receipts:before.receipts.map(row => row.receiptId === receipt.receiptId ? {...row,consumedAt:epoch.consumedAt,consumedByCertificationWindowId:window.windowId,_hash:receipt._hash} : row)};
        if (digestCanonicalJson(after) !== digestCanonicalJson(expected)) return false;
        continue;
      }
      if (path === 'index.json') {
        if (writer !== 'test-transition') return false;
        const after = readAt(commit,path);
        if (!evaluatePersistedReviewToTestIndexTransition(gitCwd,prefix + path,
          {headHash:parents[0],storyId,reviewRound:readAt(reviewedHeadHash,'index.json').currentReviewRound},after).ok) return false;
        continue;
      }
      if (writer !== 'validate' || !closeoutPaths.includes(path)) return false;
      const matching = addedReceipts.filter(receipt => receipt.artifactPath === path);
      const receipt = matching[0];
      if (matching.length !== 1 || receipt.writerCommand !== writer || receipt.headHash !== parents[0]
        || !verifyCloseoutWriteReceipt(receipt,{storyId,artifactPath:path,artifactBytes:rawAt(commit,path),projectRoot:gitCwd,metadataRoot}).ok) return false;
      const prior = priorReceipts.filter(row => row.artifactPath === path).at(-1);
      if (receipt.sequence !== (prior?.sequence ?? 0) + 1 || receipt.previousIntegrityHash !== (prior?.integrityHash ?? null)) return false;
    }
    return true;
  } catch (error) {
    if (!isMissingReviewSnapshotError(error))
      reportHealthIssue('review-maintenance-lineage',error instanceof Error ? error : {message:String(error)},{storyId});
    return false;
  }
}
