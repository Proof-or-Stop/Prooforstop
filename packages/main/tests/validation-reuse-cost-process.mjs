import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=process.cwd(),self=fileURLToPath(import.meta.url);
if(process.argv[2]==='--child'){
 const root=process.argv[3];
 const {StoryStore}=await import(resolve(repo,'packages/main/dist/core/store.js'));
 const {acquireOwnerLease,releaseOwnerLease}=await import(resolve(repo,'packages/main/dist/core/story-owner-lease.js'));
 const {runValidationCommand}=await import(resolve(repo,'packages/main/dist/core/validation-executor.js'));
 const {probeValidationCausalPreflightFacts}=await import(resolve(repo,'packages/main/dist/handlers/verifier.js'));
 process.chdir(root);const store=new StoryStore(root),storyId='B-cost-process';
 acquireOwnerLease(store.storyDirPath(storyId),{command:'validate',cwd:root});
 try{let probes=0;const context={storyId,receiptStore:store,reuseEconomics:'measured',probe:input=>{probes++;return probeValidationCausalPreflightFacts({root,store,scanRoot:root},storyId,input)}};
 const command={command:process.execPath,args:[join(root,'.proof-or-stop/command.mjs')],executionReuse:'exact-inputs',executionInputs:[join(root,'.proof-or-stop/command.mjs')]};
 const t=performance.now();const result=await runValidationCommand(command,root,10000,{sharedExecution:context});
 console.log('RESULT '+JSON.stringify({seconds:(performance.now()-t)/1000,probes,code:result.code,reason:result.executionDecision?.reason,receipt:result.executionReceipt?.disposition,output:result.output}));
 }finally{releaseOwnerLease(store.storyDirPath(storyId));}
}else{
 const root=mkdtempSync(join(tmpdir(),'reuse-process-'));const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 try{git(['init','-q','-b','main']);git(['config','user.name','Lab']);git(['config','user.email','lab@example.invalid']);mkdirSync(join(root,'packages/main'),{recursive:true});writeFileSync(join(root,'packages/main/package.json'),readFileSync(join(repo,'packages/main/package.json')));writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'.gitignore'),'.proof-or-stop/\n');writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.'}));git(['add','.']);git(['commit','-qm','temporary cost fixture']);mkdirSync(join(root,'.proof-or-stop'),{recursive:true});writeFileSync(join(root,'.proof-or-stop/command.mjs'),`await new Promise(r=>setTimeout(r,${Number(process.env.LAB_WORK_MS ?? 20)}));console.log('ACTUAL_CHILD')`);
 const run=()=>{const t=performance.now();const p=spawnSync(process.execPath,[...process.execArgv,self,'--child',root],{cwd:repo,encoding:'utf8',timeout:30000});assert.equal(p.status,0,p.stdout+p.stderr);const result=JSON.parse(p.stdout.split('\n').find(x=>x.startsWith('RESULT ')).slice(7));return {...result,processSeconds:(performance.now()-t)/1000};};
 const first=run(),second=run();console.log('PAIR '+JSON.stringify({first,second}));
 if(process.env.LAB_BENCH_ONLY!=='1'){assert.equal(second.reason,'reuse_cost_exceeds_execution','NEW_PROCESS_MUST_NOT_RELEARN_UNECONOMIC_COMMAND');assert.equal(second.probes,2);assert.equal(second.receipt,undefined);assert.match(second.output,/ACTUAL_CHILD/);const cache=join(root,'.proof-or-stop/runtime/validation-reuse-costs.json');const good=readFileSync(cache,'utf8');writeFileSync(cache,'{broken');const corrupt=run();assert.notEqual(corrupt.reason,'reuse_cost_exceeds_execution');assert.equal(corrupt.code,0);
 writeFileSync(cache,good);writeFileSync(join(root,'.proof-or-stop/command.mjs'),"console.log('NEW_CODE_FAILURE');process.exitCode=7");const changed=run();assert.equal(changed.code,7);assert.match(changed.output,/NEW_CODE_FAILURE/);assert.equal(changed.receipt,undefined);
 console.log('CROSS_PROCESS_COST_GREEN corruptFallback changedInputNeverOldPass');}
 }finally{rmSync(root,{recursive:true,force:true});}
}
