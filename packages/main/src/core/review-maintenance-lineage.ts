/** Narrow writer/consumer compatibility for authenticated review bookkeeping. */
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { realpathSync } from 'node:fs';
import { StoryStore } from './store.js';
import { matchesRuntimeCommitSubject } from './auto-commit-metadata.js';
import { REVIEW_EPOCH_COMMIT_ARTIFACTS } from './review-metadata-batch.js';
import { isPromptBodyArtifactPath } from './prompt-body-store.js';
import { verifyReviewInventoryEpoch, verifyReviewInventoryReceipt } from './review-inventory-epoch.js';
import { verifyCausalEvidenceReceipt, CAUSAL_RECEIPT_DIRECTORY, CAUSAL_RECEIPT_INDEX_FILE } from './causal-evidence.js';
import { hasMechanicalExecutionAuthority } from './verification-receipt-authority.js';
import { digestCanonicalJson } from './digest.js';
import type { ChecklistData, ReviewInventoryEpochData } from './types.js';

export function isVerifiedReviewMaintenanceCommit(args: {
  gitCwd: string; metadataRoot: string; storyId: string; commit: string; reviewedHeadHash: string;
}): boolean {
  const { gitCwd, metadataRoot, storyId, commit, reviewedHeadHash } = args;
  const git = (argv: string[]) => execFileSync('git', argv, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
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
        || epoch.cutoff.headHash !== reviewedHeadHash) return false;
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
      if (!artifacts.includes('checklist.json') || artifacts.some(p => p !== 'checklist.json' && p !== 'process-events.jsonl' && p !== 'owner-lease.json' && p !== CAUSAL_RECEIPT_INDEX_FILE
        && !/^causal-evidence\/(outputs|receipts)\/[a-f0-9]{64}\.json$/.test(p))) return false;
      for (const path of artifacts.filter(p => p.startsWith(CAUSAL_RECEIPT_DIRECTORY + '/'))) {
        const causal = readAt(commit,path);
        if (!verifyCausalEvidenceReceipt(causal) || causal.storyId !== storyId
          || path !== `${CAUSAL_RECEIPT_DIRECTORY}/${causal.receiptHash}.json`) return false;
      }
      if (artifacts.includes(CAUSAL_RECEIPT_INDEX_FILE)) {
        const index = readAt(commit,CAUSAL_RECEIPT_INDEX_FILE);
        if (index.schemaVersion !== 'proof-or-stop.causal-evidence-index.v1' || !index.receipts || typeof index.receipts !== 'object') return false;
        if (git(['ls-tree','--name-only',parents[0],'--',prefix + CAUSAL_RECEIPT_INDEX_FILE])) {
          const prior = readAt(parents[0],CAUSAL_RECEIPT_INDEX_FILE);
          if (!prior.receipts || Object.entries(prior.receipts).some(([key,hash]) => index.receipts[key] !== hash)) return false;
        }
        for (const [key, hash] of Object.entries(index.receipts)) {
          if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return false;
          const causal = readAt(commit,`${CAUSAL_RECEIPT_DIRECTORY}/${hash}.json`);
          if (!verifyCausalEvidenceReceipt(causal,key) || causal.storyId !== storyId || causal.receiptHash !== hash) return false;
        }
      }
      const before = readAt(parents[0],'checklist.json') as ChecklistData;
      const after = readAt(commit,'checklist.json') as ChecklistData;
      const withoutEvidence = (data: ChecklistData) => ({ ...data, items: data.items.map(({ verificationEvidence, ...item }) => item) });
      if (digestCanonicalJson(withoutEvidence(before)) !== digestCanonicalJson(withoutEvidence(after))) return false;
      let changed = false;
      for (const item of after.items) {
        const old = before.items.find(i => i.id === item.id);
        if ((old?.verificationEvidence ?? []).some(e => !(item.verificationEvidence ?? []).some(n => n.intentRef === e.intentRef))) return false;
        for (const evidence of item.verificationEvidence ?? []) {
          if ((old?.verificationEvidence ?? []).some(e => digestCanonicalJson(e) === digestCanonicalJson(evidence))) continue;
          changed = true;
          if (!hasMechanicalExecutionAuthority(store,storyId,item,evidence)) return false;
        }
      }
      return changed;
    }
    return false;
  } catch { return false; }
}
