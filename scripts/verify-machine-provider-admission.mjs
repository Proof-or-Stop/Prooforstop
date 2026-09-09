import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,mkdirSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
const root=mkdtempSync(join(os.tmpdir(),'machine-provider-admission-'));
// Isolate the OS-user runtime namespace in this test process; production has no
// environment switch or caller path for bypassing its canonical machine pool.
const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:join(root,'home')});syncBuiltinESMExports();
const {acquireProviderProcessAdmission,releaseProviderProcessAdmission}=await import('../packages/main/dist/core/provider-process-admission.js');
const {runHostRun}=await import('../packages/main/dist/core/host-run.js');
const {PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT,providerProcessSlotsDir}=await import('../packages/main/dist/core/provider-process-registry.js');
const admissions=[];
try{
 for(let i=0;i<=PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT;i++){
  const project=join(root,`project-${i}`);mkdirSync(project);
  admissions.push(acquireProviderProcessAdmission({root:project,env:{...process.env,PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT:'100'},host:'codex',storyId:null,agentType:'machine-capacity-witness'}));
 }
 assert.ok(admissions.slice(0,-1).every(a=>a.admitted),'positive control: available machine slots admit providers');
 assert.equal(admissions.at(-1).admitted,false,'U08 provider admission must enforce machine capacity across project roots');
 const blockedRoot=join(root,'blocked-host');mkdirSync(blockedRoot);let spawned=0;
 const blocked=await runHostRun({host:'codex',storyId:null,agentType:'machine-capacity-witness',phase:'REVIEW',promptText:'machine capacity boundary',cwd:blockedRoot,root:blockedRoot,recordedAt:new Date().toISOString(),projectRootHash:'sha256:fixture',env:{...process.env,PROOF_OR_STOP_USAGE_LEDGER:'0',PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT:'100'}},{runner:async()=>{spawned++;throw Error('must not launch');}});
 assert.equal(blocked.refusalReason,'concurrency_cap_exceeded');assert.equal(spawned,0);
 assert.equal(readdirSync(providerProcessSlotsDir(blockedRoot)).filter(n=>/^slot-\d+\.json$/.test(n)).length,0,'machine refusal must release its temporary project slot');
 releaseProviderProcessAdmission(admissions[0]);
 const next=acquireProviderProcessAdmission({root:blockedRoot,env:{...process.env,PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT:'1'},host:'codex',storyId:null,agentType:'reacquire'});admissions.push(next);assert.equal(next.admitted,true);
 const localRefusal=acquireProviderProcessAdmission({root:blockedRoot,env:{...process.env,PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT:'1'},host:'codex',storyId:null,agentType:'local-cap'});admissions.push(localRefusal);assert.equal(localRefusal.admitted,false);assert.equal(localRefusal.capacityScope,'project');
 console.log('PASS U08 machine provider cap, zero-spawn refusal, local rollback, reacquisition and lower project cap');
}finally{for(const a of admissions)releaseProviderProcessAdmission(a);os.userInfo=original;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}

execFileSync(process.execPath,[fileURLToPath(new URL('./verify-machine-provider-orphan.mjs',import.meta.url)),fileURLToPath(new URL('../',import.meta.url))],{stdio:'inherit',timeout:30000});
