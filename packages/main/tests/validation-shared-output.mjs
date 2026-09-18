#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,existsSync,statSync,utimesSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=process.cwd();
// A bounded display must exceed the receipt cap whenever it is truncated.
const executorSource=readFileSync(resolve(repo,'packages/main/src/core/validation-executor.ts'),'utf8');
const executorCap=Number(executorSource.match(/const MAX_OUTPUT_CHARS = (\d+);/)[1]);
const {CAUSAL_MAX_OUTPUT_CHARS}=await import(resolve(repo,'packages/main/dist/core/causal-evidence.js'));
assert.ok(executorCap>=CAUSAL_MAX_OUTPUT_CHARS,'Executor display cap must not fall below causal completeness cap');

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
 const context={storyId,receiptStore:store,probe:input=>probeValidationCausalPreflightFacts(ctx,storyId,input)};
 const spec={label:'validate',command:process.execPath,args:['witness.mjs'],executionReuse:'exact-inputs',executionInputs:[]};
 const run=(extra={},options={})=>runValidationCommand({...spec,...extra},root,10000,{sharedExecution:context,...options});

 const large={executionInputs:['witness.mjs'],args:['-e',`process.stdout.write('x'.repeat(${executorCap+1000}))`]};const a=await run(large),b=await run(large);for(const row of [a,b]){assert.equal(row.code,0);assert.equal(row.output.length,executorCap,'Public display includes its truncation marker within the cap; it is not complete selector output');assert.match(row.output,/truncated/);assert.equal(row.executionReceipt.disposition,'executed');assert.equal(row.executionDecision.reason,'result_not_reusable');}
 const small={executionInputs:['witness.mjs']};const original=await run(small),reused=await run(small);assert.equal(reused.executionReceipt.disposition,'reused');assert.equal(reused.output,original.output);
 const persisted=store.readCausalEvidenceReceipt(storyId,original.executionReceipt.executionKey);assert.ok(persisted);assert.ok(!JSON.stringify(persisted).includes('executionDecision'),'Diagnostics must not enter signed receipt');
 const read=store.readCausalEvidenceReceipt.bind(store);let tampered=0;store.readCausalEvidenceReceipt=(...args)=>{const r=read(...args);if(!r)return r;tampered++;return {...r,outputProbe:'FORGED_PASS'};};
 await assert.rejects(run(small),/causal_receipt_tampered/);assert.ok(tampered>0);console.log('SHARED_FULL_OUTPUT_AND_TAMPER_GREEN '+JSON.stringify({oversizedStarts:2,forgedReads:tampered,forgedReceiptRefused:true}));
}finally{process.chdir(originalCwd);rmSync(root,{recursive:true,force:true});}
