import './lab-source-loader.mjs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
registerHooks({load(url,ctx,next){if(url.endsWith('.ts'))return{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(url,ctx);}});
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
const snapshot=fileURLToPath(new URL('../',import.meta.url));
const scenario=process.argv[2];
if(!scenario){
 execFileSync(process.execPath,['--input-type=module','-e',"await import('./scripts/lab-audit.mjs')"],{cwd:snapshot,stdio:'inherit',timeout:30000});
 const failures=[];
 for(const name of ['direct','managed-inherited','managed-task-env-only','planned-after-host','repair-after-host','custom-audit-after-host','separate-plans','mixed-positive']){
  try{process.stdout.write(execFileSync(process.execPath,[fileURLToPath(import.meta.url),name],{encoding:'utf8',timeout:30000}));}
  catch(e){process.stdout.write(String(e.stdout??''));failures.push(name);}
 }
 assert.deepEqual(failures,[],'SHARED_ROUTE_QUOTA_RED: every owned launch must debit the same configured job quota');
 execFileSync(process.execPath,['scripts/verify-shared-provider-quota-edges.mjs'],{cwd:snapshot,stdio:'inherit',timeout:30000});
 execFileSync(process.execPath,['scripts/verify-shared-provider-quota-contract.mjs'],{cwd:snapshot,stdio:'inherit',timeout:30000});
 console.log('SHARED_ROUTE_QUOTA_GREEN');
 process.exit(0);
}
const mod=path=>import(pathToFileURL(join(snapshot,path)));
const {runHostRun}=await mod('packages/main/src/core/host-run.ts');
const cap=2,root=mkdtempSync(join(tmpdir(),'budget-route-'));
const env={PROOF_OR_STOP_USAGE_LEDGER:'0',PROOF_OR_STOP_RUN_BUDGET_ID:'single-job',PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS:String(cap)};
let total=0,hostCalls=0,otherCalls=0;
const details={};
const outcome=()=>({stdout:'',stderr:'',exitCode:0,timedOut:false,replacementSafe:true});
async function host(){
  try{
    const r=await runHostRun({root,cwd:root,host:'codex',storyId:null,phase:'DEV',agentType:'lab-route-probe',promptText:'bounded shared job',recordedAt:new Date().toISOString(),projectRootHash:'sha256:lab',env}, {runner:async()=>{total++;hostCalls++;return outcome();}});
    assert.equal(r.spawned,true,'UNEXPECTED_HOST_REFUSAL');return true;
  }catch(e){if(e.message==='host_run_budget_refused: total call reservations exhausted')return false;throw e;}
}
async function planned(count=1){
  const {executePlannedSteps}=await mod('packages/main/src/core/planned-steps-executor.ts');
  const {buildPlannerDraft,buildJobPlan}=await mod('packages/main/src/core/planner.ts');
  const plan=buildJobPlan(buildPlannerDraft(root,{request:'Check route budget propagation',mode:'local',until:'DONE',allowUnattendedPlanning:true}),'B-lab','lab',{});
  delete plan.worktreePolicy; // Same isolated in-memory Story fixture as the canonical verifier.
  plan.plannedSteps=Array.from({length:count},(_,i)=>({stepId:`step-${i}`,type:'provider.codex',args:{argv:['exec','bounded-fixture']},timeoutMs:1000,maxAttempts:1}));
  plan.providerPolicy={primaryProvider:'codex',allowedProviders:['codex'],fallbackProviders:[],productionDoneProviders:[],allowFakeProviderForProductionDone:false,credentialsEnvAllowlist:[],secretRefs:['opaque-test-ref'],providerAvailability:'fail_closed'};
  plan.budgetPolicy={maxProviderCalls:cap,maxWallClockMs:0,maxTokenOrCostBudget:0};
  const r=executePlannedSteps({root,jobPlan:plan,store:{readStory:()=>({storyId:'B-lab',phase:'DEV'}),storyExists:()=>true,listStoryIds:()=>['B-lab'],appendProcessEvent:()=>{}},env,providerExecutor:{available:()=>true,run:req=>{total++;otherCalls++;return{provider:'codex',argvDigest:'fixture',exitCode:0,stdoutDigest:'fixture',stderrDigest:'fixture',stdoutBytes:0,stderrBytes:0,durationMs:0,attempts:1,timedOut:false,spawnError:false};}}});
  return {status:r.status,stopReason:r.stopReason,meteredCalls:r.budgetUsage.usage.providerCalls};
}
try{
  if(scenario==='mixed-positive'){
    const {runClaudeRepair}=await mod('packages/main/src/core/autopilot-executor.ts');
    const repair=runClaudeRepair(root,{},()=>{total++;otherCalls++;return{exitCode:0,stdout:'fixture',stderr:''};},
      {id:'fixture'}, {executable:'node',args:[],cwd:root,timeoutMS:10}, {exitCode:1,stdout:'',stderr:''},
      {story:{storyId:null},mode:'local',targetPhase:'DEV'},env);
    assert.equal(repair.status,'passed');
    const {runCustomAuditAdapter}=await mod('scripts/lab-audit.mjs');
    const admissionApi=await mod('packages/main/src/core/provider-process-admission.ts');
    await runCustomAuditAdapter({command:'fixture',argv:[],cwd:root,env,stdinText:'fixture',timeoutMs:10},root,new AbortController(),
      {admissionApi,runner:async()=>{total++;otherCalls++;return outcome();}});
    assert.equal(total,2);assert.equal(await host(),false);
  }else if(scenario==='separate-plans'){
    details.firstPlan=await planned(2);details.secondPlan=await planned(2);
  }else{
    assert.equal(await host(),true);assert.equal(await host(),true);
    assert.equal(await host(),false,'PREFILL_MUST_EXHAUST_SHARED_BUDGET');
    if(scenario==='direct')details.followup=await host();
    else if(scenario.startsWith('managed-')){
      const {submitManagedHostRun,runManagedHostRunWorker,getManagedHostRunStatus}=await mod('packages/main/src/core/managed-host-run.ts');
      let worker;
      const workerEnv=scenario==='managed-inherited'?env:{PROOF_OR_STOP_USAGE_LEDGER:'0'};
      details.workerBudgetPresent=!!workerEnv.PROOF_OR_STOP_RUN_BUDGET_ID;
      details.submittedBudgetPresent=true;
      const submitted=await submitManagedHostRun({root,cwd:root,host:'codex',storyId:null,phase:'DEV',agentType:'lab-route-probe',promptText:'Same shared job via managed entry',projectRootHash:'sha256:lab',profile:null,environment:env,deadlineMs:10000,idempotencyKey:scenario}, {claimTimeoutMs:2000,claimPollMs:5,launchWorker:async req=>{
        worker=runManagedHostRunWorker(req,{env:workerEnv,runner:async plan=>{total++;otherCalls++;details.providerBudgetPresent=!!plan.env.PROOF_OR_STOP_RUN_BUDGET_ID;return outcome();}});
        return{pid:process.pid};
      }});
      await worker;
      const state=await getManagedHostRunStatus({root,runId:submitted.runId});
      details.managedState=state.run.state;details.managedReason=state.run.terminal?.reason;
      if(otherCalls===0)assert.equal(details.managedReason,'worker_error:host_run_budget_refused: total call reservations exhausted');
    }else if(scenario==='planned-after-host'){details.plan=await planned(1);assert.equal(details.plan.status,'blocked');assert.equal(details.plan.stopReason,'budget_exceeded');}
    else if(scenario==='repair-after-host'){
      const {runClaudeRepair}=await mod('packages/main/src/core/autopilot-executor.ts');
      const r=runClaudeRepair(root,{},req=>{total++;otherCalls++;return{exitCode:0,stdout:'fixture repair completed',stderr:''};},{id:'step-1',title:'fixture',command:'verify',kind:'command',reason:'fixture'},
        {executable:'node',args:['verify.mjs'],cwd:root,timeoutMS:1000},{exitCode:1,stdout:'',stderr:'fixture failure'},
        {story:{storyId:null},mode:'local',targetPhase:'DEV'},env);
      details.repairStatus=r.status;assert.equal(r.status,'failed');assert.equal(r.exitCode,3);assert.match(r.stderrExcerpt,/shared_call_quota_refused/);
    }else if(scenario==='custom-audit-after-host'){
      const {runCustomAuditAdapter}=await mod('scripts/lab-audit.mjs');
      const admissionApi=await mod('packages/main/src/core/provider-process-admission.ts');
      try { const r=await runCustomAuditAdapter({command:'fixture-auditor',argv:[],cwd:root,env,stdinText:'bounded fixture',timeoutMs:1000},root,new AbortController(),{admissionApi,runner:async()=>{total++;otherCalls++;return outcome();}});
      details.auditExit=r.exitCode;
      } catch(e){if(!e.message.startsWith('host_run_budget_refused:'))throw e;details.blocked=e.message;}
    }else throw Error('Unknown scenario');
    assert.equal(await host(),false,'SHARED_BUDGET_MUST_REMAIN_EXHAUSTED');
  }
  const dir=join(root,'.proof-or-stop/runtime/host-run-budgets');
  let reservations=0;
  try{reservations=readdirSync(dir).filter(x=>x.endsWith('.json')).reduce((n,file)=>n+JSON.parse(readFileSync(join(dir,file),'utf8')).rows.length,0);}catch(e){if(e.code!=='ENOENT')throw e;}
  console.log(JSON.stringify({scenario,sharedJobCap:cap,totalTransportCalls:total,hostCalls,otherCalls,sharedReservations:reservations,details,paidCalls:0}));
  assert.ok(total<=cap,`ALL_ROUTES_SHARE_CAP: ${scenario}: ${total} > ${cap}`);
}finally{rmSync(root,{recursive:true,force:true});}
