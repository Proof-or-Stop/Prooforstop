/** Read-only equivalence proof for an existing signed, applied scope acknowledgement. */
import {execFileSync} from 'node:child_process';
import {readFileSync, realpathSync} from 'node:fs';
import {relative, isAbsolute} from 'node:path';
import {canonicalDigest} from './authority-signing.js';
import {verifyValidationArtifact} from './validation-artifact-signing.js';
import {pickProjectConfigPath, type ProofOrStopConfig} from './config.js';
import {readAuthenticatedAcceptanceAmendmentJournal} from './acceptance-amendment-journal.js';
import {deriveAcceptanceAmendment} from './acceptance-amendment.js';
import {unexpiredScopeBudgetApprovals, type ScopeBudgetApproval} from './story-scope-budget-decisions.js';
import {configuredValidationCommandEntries} from './validation-command-config.js';
import {buildValidationCommandInventory} from './validation-command-identity.js';
import {collectVerificationIntents} from './verification.js';
import {hasMechanicalExecutionAuthority} from './verification-receipt-authority.js';
import {SCOPE_BUDGET_DECISION_RUNTIME_POLICY as policy} from './runtime-fact-registry.js';
import type {StoryStore} from './store.js';
import type {ChecklistData} from './types.js';
import type {ScopeBudgetSubject, StoryScopeBudgetReport} from './story-scope-budget.js';

export interface ScopeApprovalContinuity {
  approval: ScopeBudgetApproval;
  provenance: {kind: 'verified-applied-scope-continuity'; approvalSignature: string; historicalCommit: string;
    amendmentId: string; currentBindingDigest: string; firstPinCommits: string[]; validationConfigurationChanged: boolean};
}
const equal=(a: unknown,b: unknown)=>canonicalDigest(a)===canonicalDigest(b);

/** Additions preserve raw entries and scope reference identities, never validation cache freshness. */
function equivalentConfiguration(old: ProofOrStopConfig, current: ProofOrStopConfig): boolean {
  const before=structuredClone(old),after=structuredClone(current);
  const a=before.validate,b=after.validate;
  if (!a || !b || !Array.isArray(a.commands) || !Array.isArray(b.commands)) return equal(old,current);
  let cursor=0;
  for (const entry of a.commands) {
    const index=b.commands.findIndex((value,i)=>i>=cursor&&equal(value,entry));
    if (index<0) return false;
    cursor=index+1;
  }
  a.commands=[];b.commands=[];
  if (!equal(before,after)) return false;
  const oldNormalized=configuredValidationCommandEntries(old),newNormalized=configuredValidationCommandEntries(current);
  const oldInventory=buildValidationCommandInventory(oldNormalized),newInventory=buildValidationCommandInventory(newNormalized);
  for(const addition of newInventory.entries.filter(entry=>!oldInventory.entries.some(old=>old.id===entry.id))) {
    if(newInventory.entries.some(other=>other.id!==addition.id&&equal(other.tuple,addition.tuple))) return false;
  }
  const generated=(label: string)=>/^configured validate\.commands\[\d+\]$/.test(label);
  for (const entry of oldInventory.entries) {
    const match=newInventory.entries.find(row=>row.id===entry.id);
    if (!match) return false;
    const {index: _a,label: al,...left}=entry,{index: _b,label: bl,...right}=match;
    if (!equal(left,right) || al!==bl&&!(generated(al)&&generated(bl))) return false;
  }
  const resolveGroups=(config: ProofOrStopConfig,normalized: typeof oldNormalized,inventory: typeof oldInventory)=>
    (config.storyScopeBudget?.validationGroups??[]).map(group=>({id:group.id,targets:(group.commandIds??group.commandLabels??[]).map(ref=>{
      const matches=inventory.entries.filter(entry=>group.commandIds?entry.id===ref:entry.label===ref||normalized.legacyLabels[entry.index]===ref);
      if(matches.length!==1) throw new Error('Scope continuity requires unambiguous validation references');
      return matches[0]!.id;
    })}));
  return equal(resolveGroups(old,oldNormalized,oldInventory),resolveGroups(current,newNormalized,newInventory));
}

export function resolveScopeApprovalContinuity(store: StoryStore,root: string,subject: ScopeBudgetSubject,
  report: StoryScopeBudgetReport,evaluate: (subject: ScopeBudgetSubject,config: ProofOrStopConfig,base?: ScopeBudgetSubject)=>StoryScopeBudgetReport): ScopeApprovalContinuity|null {
  if(report.status!=='decision_required'||report.diagnostics.length||report.decomposition) return null;
  const approvals=unexpiredScopeBudgetApprovals(store,root,subject.storyId);
  if(!approvals.length) return null;
  try {
    const deadline=Date.now()+policy.continuityTotalMs;
    let commands=0,bytes=0;
    const checkBudget=()=>{if(Date.now()>=deadline) throw new Error('Scope continuity proof time bound exhausted');};
    const git=(...args: string[])=>{
      checkBudget();
      if(++commands>policy.continuityTotalGitCommands) throw new Error('Scope continuity command bound exhausted');
      const output=execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],
        timeout:Math.max(1,Math.min(policy.continuityGitTimeoutMs,deadline-Date.now())),maxBuffer:policy.continuityGitOutputBytes});
      bytes+=Buffer.byteLength(output);
      if(bytes>policy.continuityTotalGitBytes) throw new Error('Scope continuity byte bound exhausted');
      checkBudget();return output.trim();
    };
    const head=git('rev-parse','HEAD');
    if(realpathSync(git('rev-parse','--show-toplevel'))!==realpathSync(root)) return null;
    const path=(absolute: string)=>{
      const rel=relative(realpathSync(root),realpathSync(absolute)).replaceAll('\\','/');
      if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('../')) throw new Error('Scope continuity path escapes project');
      return rel;
    };
    const configPath=pickProjectConfigPath(root);
    if(!configPath) return null;
    const configText=readFileSync(configPath.path,'utf8');
    const configFile=path(configPath.path),currentConfig=JSON.parse(configText) as ProofOrStopConfig;
    const approvalFile=path(store.storyFilePath(subject.storyId,'scope-budget-decisions.json'));
    const checklistFile=path(store.storyFilePath(subject.storyId,'checklist.json'));
    const histories=new Map<string,string[]>(),blobs=new Map<string,unknown>();
    const history=(file: string)=>{
      checkBudget();
      const cached=histories.get(file);if(cached) return cached;
      // First-parent publication order is one ancestry chain, including merge publications.
      const commits=git('log','--first-parent','--full-history',`--max-count=${policy.continuityHistoryCommits+1}`,'--format=%H',head,'--',file).split('\n').filter(Boolean);
      if(commits.length>policy.continuityHistoryCommits) throw new Error('Scope continuity history bound exhausted');
      commits.reverse();histories.set(file,commits);return commits;
    };
    const read=<T>(commit: string,file: string): T=>{
      checkBudget();const key=`${commit}:${file}`;
      if(!blobs.has(key)) blobs.set(key,JSON.parse(git('show',key)));
      return blobs.get(key) as T;
    };
    const entries=readAuthenticatedAcceptanceAmendmentJournal(store,subject.storyId,root).entries;
    if(entries.length>policy.continuityHistoryCommits||approvals.length>policy.continuityHistoryCommits) return null;
    const publications=history(approvalFile);
    for(const approval of approvals.slice().reverse()) for(const commit of publications) {
      const journal=read<{schemaVersion:string;storyId:string;decisions:ScopeBudgetApproval[];signature:string}>(commit,approvalFile);
      const {signature,...claims}=journal;
      if(journal.storyId!==subject.storyId||journal.schemaVersion!=='story-scope-budget-decisions.v1'
        ||!verifyValidationArtifact(claims,signature,root)||!journal.decisions.some(row=>equal(row,approval))) continue;
      const oldConfig=read<ProofOrStopConfig>(commit,configFile);
      if(!equivalentConfiguration(oldConfig,currentConfig)) continue;
      for(const entry of entries.filter(e=>e.state==='APPROVED')) {
        checkBudget();
        const approved=deriveAcceptanceAmendment(entry.base,entry.delta);
        if(!equal(entry.baseDigest,canonicalDigest(entry.base))||!equal(entry.nextDigest,canonicalDigest(approved))) continue;
        const oldResult=evaluate(approved,oldConfig),oldGrowth=evaluate(approved,oldConfig,entry.base);
        if(oldResult.bindingDigest!==approval.resultingScopeDigest||oldGrowth.bindingDigest!==approval.bindingDigest
          ||oldResult.diagnostics.length||oldGrowth.diagnostics.length) continue;
        if(!equal(approved.scope,subject.scope)||!equal(approved.proofStory.acceptanceBindings,subject.proofStory.acceptanceBindings)) continue;
        const normalized=structuredClone(subject.checklist),pins:Array<{itemId:string;ref:string;pin:unknown}>=[];
        if(normalized.items.length!==approved.checklist.items.length) continue;
        let requirementsMatch=true;
        for(let i=0;i<normalized.items.length;i++) {
          const current=normalized.items[i]!,original=approved.checklist.items[i]!;
          if(current.id!==original.id||(current.status==='withdrawn')!==(original.status==='withdrawn')) {requirementsMatch=false;break;}
          const oldIntents=collectVerificationIntents(original),newIntents=collectVerificationIntents(current);
          if(oldIntents.length!==newIntents.length) {requirementsMatch=false;break;}
          for(let j=0;j<oldIntents.length;j++) {
            const a=oldIntents[j]!,b=newIntents[j]!;
            if(a.ref!==b.ref) {requirementsMatch=false;break;}
            if(!a.intent.verification&&b.intent.verification) {
              pins.push({itemId:current.id,ref:b.ref,pin:structuredClone(b.intent.verification)});
              delete b.intent.verification;
            }
          }
        }
        const projected=(checklist:ChecklistData)=>checklist.items.map(({id,title,context,userSees,excludes,files,verificationIntent,relatedDocs})=>
          ({id,title,context,userSees,excludes,files,verificationIntent,relatedDocs}));
        if(!requirementsMatch||!equal(projected(normalized),projected(approved.checklist))) continue;
        const pinCommits:string[]=[];
        let pinsValid=true;
        for(const pin of pins) {
          let authenticated=false;
          for(const publication of history(checklistFile)) {
            const checklist=read<ChecklistData>(publication,checklistFile),item=checklist.items.find(i=>i.id===pin.itemId);
            if(!item) {if(authenticated) {pinsValid=false;break;} continue;}
            const found=collectVerificationIntents(item).find(i=>i.ref===pin.ref)?.intent.verification;
            if(!found) {if(authenticated) {pinsValid=false;break;} continue;}
            if(!equal(found,pin.pin)) {pinsValid=false;break;}
            if(!authenticated) {
              const original=approved.checklist.items.find(i=>i.id===pin.itemId)!;
              const historical=structuredClone(item),originalIntents=collectVerificationIntents(original);
              for(const intent of collectVerificationIntents(historical)) {
                const expected=originalIntents.find(row=>row.ref===intent.ref);
                if(expected&&!expected.intent.verification) delete intent.intent.verification;
              }
              if((historical.status==='withdrawn')!==(original.status==='withdrawn')
                ||!equal(projected({items:[historical]}),projected({items:[original]}))) {pinsValid=false;break;}
              if(!item.verificationEvidence?.some(e=>e.intentRef===pin.ref&&hasMechanicalExecutionAuthority(store,subject.storyId,item,e))) {pinsValid=false;break;}
              authenticated=true;pinCommits.push(publication);
            }
          }
          if(!authenticated||!pinsValid) {pinsValid=false;break;}
        }
        if(!pinsValid) continue;
        const normalizedReport=evaluate({...subject,checklist:normalized},oldConfig);
        if(normalizedReport.bindingDigest!==oldResult.bindingDigest||!equal(report.facts,oldResult.facts)
          ||!equal(report.paths,oldResult.paths)||!equal(report.counts,oldResult.counts)||!equal(report.exceeded,oldResult.exceeded)) continue;
        checkBudget();
        if(git('rev-parse','HEAD')!==head||readFileSync(configPath.path,'utf8')!==configText
          ||!equal(subject,{storyId:subject.storyId,scope:store.readScopeContract(subject.storyId),checklist:store.readChecklist(subject.storyId),proofStory:store.readProofStoryContract(subject.storyId)})
          ||!equal(entries,readAuthenticatedAcceptanceAmendmentJournal(store,subject.storyId,root).entries)
          ||!unexpiredScopeBudgetApprovals(store,root,subject.storyId).some(current=>equal(current,approval))) return null;
        checkBudget();
        return {approval,provenance:{kind:'verified-applied-scope-continuity',approvalSignature:approval.signature,historicalCommit:commit,
          amendmentId:entry.amendmentId,currentBindingDigest:report.bindingDigest,firstPinCommits:[...new Set(pinCommits)],validationConfigurationChanged:!equal(oldConfig,currentConfig)}};
      }
    }
  } catch { /* Missing, malformed, ambiguous or unverifiable proof never creates authority. */ }
  return null;
}
