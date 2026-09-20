import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
registerHooks({load(url,ctx,next){if(url.endsWith('.ts'))return{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(url,ctx);}});
const {runHostRun}=await import('../packages/main/src/core/host-run.ts');
const {runBudgetedProviderRequest,runCoveredProviderTransport,runBudgetedSupervisedProcess,runWithProviderCallBudget,runWithProviderCallBudgetAsync}=await import('../packages/main/src/core/provider-call-budget.ts');
const {captureHostRunBudgetEnvironment,restoreHostRunBudgetEnvironment}=await import('../packages/main/src/core/host-run-budget.ts');
const adapters={
 codex:(await import('../packages/main/src/providers/codex-cli.ts')).runBoundedCodexProvider,
 claude:(await import('../packages/main/src/providers/claude-cli.ts')).runBoundedClaudeProvider,
 gemini:(await import('../packages/main/src/providers/gemini-cli.ts')).runBoundedGeminiProvider,
};
const root=mkdtempSync(join(tmpdir(),'shared-quota-edges-'));
const environment=(id,max=2)=>({PROOF_OR_STOP_USAGE_LEDGER:'0',PROOF_OR_STOP_RUN_BUDGET_ID:id,PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS:String(max)});
const request=(provider,env,attempts=5)=>({provider,cwd:root,env,argv:['fixture'],timeoutMs:10,maxAttempts:attempts});
const success={status:0,stdout:'fixture',stderr:'',replacementSafe:true};
const timeout={status:null,stdout:'',stderr:'',timedOut:true,replacementSafe:true};
const results=[];
function test(name,run){run();results.push(name);}
try{
 for(const [provider,adapter] of Object.entries(adapters)){
  test(provider+' retry attempts share the job quota',()=>{
   const req=request(provider,environment(provider+'-retry'));let attempts=0;
   const outcome=runBudgetedProviderRequest(req,r=>adapter(r,()=>{attempts++;return timeout;}));
   assert.equal(attempts,2);assert.equal(outcome.attempts,2);
   assert.throws(()=>adapter(req,()=>{attempts++;return success;}),/reservations exhausted/);assert.equal(attempts,2);
  });
  test(provider+' early completion releases unused retries without double charge',()=>{
   const env=environment(provider+'-early');const req=request(provider,env);let attempts=0;
   for(let i=0;i<2;i++)runBudgetedProviderRequest(req,r=>adapter(r,(_bin,argv,opts)=>runBudgetedSupervisedProcess(opts,argv,()=>{attempts++;return success;})));
   assert.equal(attempts,2);assert.throws(()=>adapter(req,()=>{attempts++;return success;}),/reservations exhausted/);assert.equal(attempts,2);
  });
 }
 test('exceptions retain all reserved attempts and preserve exception identity',()=>{
  const req=request('codex',environment('exception'));const original=Object.freeze(new Error('fixture transport failed'));
  assert.throws(()=>adapters.codex(req,()=>{throw original;}),e=>e===original);
  assert.throws(()=>adapters.codex(req,()=>success),/reservations exhausted/);
 });
 test('attempt overreporting cannot release quota',()=>{
  const req=request('codex',environment('invalid-attempts'));
  runBudgetedProviderRequest(req,()=>({attempts:99}));
  assert.throws(()=>adapters.codex(req,()=>success),/reservations exhausted/);
 });
 test('redacted child env cannot drop parent quota',()=>{
  const req={...request('codex',{}),budgetRoot:root,budgetEnv:environment('redacted')};let calls=0;
  const result=runBudgetedProviderRequest(req,r=>adapters.codex(r,(_bin,_argv,opts)=>{assert.equal(opts.env.PROOF_OR_STOP_RUN_BUDGET_ID,'redacted');calls++;return timeout;}));
  assert.equal(result.attempts,2);assert.equal(calls,2);
  assert.throws(()=>runBudgetedProviderRequest(req,r=>adapters.codex(r,()=>success)),/reservations exhausted/);
 });
 test('forged copied transport cannot inherit a live exemption',()=>{
  assert.throws(()=>runCoveredProviderTransport(request('codex',{}),{cwd:root,env:{},timeoutMs:1},()=>success),/without live request/);
  const env=environment('forged',1);runWithProviderCallBudget(root,env,'fixture',()=>{});
  assert.throws(()=>runBudgetedSupervisedProcess({cwd:root,env,timeoutMs:1},['fixture'],()=>success),/reservations exhausted/);
 });
 test('quota configuration capture excludes credentials and rejects conflicting worker budget',()=>{
  const env=environment('binding');const binding=captureHostRunBudgetEnvironment({...env,FAKE_AUTH_SECRET:'never persist'});
  assert.equal(binding.FAKE_AUTH_SECRET,undefined);assert.equal(binding.PROOF_OR_STOP_USAGE_LEDGER,undefined);
  assert.equal(restoreHostRunBudgetEnvironment({},binding).PROOF_OR_STOP_RUN_BUDGET_ID,'binding');
  assert.throws(()=>restoreHostRunBudgetEnvironment(environment('replacement'),binding),/conflicting bound quota/);
  assert.throws(()=>captureHostRunBudgetEnvironment(env,{...env,PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS:'3'}),/conflicting bound quota/);
 });
 test('repair subquota is charged within the shared total',()=>{
  const env={...environment('repair-partition',3),PROOF_OR_STOP_RUN_BUDGET_MAX_REPAIR_CALLS:'1',PROOF_OR_STOP_RUN_BUDGET_CATEGORY:'repair'};
  adapters.codex(request('codex',env),()=>timeout);
  assert.throws(()=>adapters.claude(request('claude',env),()=>success),/repair call reservations exhausted/);
  const product={...env,PROOF_OR_STOP_RUN_BUDGET_CATEGORY:'product'};
  adapters.gemini(request('gemini',product),()=>timeout);
  assert.throws(()=>runWithProviderCallBudget(root,product,'x',()=>{}),/total call reservations exhausted/);
 });
 test('supervisor quota and synchronous repair helper share one ledger',()=>{
  const env=environment('mixed-single');let calls=0;
  runWithProviderCallBudget(root,env,'fixture',()=>calls++);
  runBudgetedSupervisedProcess({cwd:root,env,timeoutMs:1},['fixture'],()=>calls++);
  assert.throws(()=>runWithProviderCallBudget(root,env,'fixture',()=>calls++),/reservations exhausted/);assert.equal(calls,2);
 });
 // An asynchronous wrapper must hold its reservation until its outcome, and
 // concurrent starts must reserve before yielding to the transport.
 {
  const env=environment('async',2);let calls=0;let release;const wait=new Promise(r=>release=r);
  const p=Array.from({length:5},()=>runWithProviderCallBudgetAsync(root,env,'fixture',async()=>{calls++;await wait;}));
  release();const values=await Promise.allSettled(p);
  assert.equal(calls,2);assert.equal(values.filter(x=>x.status==='rejected').length,3);results.push('async reservations are acquired before yielding');
 }
 // Real standalone leaf seam, no Story state or live provider.
 {
  const {runCodexReviewLeaf}=await import('../packages/main/src/core/codex-review-leaf.ts');
  const env=environment('leaf',1);let calls=0;
  const opts={storyId:'B-lab',materialHash:'fixture',storyWorktree:root,timeoutMs:1000,env};
  await runCodexReviewLeaf(opts,async()=>{calls++;return{stdout:'',exitCode:1,timedOut:false};});
  await assert.rejects(()=>runCodexReviewLeaf(opts,async()=>{calls++;return{stdout:'',exitCode:1,timedOut:false};}),/reservations exhausted/);
  assert.equal(calls,1);results.push('standalone review leaf debits shared quota');
 }

 // Submission persists policy before worker launch; a later worker need not
 // have inherited environment for either enforcement or child propagation.
 {
  const {submitManagedHostRun,runManagedHostRunWorker,getManagedHostRunStatus}=await import('../packages/main/src/core/managed-host-run.ts');
  let calls=0;const env=environment('durable-binding',1);
  const submit=async(key,workerEnv,budget=env)=>{
   let worker;
   const args={root,cwd:root,host:'codex',storyId:null,phase:'DEV',agentType:'lab-quota',promptText:'bounded managed task',projectRootHash:'sha256:lab',profile:null,environment:budget,deadlineMs:10000,idempotencyKey:key};
   const state=await submitManagedHostRun(args,{claimTimeoutMs:2000,claimPollMs:5,launchWorker:async req=>{
    worker=runManagedHostRunWorker(req,{env:workerEnv,runner:async plan=>{calls++;assert.equal(plan.env.PROOF_OR_STOP_RUN_BUDGET_ID,'durable-binding');return{stdout:'',stderr:'',exitCode:0,timedOut:false,replacementSafe:true};}});return{pid:process.pid};
   }});
   if(worker)await worker;return (await getManagedHostRunStatus({root,runId:state.runId})).run;
  };
  assert.equal((await submit('bound-once',{PROOF_OR_STOP_USAGE_LEDGER:'0'})).state,'completed');
  assert.equal((await submit('bound-once',{PROOF_OR_STOP_USAGE_LEDGER:'0'})).state,'completed');assert.equal(calls,1);
  await assert.rejects(()=>submit('bound-once',{},environment('new-budget',3)),/idempotency input conflict/);
  const changed=await submit('conflicting-worker',environment('replacement'));
  assert.match(changed.terminal.reason,/conflicting bound quota/);assert.equal(calls,1);
  const exhausted=await submit('bound-second',{PROOF_OR_STOP_USAGE_LEDGER:'0'});
  assert.match(exhausted.terminal.reason,/reservations exhausted/);assert.equal(calls,1);
  results.push('managed quota survives worker env loss, reuses idempotent result and rejects changed binding');
 }
 console.log(JSON.stringify({checks:results.length,results,paidCalls:0}));
 console.log('SHARED_QUOTA_EDGES_GREEN');
}finally{rmSync(root,{recursive:true,force:true});}
