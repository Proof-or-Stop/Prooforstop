#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,existsSync,statSync,utimesSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=process.cwd();

const {runValidationCommand}=await import(resolve(repo,'packages/main/dist/core/validation-executor.js'));
const shared=await import(resolve(repo,'packages/main/dist/core/shared-validation-execution.js'));
const {StoryStore}=await import(resolve(repo,'packages/main/dist/core/store.js'));
const {acquireOwnerLease}=await import(resolve(repo,'packages/main/dist/core/story-owner-lease.js'));
const {probeValidationCausalPreflightFacts}=await import(resolve(repo,'packages/main/dist/handlers/verifier.js'));
const root=mkdtempSync(join(tmpdir(),'pos-reuse-proof-'));
const originalCwd=process.cwd();
const git=argv=>execFileSync('git',argv,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const evidence=[];
const check=(name,actual)=>{evidence.push({name,...actual});console.log('PROOF '+JSON.stringify({name,...actual}));};
try{
 git(['init','-q','-b','main']);git(['config','user.name','Reuse proof']);git(['config','user.email','proof@example.invalid']);
 writeFileSync(join(root,'.gitignore'),'.proof-or-stop/\n');
 mkdirSync(join(root,'packages/main'),{recursive:true});writeFileSync(join(root,'packages/main/package.json'),readFileSync(join(repo,'packages/main/package.json')));
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'proof-fixture',version:'1.0.0'}));
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
 writeFileSync(join(root,'witness.mjs'),"import {randomUUID} from 'node:crypto';await new Promise(r=>setTimeout(r,150));console.log('WITNESS '+randomUUID());\n");
 git(['add','.']);git(['commit','-qm','fixed witness inputs']);git(['status','--porcelain']);
 process.chdir(root);
 const store=new StoryStore(root),storyId='B-reuse-proof';
 acquireOwnerLease(store.storyDirPath(storyId),{command:'validate',cwd:root});
 const ctx={root,store,scanRoot:root};
 let probes=0; const context={storyId,receiptStore:store,reuseEconomics:'measured',probe:input=>{probes++;return probeValidationCausalPreflightFacts(ctx,storyId,input)}};
 const spec={label:'validate',command:process.execPath,args:['witness.mjs'],executionReuse:'exact-inputs',executionInputs:[]};
 const run=(extra={},options={})=>runValidationCommand({...spec,...extra},root,10000,{sharedExecution:context,...options});


 const generated=join(root,'.proof-or-stop','economics-command.mjs');const executions=join(root,'.proof-or-stop','executions.txt');writeFileSync(generated,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(executions)},'run\\n');console.log('CHEAP_REAL_EXECUTION')`);
 const command={...spec,args:[generated],executionInputs:[generated]};
 const first=await runValidationCommand(command,root,10000,{sharedExecution:context});assert.equal(first.code,0);
 const before=probes;let implementationReads=0;
 const originalRead=fs.readFileSync;
 fs.readFileSync=function(path,...args){if(String(path).startsWith(resolve(repo,'packages/main/dist')))implementationReads++;return originalRead.call(this,path,...args);};syncBuiltinESMExports();
 let second;try{second=await runValidationCommand(command,root,10000,{sharedExecution:context});}finally{fs.readFileSync=originalRead;syncBuiltinESMExports();}
 assert.equal(implementationReads,0,'Direct execution must not rescan implementation identity');
 const secondProbes=probes-before;assert.equal(second.code,0);assert.equal(secondProbes,2,'UNECONOMIC_REUSE_MUST_KEEP_ONLY_EXECUTION_ADMISSION');
 assert.equal(second.executionDecision?.reason,'reuse_cost_exceeds_execution');assert.equal(second.executionReceipt,undefined);
 const originalProbe=context.probe;
 const refused=[['writerLease',{available:true,valid:false}],['cli',{available:false}],['worktree',{expected:root,actual:'/wrong'}],['gitIndex',{readable:false}],['gitMaterial',{available:false}],['providerCapability',{required:['missing'],available:[]}],['resources',{required:{cpu:1},available:{cpu:0}}],['evidenceTarget',{writable:false}],['sideChannel',{available:false}]];
 const executionLedger=readFileSync(executions,'utf8');
 for(const [field,value] of refused){
   context.probe=input=>({...originalProbe(input),[field]:value});
   await assert.rejects(runValidationCommand(command,root,10000,{sharedExecution:context}),/preflight refused/);
 }
 assert.equal(readFileSync(executions,'utf8'),executionLedger,'Rejected admission must launch zero children');
 context.probe=originalProbe;
 const abort=new AbortController();abort.abort(new Error('ECONOMICS_CANCELLED'));
 await assert.rejects(runValidationCommand(command,root,10000,{sharedExecution:context,abortSignal:abort.signal}),/ECONOMICS_CANCELLED/);
 writeFileSync(generated,"console.log('CHANGED_MUST_EXECUTE');process.exitCode=7");
 const changed=await runValidationCommand(command,root,10000,{sharedExecution:context});assert.equal(changed.code,7);assert.match(changed.output,/CHANGED_MUST_EXECUTE/);assert.equal(changed.executionReceipt,undefined);
 const afterFailure=probes;await runValidationCommand(command,root,10000,{sharedExecution:context});assert.ok(probes>afterFailure,'Failure must clear the economic hint');
 writeFileSync(generated,"console.log('NEW_FAST_WITNESS')");
 await runValidationCommand(command,root,10000,{sharedExecution:context});
 writeFileSync(generated,"await new Promise(r=>setTimeout(r,3000));console.log('LONG_WITNESS')");
 const slower=await runValidationCommand(command,root,10000,{sharedExecution:context});assert.equal(slower.code,0);assert.equal(slower.executionDecision?.reason,'reuse_cost_exceeds_execution');
 const afterSlow=probes;const longFresh=await runValidationCommand(command,root,10000,{sharedExecution:context});assert.equal(longFresh.code,0);assert.ok(probes>afterSlow+2,'Slower command must clear hint');
 const longReuse=await runValidationCommand(command,root,10000,{sharedExecution:context});assert.equal(longReuse.executionReceipt?.disposition,'reused');
 console.log('ECONOMIC_LONG_TRANSITION_GREEN slowClearsHint fullChecksThenReuse');
 console.log('ECONOMIC_NEGATIVES_GREEN changedCommand actualFailure cancellation nineAdmissionNegatives hintCleared');
 console.log('ECONOMIC_ADMISSION_GREEN '+JSON.stringify({first:first.durationMs,second:second.durationMs,secondProbes}));
}finally{process.chdir(originalCwd);rmSync(root,{recursive:true,force:true});}
