import {isMissingReviewSnapshotError} from './review-metadata-surface.js';
import {reportHealthIssue} from './health.js';
/** Narrow writer/consumer compatibility for authenticated review bookkeeping. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { realpathSync, readFileSync } from 'node:fs';
import { StoryStore } from './store.js';
import { matchesRuntimeCommitSubject } from './auto-commit-metadata.js';
import { verifyCausalEvidenceReceipt, CAUSAL_EVIDENCE_INDEX_SCHEMA, CAUSAL_RECEIPT_DIRECTORY, CAUSAL_RECEIPT_INDEX_FILE, CAUSAL_OUTPUT_DIRECTORY } from './causal-evidence.js';
import { hasMechanicalExecutionAuthority } from './verification-receipt-authority.js';
import { digestCanonicalJson } from './digest.js';
import type { ChecklistData } from './types.js';

/** Path eligibility only; receipt authentication remains mandatory at consumers. */
export function isRefreshRetainableArtifactPath(path: string): boolean {
  return path === 'checklist.json' || path === CAUSAL_RECEIPT_INDEX_FILE
    || [CAUSAL_RECEIPT_DIRECTORY, CAUSAL_OUTPUT_DIRECTORY].some(directory =>
      path.startsWith(directory + '/') && /^[a-f0-9]{64}\.json$/.test(path.slice(directory.length + 1)));
}

export function isOwnerLeaseHeartbeatOnly(before: Record<string,unknown>, after: Record<string,unknown>):boolean {
  const stable = ({pid,heartbeatAt,...rest}:Record<string,unknown>)=>rest;
  return typeof before.sessionId === 'string' && Boolean(before.sessionId.trim())
    && Number.isInteger(after.pid) && Number(after.pid)>0
    && typeof before.heartbeatAt === 'string' && typeof after.heartbeatAt === 'string'
    && Number.isFinite(Date.parse(after.heartbeatAt)) && Date.parse(after.heartbeatAt)>=Date.parse(before.heartbeatAt)
    && digestCanonicalJson(stable(before)) === digestCanonicalJson(stable(after));
}

export type ReviewRefreshReadCache = object;
type RefreshCacheState = {
  proofs: Map<string,boolean>; artifacts: Map<string,{commit:string;bytes:string}>;
  proofEvaluations:number; gitCommands:number; policy?: (path:string)=>unknown;
};
// Only this module can populate verdicts. Callers receive an opaque token, not
// writable authority maps. The collector creates one token per synchronous read.
const refreshCaches = new WeakMap<ReviewRefreshReadCache,RefreshCacheState>();
export function createReviewRefreshReadCache():ReviewRefreshReadCache {
  const token=Object.freeze({});
  refreshCaches.set(token,{proofs:new Map(),artifacts:new Map(),proofEvaluations:0,gitCommands:0});
  return token;
}
export function reviewRefreshReadCacheStats(token:ReviewRefreshReadCache):{proofEvaluations:number;gitCommands:number} {
  const state=refreshCaches.get(token);
  return {proofEvaluations:state?.proofEvaluations??0,gitCommands:state?.gitCommands??0};
}
type RefreshCommitArgs = {
 gitCwd:string; metadataRoot:string; storyId:string; commit:string; reviewedHeadHash:string;
 isProtectedArtifact:(path:string)=>unknown; cache?:ReviewRefreshReadCache;
};
export function isVerifiedEvidenceRefreshCommit(args:RefreshCommitArgs):boolean {
  const candidate=args.cache?refreshCaches.get(args.cache):undefined;
  const state=candidate && /^[a-f0-9]{40,64}$/.test(args.commit) && /^[a-f0-9]{40,64}$/.test(args.reviewedHeadHash)
    && (!candidate.policy || candidate.policy===args.isProtectedArtifact)?candidate:undefined;
  if(state) state.policy=args.isProtectedArtifact;
  const key=JSON.stringify([args.gitCwd,args.metadataRoot,args.storyId,args.commit,args.reviewedHeadHash]);
  if(state?.proofs.has(key)) return state.proofs.get(key)!;
  if(state) state.proofEvaluations++;
  const verdict=computeVerifiedEvidenceRefreshCommit(args);
  state?.proofs.set(key,verdict);
  return verdict;
}
function computeVerifiedEvidenceRefreshCommit(args:RefreshCommitArgs):boolean {
  const { gitCwd, metadataRoot, storyId, commit, reviewedHeadHash } = args;
  const state=args.cache?refreshCaches.get(args.cache):undefined;
  const git = (argv: string[]) => {if(state) state.gitCommands++; return execFileSync('git', argv, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();};
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
    const snapshots=new Map<string,any>();
    const readAt = (ref: string, name: string) => {const key=ref+':'+prefix+name;if(!snapshots.has(key)) snapshots.set(key,JSON.parse(git(['show',key])));return snapshots.get(key);};
    let committedReceiptPaths:string[]|undefined;
    const loadReceiptSnapshots=():string[]=>{
      if(committedReceiptPaths) return committedReceiptPaths;
      const entries=git(['ls-tree','-r','--format=%(objectname) %(path)',commit,'--',prefix+CAUSAL_RECEIPT_DIRECTORY]).split('\n').filter(Boolean).map(line=>{
        const match=/^([a-f0-9]{40,64}) (.+)$/.exec(line);if(!match) throw new Error('Malformed receipt tree entry');return {hash:match[1],path:match[2]};
      });
      committedReceiptPaths=entries.map(entry=>entry.path);
      for(let start=0;start<entries.length;start+=64) {
        const batch=entries.slice(start,start+64);if(state) state.gitCommands++;
        const bytes=execFileSync('git',['cat-file','--batch'],{cwd:gitCwd,input:batch.map(entry=>entry.hash).join('\n')+'\n',maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']});
        let offset=0;
        for(const entry of batch) {
          const end=bytes.indexOf(10,offset);if(end<0) throw new Error('Truncated receipt object header');
          const [hash,type,sizeText]=bytes.subarray(offset,end).toString('utf8').split(' ');const size=Number(sizeText);
          if(hash!==entry.hash || type!=='blob' || !Number.isSafeInteger(size) || size<0 || end+1+size>=bytes.length || bytes[end+1+size]!==10) throw new Error('Invalid receipt object framing');
          const value=JSON.parse(bytes.subarray(end+1,end+1+size).toString('utf8'));
          snapshots.set(commit+':'+entry.path,value);offset=end+size+2;
        }
        if(offset!==bytes.length) throw new Error('Unexpected receipt batch suffix');
      }
      return committedReceiptPaths;
    };
    if (matchesRuntimeCommitSubject(subject, `record ${storyId} verification_evidence_add metadata`)) {
      if (artifacts.some(path => ['process-events.jsonl','owner-lease.json'].includes(path) && args.isProtectedArtifact(path))) return false;
      if (artifacts.includes('owner-lease.json') && (!git(['ls-tree','--name-only',parents[0],'--',prefix + 'owner-lease.json'])
      || !isOwnerLeaseHeartbeatOnly(readAt(parents[0],'owner-lease.json'),readAt(commit,'owner-lease.json')))) return false;
      if (!artifacts.includes('checklist.json') || artifacts.some(p => p !== 'process-events.jsonl' && p !== 'owner-lease.json' && !isRefreshRetainableArtifactPath(p))) return false;
      if(artifacts.some(path=>path===CAUSAL_RECEIPT_INDEX_FILE || path.startsWith(CAUSAL_RECEIPT_DIRECTORY+'/') || path.startsWith(CAUSAL_OUTPUT_DIRECTORY+'/'))) loadReceiptSnapshots();
      for (const path of artifacts.filter(p => p.startsWith(CAUSAL_RECEIPT_DIRECTORY + '/'))) {
        const causal = readAt(commit,path);
        if (!verifyCausalEvidenceReceipt(causal) || causal.storyId !== storyId
          || path !== `${CAUSAL_RECEIPT_DIRECTORY}/${causal.receiptHash}.json`) return false;
      }
      if (artifacts.includes(CAUSAL_RECEIPT_INDEX_FILE)) {
        const index = readAt(commit,CAUSAL_RECEIPT_INDEX_FILE);
        if (index.schemaVersion !== CAUSAL_EVIDENCE_INDEX_SCHEMA || !index.receipts || typeof index.receipts !== 'object') return false;
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
      const outputPaths=artifacts.filter(path => path.startsWith(CAUSAL_OUTPUT_DIRECTORY + '/'));
      const outputsByDigest=new Map<string,Set<number>>();
      if(outputPaths.length) {
        const receiptPaths=loadReceiptSnapshots();
        for(const receiptPath of receiptPaths) {
          const receipt=readAt(commit,receiptPath.slice(prefix.length));
          if(!verifyCausalEvidenceReceipt(receipt) || receipt.storyId!==storyId
            || receiptPath!==`${prefix}${CAUSAL_RECEIPT_DIRECTORY}/${receipt.receiptHash}.json` || !receipt.selectorOutput) continue;
          const lengths=outputsByDigest.get(receipt.selectorOutput.digest)??new Set<number>();
          lengths.add(receipt.selectorOutput.length);outputsByDigest.set(receipt.selectorOutput.digest,lengths);
        }
      }
      for (const path of outputPaths) {
        const payload=readAt(commit,path);
        if(typeof payload.output!=='string' || Object.keys(payload).join(',')!=='output') return false;
        const digest=createHash('sha256').update(payload.output).digest('hex');
        if(path!==`${CAUSAL_OUTPUT_DIRECTORY}/${digest}.json` || !outputsByDigest.get(digest)?.has(payload.output.length)) return false;
      }
      if (!git(['ls-tree','--name-only',parents[0],'--',prefix + 'checklist.json'])) return false;
      const before = readAt(parents[0],'checklist.json') as ChecklistData;
      const after = readAt(commit,'checklist.json') as ChecklistData;
      const reviewed = readAt(reviewedHeadHash,'checklist.json') as ChecklistData;
      const withoutEvidence = (data: ChecklistData) => ({ ...data, items: data.items.map(({ verificationEvidence, ...item }) => item) });
      if (digestCanonicalJson(withoutEvidence(before)) !== digestCanonicalJson(withoutEvidence(after))
        || digestCanonicalJson(withoutEvidence(reviewed)) !== digestCanonicalJson(withoutEvidence(after))) return false;
      let changed = false;
      for (const item of after.items) {
        const old = before.items.find(i => i.id === item.id);
        const priorEvidence = old?.verificationEvidence ?? [];
        const nextEvidence = item.verificationEvidence ?? [];
        const reviewedEvidence=reviewed.items.find(row=>row.id===item.id)?.verificationEvidence??[];
        const semanticRows = (rows: typeof priorEvidence) => rows.map(e => JSON.stringify([e.intentRef,e.kind,e.result])).sort();
        if (digestCanonicalJson(semanticRows(reviewedEvidence)) !== digestCanonicalJson(semanticRows(nextEvidence))) return false;
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
    if (!isMissingReviewSnapshotError(error))
      reportHealthIssue('review-maintenance-lineage',error instanceof Error ? error : {message:String(error)},{storyId});
    return false;
  }
}

/** Current byte-bound projection of a strict refresh, shared with scoped retention. */
export function isCurrentVerifiedEvidenceRefreshArtifact(args: {
  gitCwd: string; metadataRoot: string; storyId: string; artifactPath: string;
  isProtectedArtifact:(path:string)=>unknown;
  reviewedHeadHash:string; snapshotHead?:string; cache?:ReviewRefreshReadCache;
}): boolean {
  const {gitCwd,metadataRoot,storyId,artifactPath}=args;
  if (!isRefreshRetainableArtifactPath(artifactPath)) return false;
  try {
    const store = new StoryStore(metadataRoot);
    const prefix = relative(realpathSync(gitCwd),realpathSync(store.storyDirPath(storyId))).replaceAll('\\','/') + '/';
    if (prefix.startsWith('../') || prefix.startsWith('/')) return false;
    const state=args.cache?refreshCaches.get(args.cache):undefined;
    const git = (argv:string[])=>{if(state) state.gitCommands++;return execFileSync('git',argv,{cwd:gitCwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});};
    const snapshotHead=args.snapshotHead??git(['rev-parse','HEAD']).trim();
    const key=JSON.stringify([gitCwd,metadataRoot,storyId,snapshotHead,artifactPath]);
    let published=state?.artifacts.get(key);
    if(!published) {
      const commit=git(['log','-1','--format=%H',snapshotHead,'--',prefix+artifactPath]).trim();
      if(!commit || !matchesRuntimeCommitSubject(git(['show','-s','--format=%s',commit]).trim(),`record ${storyId} verification_evidence_add metadata`)) return false;
      published={commit,bytes:git(['show',`${commit}:${prefix}${artifactPath}`])};
      state?.artifacts.set(key,published);
    }
    if(readFileSync(store.storyFilePath(storyId,artifactPath),'utf8')!==published.bytes) return false;
    return isVerifiedEvidenceRefreshCommit({gitCwd,metadataRoot,storyId,commit:published.commit,isProtectedArtifact:args.isProtectedArtifact,reviewedHeadHash:args.reviewedHeadHash,cache:args.cache});
  } catch (error) {
    if (!isMissingReviewSnapshotError(error))
      reportHealthIssue('review-maintenance-lineage',error instanceof Error ? error : {message:String(error)},{storyId});
    return false;
  }
}
