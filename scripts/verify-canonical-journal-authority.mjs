import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('..',import.meta.url));
const {StoryStore}=await import(repo+'/packages/main/dist/core/store.js');
const {executeCausalEvidence,preflightCausalEvidence,DEFAULT_CAUSAL_SELECTOR_POLICY}=await import(repo+'/packages/main/dist/core/causal-evidence.js');
const {signValidationArtifact}=await import(repo+'/packages/main/dist/core/validation-artifact-signing.js');
const {createAcceptanceAmendmentController,acceptanceAmendmentBlocker}=await import(repo+'/packages/main/dist/core/acceptance-amendment-journal.js');
const {recordConvergenceProgress,readConvergenceProgress}=await import(repo+'/packages/main/dist/core/convergence-progress-journal.js');
const {base,delta}=await import(repo+'/scripts/verify-acceptance-amendment-delta.mjs');
const root=mkdtempSync(join(tmpdir(),'canonical-authority-'));const storyId=base.storyId;
try{
const git=(...a)=>execFileSync('git',a,{cwd:root,stdio:'pipe'});git('init','-q','-b','main');git('config','user.name','fixture');git('config','user.email','fixture@example.invalid');
writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'.',storyDir:'.proof-or-stop/story/actives'}));writeFileSync(join(root,'sum.cjs'),'module.exports=(a,b)=>a+b;\n');
const store=new StoryStore(root);store.writeStory(storyId,{storyId,name:'test',title:'Authority',phase:'DEV',priority:'medium',createdAt:new Date().toISOString(),events:[]});store.writeChecklist(storyId,base.checklist);store.writeScopeContract(storyId,base.scope);store.writeProofStoryContract(storyId,base.proofStory);git('add','.');git('commit','-qm','fixture');
const command={executable:process.execPath,args:['-e',"console.log('CAS_REAL')"]};
const identity={storyId,cwd:root,command,bootstrap:{executable:process.execPath,args:[]},inputs:{materialHash:'fixture',explicitInput:'fixture'},storyFilesHash:'fixture',effectiveEnvironment:{NODE_ENV:'test'},runtimeVersion:process.version,toolVersion:'fixture',selectorPolicy:DEFAULT_CAUSAL_SELECTOR_POLICY};
const preflight=preflightCausalEvidence({cli:{available:true,path:process.execPath},worktree:{expected:root,actual:root},gitIndex:{readable:true,path:join(root,'.git/index'),expected:'head',actual:'head',contentDigest:'sha256:fixture'},gitMaterial:{available:true,headHash:'head',materialHash:'fixture',storyFilesHash:'fixture'},writerLease:{available:true,valid:true},providerCapability:{required:['allowlisted-command'],available:['allowlisted-command']},resources:{required:{timeoutMs:1000},available:{timeoutMs:1000}},evidenceTarget:{writable:true,path:store.storyDirPath(storyId)},sideChannel:{available:true,maxOutputChars:12000,maxProgressEvents:10}},undefined,identity);
await executeCausalEvidence({identity,preflight,selector:'CAS_REAL',receiptStore:store,revalidateBeforeRun:()=>true,run:async()=>({code:0,output:execFileSync(command.executable,command.args,{cwd:root,encoding:'utf8'})})});
assert.ok(store.causalEvidenceOutputPaths(storyId).some(p=>p.endsWith('index.json')),'CANONICAL_INDEX_WRITER_MUST_BE_RECOGNIZED');console.log('PASS real causal producer canonical index');
const controller=createAcceptanceAmendmentController(store,root);controller.propose({storyId,amendmentId:'AM-1',delta,submitterSessionId:'owner'});const original=store.readAcceptanceAmendments(storyId);assert.equal(original.schemaVersion,'proof-or-stop.acceptance_amendments.v1');
const sign=o=>{const {signature,...c}=o;return {...c,signature:signValidationArtifact(c,root)}};
for(const mode of ['journal','entry']){let old=structuredClone(original);if(mode==='journal')old.schemaVersion='proofbound.acceptance_amendments.v1';else {old.entries[0].schemaVersion='proofbound.acceptance_amendment.v1';old.entries[0]=sign(old.entries[0]);}old=sign(old);store.writeAcceptanceAmendments(storyId,old);assert.match(acceptanceAmendmentBlocker(store,storyId,root),/invalid/);store.writeAcceptanceAmendments(storyId,original);assert.match(acceptanceAmendmentBlocker(store,storyId,root),/pending/);}console.log('PASS canonical proposal and signed retired journal/entry refusal');
recordConvergenceProgress(store,storyId,root);const progress=readConvergenceProgress(store,storyId,root);assert.equal(progress.schemaVersion,'proof-or-stop.convergence_progress_journal.v1');for(const mode of ['journal','state']){let old=structuredClone(progress);if(mode==='journal')old.schemaVersion='proofbound.convergence_progress_journal.v1';else old.state.schemaVersion='proofbound.effective_progress.v1';store.writeConvergenceProgress(storyId,sign(old));assert.throws(()=>readConvergenceProgress(store,storyId,root),/invalid/i);store.writeConvergenceProgress(storyId,progress);assert.ok(readConvergenceProgress(store,storyId,root));}console.log('PASS canonical progress producer and signed retired journal/state refusal');
}finally{rmSync(root,{recursive:true,force:true});}
