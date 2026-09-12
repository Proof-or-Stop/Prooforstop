import {reportHealthIssue} from './health.js';
/** Narrow writer/consumer compatibility for authenticated review bookkeeping. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { realpathSync, readFileSync } from 'node:fs';
import { StoryStore } from './store.js';
import { matchesRuntimeCommitSubject } from './auto-commit-metadata.js';
import { verifyCausalEvidenceReceipt, CAUSAL_RECEIPT_DIRECTORY, CAUSAL_RECEIPT_INDEX_FILE, CAUSAL_OUTPUT_DIRECTORY } from './causal-evidence.js';
import { hasMechanicalExecutionAuthority } from './verification-receipt-authority.js';
import { digestCanonicalJson } from './digest.js';
import type { ChecklistData } from './types.js';

export function isOwnerLeaseHeartbeatOnly(before: Record<string,unknown>, after: Record<string,unknown>):boolean {
  const stable = (lease:Record<string,unknown>)=>({sessionId:lease.sessionId,sessionSource:lease.sessionSource,hostname:lease.hostname,cwd:lease.cwd});
  return typeof before.sessionId === 'string' && Boolean(before.sessionId.trim())
    && Number.isInteger(after.pid) && Number(after.pid)>0
    && typeof before.heartbeatAt === 'string' && typeof after.heartbeatAt === 'string'
    && Number.isFinite(Date.parse(after.heartbeatAt)) && Date.parse(after.heartbeatAt)>=Date.parse(before.heartbeatAt)
    && digestCanonicalJson(stable(before)) === digestCanonicalJson(stable(after));
}

export function isVerifiedEvidenceRefreshCommit(args: {
 gitCwd:string; metadataRoot:string; storyId:string; commit:string; reviewedHeadHash:string;
 isProtectedArtifact:(path:string)=>unknown;
}):boolean {
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
    if (matchesRuntimeCommitSubject(subject, `record ${storyId} verification_evidence_add metadata`)) {
      if (artifacts.some(path => ['process-events.jsonl','owner-lease.json'].includes(path) && args.isProtectedArtifact(path))) return false;
      if (artifacts.includes('owner-lease.json') && !isOwnerLeaseHeartbeatOnly(readAt(parents[0],'owner-lease.json'),readAt(commit,'owner-lease.json'))) return false;
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
      for (const path of artifacts.filter(path => path.startsWith(CAUSAL_OUTPUT_DIRECTORY + '/'))) {
        const payload = readAt(commit,path);
        if (typeof payload.output !== 'string' || Object.keys(payload).join(',') !== 'output') return false;
        const digest = createHash('sha256').update(payload.output).digest('hex');
        if (path !== `${CAUSAL_OUTPUT_DIRECTORY}/${digest}.json`) return false;
        const receiptPaths = git(['ls-tree','-r','--name-only',commit,'--',prefix + CAUSAL_RECEIPT_DIRECTORY]).split('\n').filter(Boolean);
        if (!receiptPaths.some(receiptPath => {
          const receipt = readAt(commit,receiptPath.slice(prefix.length));
          return verifyCausalEvidenceReceipt(receipt) && receipt.storyId === storyId
            && receiptPath === `${prefix}${CAUSAL_RECEIPT_DIRECTORY}/${receipt.receiptHash}.json`
            && receipt.selectorOutput?.digest === digest && receipt.selectorOutput.length === payload.output.length;
        })) return false;
      }
      const before = readAt(parents[0],'checklist.json') as ChecklistData;
      const after = readAt(commit,'checklist.json') as ChecklistData;
      const withoutEvidence = (data: ChecklistData) => ({ ...data, items: data.items.map(({ verificationEvidence, ...item }) => item) });
      if (digestCanonicalJson(withoutEvidence(before)) !== digestCanonicalJson(withoutEvidence(after))) return false;
      let changed = false;
      for (const item of after.items) {
        const old = before.items.find(i => i.id === item.id);
        const priorEvidence = old?.verificationEvidence ?? [];
        const nextEvidence = item.verificationEvidence ?? [];
        const semanticRows = (rows: typeof priorEvidence) => rows.map(e => JSON.stringify([e.intentRef,e.kind,e.result])).sort();
        if (priorEvidence.length !== nextEvidence.length
          || digestCanonicalJson(semanticRows(priorEvidence)) !== digestCanonicalJson(semanticRows(nextEvidence))) return false;
        // Consume exact rows first, then pair remaining rows one to one. A
        // previously valid row cannot authorize multiple replacements.
        const remaining = [...priorEvidence];
        const replacements = nextEvidence.filter(evidence => {
          const index = remaining.findIndex(prior => digestCanonicalJson(prior) === digestCanonicalJson(evidence));
          if (index < 0) return true;
          remaining.splice(index,1);
          return false;
        });
        for (const evidence of replacements) {
          const index = remaining.findIndex(prior => prior.intentRef === evidence.intentRef
            && prior.kind === evidence.kind && prior.result === evidence.result
            && hasMechanicalExecutionAuthority(store,storyId,old!,prior));
          if (index < 0 || !hasMechanicalExecutionAuthority(store,storyId,item,evidence)) return false;
          remaining.splice(index,1);
          changed = true;
        }
        if (remaining.length) return false;
      }
      return changed;
    }
    return false;
  } catch (error) {
    if (!(error && typeof error === 'object' && (('code' in error && error.code === 'ENOENT') || ('stderr' in error && /fatal: path .* does not exist in/.test(String(error.stderr))))))
      reportHealthIssue('review-maintenance-lineage',error instanceof Error ? error : {message:String(error)},{storyId});
    return false;
  }
}

/** Current byte-bound projection of a strict refresh, shared with scoped retention. */
export function isCurrentVerifiedEvidenceRefreshArtifact(args: {
  gitCwd: string; metadataRoot: string; storyId: string; artifactPath: string;
  isProtectedArtifact:(path:string)=>unknown;
}): boolean {
  const {gitCwd,metadataRoot,storyId,artifactPath}=args;
  if (artifactPath !== 'checklist.json' && artifactPath !== CAUSAL_RECEIPT_INDEX_FILE
    && !/^causal-evidence\/(outputs|receipts)\/[a-f0-9]{64}\.json$/.test(artifactPath)) return false;
  try {
    const store = new StoryStore(metadataRoot);
    const prefix = relative(realpathSync(gitCwd),realpathSync(store.storyDirPath(storyId))).replaceAll('\\','/') + '/';
    if (prefix.startsWith('../') || prefix.startsWith('/')) return false;
    const git = (argv: string[]) => execFileSync('git',argv,{cwd:gitCwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    const commit = git(['log','-1','--format=%H','--',prefix+artifactPath]).trim();
    if (!commit || !matchesRuntimeCommitSubject(git(['show','-s','--format=%s',commit]).trim(),`record ${storyId} verification_evidence_add metadata`)) return false;
    if (readFileSync(store.storyFilePath(storyId,artifactPath),'utf8') !== git(['show',`${commit}:${prefix}${artifactPath}`])) return false;
    return isVerifiedEvidenceRefreshCommit({gitCwd,metadataRoot,storyId,commit,isProtectedArtifact:args.isProtectedArtifact,reviewedHeadHash:git(['rev-parse',commit+'^']).trim()});
  } catch (error) {
    if (!(error && typeof error === 'object' && (('code' in error && error.code === 'ENOENT') || ('stderr' in error && /fatal: path .* does not exist in/.test(String(error.stderr))))))
      reportHealthIssue('review-maintenance-lineage',error instanceof Error ? error : {message:String(error)},{storyId});
    return false;
  }
}
