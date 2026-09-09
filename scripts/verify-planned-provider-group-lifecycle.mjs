import assert from 'node:assert/strict';
import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';import {join} from 'node:path';
const repo=process.argv[2]??process.cwd(),base=mkdtempSync(join(os.tmpdir(),'machine-provider-orphan-'));
const home=join(base,'home');mkdirSync(home);const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:home});syncBuiltinESMExports();
const api=await import(repo+'/packages/main/dist/core/provider-process-admission.js');
const {PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT}=await import(repo+'/packages/main/dist/core/provider-process-registry.js');
const held=[];let providerPid,worker,providerGone=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stop=join(base,'stop'),identityFile=join(base,'identity.json');
const request=root=>({root,env:process.env,host:'codex',storyId:null,agentType:'orphan-probe'});
function root(name){const r=join(base,name);mkdirSync(r);execFileSync('git',['init','-q',r]);return r;}
try {
 for(let i=0;i<PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT-1;i++){const a=api.acquireProviderProcessAdmission(request(root('held'+i)));assert.ok(a.admitted);held.push(a);}
 const workerRoot=root('worker'),contenderRoot=root('contender');
 const providerFile=join(base,'provider.cjs');writeFileSync(providerFile,`const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)})){clearInterval(t);process.exit(0);}},25);`);
 const workerFile=join(base,'worker.mjs');writeFileSync(workerFile,`
import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import {spawn,execFileSync} from 'node:child_process';import {writeFileSync} from 'node:fs';
const original=os.userInfo;os.userInfo=(...a)=>({...original(...a),homedir:${JSON.stringify(home)}});syncBuiltinESMExports();
const api=await import(${JSON.stringify(repo+'/packages/main/dist/core/provider-process-admission.js')});
const {executePlannedSteps}=await import(${JSON.stringify(repo+'/packages/main/dist/core/planned-steps-executor.js')});
const {mkdirSync,chmodSync}=await import('node:fs');const bin=${JSON.stringify(join(base,'bin'))};mkdirSync(bin);
const providerFile=${JSON.stringify(providerFile)},identityFile=${JSON.stringify(identityFile)};
const shim=bin+'/codex';writeFileSync(shim, '#!'+process.execPath+'\\n'+
 'const {spawn,execFileSync}=require("node:child_process"),fs=require("node:fs");'+
 'const p=spawn('+JSON.stringify(process.execPath)+','+JSON.stringify([providerFile])+',{stdio:"ignore"});p.unref();'+
 'fs.writeFileSync('+JSON.stringify(identityFile)+',JSON.stringify({pid:p.pid,pgid:Number(execFileSync("ps",["-o","pgid=","-p",String(p.pid)],{encoding:"utf8"}).trim()),startFingerprint:execFileSync("ps",["-o","lstart=","-p",String(p.pid)],{encoding:"utf8"}).trim()}));');chmodSync(shim,0o755);
const step={stepId:'probe',type:'provider.codex',title:'probe',purpose:'probe',cwdPolicy:'story-worktree',timeoutMs:5000,maxAttempts:1,requiresCleanWorktree:false,producesEvidence:true,blocksUntilEvidenceUploaded:true,provider:'codex',evidenceBinding:'B-probe:provider',args:{operation:'implement',argv:['exec']}};
const jobPlan={schemaVersion:'lattice.job_plan.v1',plannerRunId:'probe',storyId:'B-probe',mode:'local',until:'TEST',developmentWorkflow:'standard',plannedSteps:[step],coverageMap:[],multiHostPolicy:{},providerPolicy:{allowedProviders:['codex'],credentialsEnvAllowlist:['CODEX_KEY']},plannerDigest:'p',jobPlanDigest:'j',status:'planned'};
const store={readStory:()=>({phase:'DEV'}),storyExists:()=>true,listStoryIds:()=>[],appendProcessEvent:()=>{}};
const result=executePlannedSteps({root:${JSON.stringify(workerRoot)},store,jobPlan,env:{PATH:bin+':'+process.env.PATH,CODEX_KEY:'fixture-only'}});console.log(JSON.stringify(result));if(result.steps[0].status!=='passed')process.exitCode=2;
console.log('ACTUAL_PLANNED_EXECUTED');
`);
 worker=spawn(process.execPath,[workerFile],{detached:true,stdio:['ignore','pipe','pipe']});let out='';worker.stdout.on('data',x=>out+=x);worker.stderr.on('data',x=>out+=x);
 const code=await new Promise(r=>worker.once('close',r));assert.equal(code,0,out);assert.match(out,/ACTUAL_PLANNED_EXECUTED/);
 const identity=JSON.parse(readFileSync(identityFile,'utf8'));providerPid=identity.pgid;assert.equal(identity.pgid,worker.pid,'ordinary descendant stays in isolated worker group');process.kill(-providerPid,0);
 const denied=api.acquireProviderProcessAdmission(request(contenderRoot));held.push(denied);console.log('OBSERVED admission while actual planned-provider descendant alive:',denied.admitted);assert.equal(denied.admitted,false,'RED: actual planned executor released machine slot while provider descendant still alive');
 console.log('PASS worker exited; live actual provider PGID retains machine slot');
 writeFileSync(stop,'exit');let gone=false;for(let i=0;i<200;i++){try{process.kill(-providerPid,0);}catch(e){if(e.code==='ESRCH'){gone=true;break;}if(e.code!=='EPERM')throw e; const rows=execFileSync('ps',['-axo','pgid='],{encoding:'utf8'}).trim().split(/\s+/);if(!rows.includes(String(providerPid))){gone=true;break;}}await sleep(25);}assert.ok(gone,'provider group naturally exited');providerGone=true;providerPid=undefined;
 const after=api.acquireProviderProcessAdmission(request(contenderRoot));held.push(after);assert.ok(after.admitted,'machine slot reclaimed after actual group exit');console.log('PASS natural group exit releases machine capacity for another repo');
} finally {
 if(!providerPid&&!providerGone&&existsSync(identityFile))providerPid=JSON.parse(readFileSync(identityFile,'utf8')).pgid;
 if(providerPid){try{process.kill(-providerPid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')console.error('CLEANUP_SIGNAL',e.code);}}
 if(worker?.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');
 held.forEach(a=>api.releaseProviderProcessAdmission(a));os.userInfo=original;syncBuiltinESMExports();rmSync(base,{recursive:true,force:true});
}
