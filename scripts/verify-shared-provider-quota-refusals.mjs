// Native source owners, isolated data, and zero paid provider calls.
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
registerHooks({load(url,ctx,next){if(url.endsWith('.ts'))return{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(url,ctx);}});
const {runWithProviderCallBudget}=await import('../packages/main/src/core/provider-call-budget.ts');
const {runCodexReviewLeaf}=await import('../packages/main/src/core/codex-review-leaf.ts');
const {runClaudeRepair}=await import('../packages/main/src/core/autopilot-executor.ts');
const {resolveLedgerPath,verifyLedgerChain}=await import('../packages/main/src/core/usage-ledger/writer.ts');
const root=mkdtempSync(join(tmpdir(),'quota-refusals-'));const original={...process.env};
const environment=id=>({PROOF_OR_STOP_USAGE_LEDGER:'1',PROOF_OR_STOP_RUN_BUDGET_ID:id,PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS:'1'});
const finalRow=before=>{const rows=verifyLedgerChain(resolveLedgerPath(root));assert.equal(rows.length,before+2);const last=rows.at(-1);assert.equal(last.usage.unavailableReason,'shared_call_quota_refused');assert.deepEqual(last.supersedesRecordIds,[rows.at(-2).recordId]);};
try {
 let calls=0;
 const leafEnv=environment('leaf-final');runWithProviderCallBudget(root,leafEnv,'x',()=>{});
 const leaf=await runCodexReviewLeaf({storyId:'B-lab',materialHash:'fixture',storyWorktree:root,timeoutMs:1000,env:leafEnv,
  usageLedger:{root,env:leafEnv,phase:'REVIEW',recordedAt:new Date().toISOString(),projectRootHash:'sha256:fixture'}},async()=>{calls++;throw Error('must not run');});
 assert.equal(leaf.hostBVerdict.decision,'blocked');assert.match(JSON.stringify(leaf),/codex_review_call_quota_refused/);finalRow(0);
 const repairEnv=environment('repair-final');runWithProviderCallBudget(root,repairEnv,'x',()=>{});
 const repair=runClaudeRepair(root,{},()=>{calls++;throw Error('must not run');},{id:'fixture'},
  {executable:'node',args:[],cwd:root,timeoutMS:10},{exitCode:1,stdout:'',stderr:''},{story:{storyId:null},mode:'local',targetPhase:'DEV'},repairEnv);
 assert.equal(repair.status,'failed');assert.equal(repair.exitCode,3);assert.match(repair.stderrExcerpt,/shared_call_quota_refused/);finalRow(2);
 // A provider cannot forge a pre-spawn refusal by choosing the same error text.
 const forged=Object.freeze(new Error('host_run_budget_refused: total call reservations exhausted'));
 await assert.rejects(()=>runCodexReviewLeaf({storyId:'B-lab',materialHash:'fixture',storyWorktree:root,timeoutMs:1000,env:environment('forged')},async()=>{throw forged;}),e=>e===forged);
 assert.equal(calls,0);

 const bin=join(root,'bin');mkdirSync(bin);for(const name of ['codex','claude','gemini'])writeFileSync(join(bin,name),'#!/bin/sh\nprintf "fixture 1.0.0\\n"\n',{mode:0o755});
 process.env.PATH=bin+':'+original.PATH;process.env.CODEX_SESSION_ID='quota-fixture';
 mkdirSync(join(root,'packages/main/src'),{recursive:true});writeFileSync(join(root,'packages/main/src/index.ts'),'export const fixture=true;\n');
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
 const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});git('init','-q');git('add','packages','proof-or-stop.config.json');git('-c','user.name=Quota Fixture','-c','user.email=quota@example.invalid','commit','-qm','fixture');
 const {resetConfigCache}=await import('../packages/main/src/core/config.ts');resetConfigCache();
 const {StoryStore}=await import('../packages/main/src/core/store.ts');const store=new StoryStore(root);const now=new Date().toISOString();
 // Private disposable fixture through the store API; no real Story JSON writes.
 store.writeStory('B-quota',{storyId:'B-quota',name:'quota',title:'Quota fixture',description:'Native dispatch refusal fixture',type:'feature',phase:'DEV',priority:'medium',createdAt:now,startedAt:now,endedAt:null,events:[{phase:'DEV',action:'advance',timestamp:now}]});
 store.writeChecklist('B-quota',{items:[]});
 const {prepareDispatch,runDispatch}=await import('../packages/main/src/core/proof-or-stop-dispatch.ts');
 for(const host of ['codex','claude-code','gemini'])for(const mode of ['exhausted','prompt-bytes']){
  const env=environment('dispatch-'+host+'-'+mode);delete process.env.PROOF_OR_STOP_RUN_BUDGET_MAX_PROMPT_BYTES;if(mode==='prompt-bytes')env.PROOF_OR_STOP_RUN_BUDGET_MAX_PROMPT_BYTES='1000';Object.assign(process.env,env);if(mode==='exhausted')runWithProviderCallBudget(root,env,'x',()=>{});
  const ready=prepareDispatch(store,root,{storyId:'B-quota',dispatchId:'D-quota-'+host+'-'+mode,host,objective:'Prove a recorded pre-spawn quota refusal.'+' Full prompt content.'.repeat(100),allowedPaths:['packages/main/src/result.ts']});
  const before=verifyLedgerChain(resolveLedgerPath(root)).length;
  const result=runDispatch(store,root,{storyId:'B-quota',dispatchId:ready.dispatchId,allowRealHostSubprocess:true,executionPolicy:{envAllowlist:[],envDenylist:[],commandAllowlist:['claude --print --verbose --output-format=stream-json <prompt-file>'],maxRuntimeMs:1000},providerRunner:()=>{calls++;throw Error('must not run');}});
  assert.equal(result.status,'failed',JSON.stringify(result));assert.match(result.warnings.join('\n'),/shared_call_quota_refused/);assert.match(result.nextAction,/waiting or retrying does not reset/);if(mode==='prompt-bytes')assert.match(result.warnings.join('\n'),/prompt byte ceiling/);
  assert.match(readFileSync(join(root,ready.transcriptFile),'utf8'),/shared_call_quota_refused/);finalRow(before);
 }
 assert.equal(calls,0);
 console.log('SHARED_QUOTA_REFUSALS_GREEN review, repair and three dispatch owners retain structured refusal, transcript and final accounting; forged error does not bypass outcome handling');
} finally {for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);rmSync(root,{recursive:true,force:true});}
