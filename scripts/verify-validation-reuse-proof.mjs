#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
execFileSync(process.execPath,['scripts/ensure-dist.mjs'],{cwd:repo,stdio:'inherit'});
const {runValidationCommand}=await import('../packages/main/dist/core/validation-executor.js');
const shared=await import('../packages/main/dist/core/shared-validation-execution.js');
const {StoryStore}=await import('../packages/main/dist/core/store.js');
const {acquireOwnerLease}=await import('../packages/main/dist/core/story-owner-lease.js');
const {probeValidationCausalPreflightFacts}=await import('../packages/main/dist/handlers/verifier.js');
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
 // Target RED is absent runtime explanation, not a dependency/bootstrap failure.
 const undeclared=await run({executionReuse:undefined});assert.equal(undeclared.code,0);assert.match(undeclared.output,/WITNESS /);
 assert.ok(undeclared.executionDecision,'REUSE_PROOF_MISSING_EXECUTION_REASON');
 assert.equal(undeclared.executionDecision.reason,'not_opted_in');
 check('undeclared policy explains real execution',undeclared.executionDecision);
 const first=await run(),second=await run({label:'done-required'});
 assert.equal(first.code,0);assert.equal(second.code,0);assert.equal(first.output,second.output);
 assert.equal(first.executionReceipt.disposition,'executed');assert.equal(second.executionReceipt.disposition,'reused');
 assert.equal(first.executionReceipt.receiptHash,second.executionReceipt.receiptHash);
 check('real disk receipt and real preflight reused',{first:first.executionDecision,second:second.executionDecision,receipt:first.executionReceipt});
 for(const [name,extra,reason] of [
  ['forbidden',{fullBaselineReusePolicy:'forbidden'},'policy_forbidden'],
  ['never-reuse',{closurePolicy:'never-reuse'},'policy_never_reuse'],
  ['gate',{riskTier:'gate'},'policy_risk_tier'],
  ['validation-infra',{riskTier:'validation-infra'},'policy_risk_tier'],
  ['build-producer',{providesBuildProof:'main'},'build_proof_required'],
  ['build-consumer',{requiresBuildProof:'main'},'build_proof_required'],
  ['missing-input-contract',{executionInputs:undefined},'inputs_undeclared'],
 ]){
  const a=await run(extra),b=await run(extra);assert.equal(a.code,0);assert.equal(b.code,0);assert.notEqual(a.output,b.output);
  assert.equal(a.executionDecision.reason,reason);assert.equal(b.executionDecision.reason,reason);check(name,{reason,executions:2});
 }
 const noContext=await runValidationCommand(spec,root,10000);assert.equal(noContext.executionDecision.reason,'shared_context_unavailable');
 const env=await run({env:{PROOF_WITNESS_INPUT:'changed'}});assert.notEqual(env.output,first.output);assert.equal(env.executionDecision.reason,'no_matching_receipt');
 const changedTimeout=await runValidationCommand(spec,root,10001,{sharedExecution:context});assert.notEqual(changedTimeout.output,first.output);
 const external=join(root,'.proof-or-stop','external.txt');writeFileSync(external,'a');
 const ea=await run({executionInputs:[external]});writeFileSync(external,'b');const eb=await run({executionInputs:[external]});assert.notEqual(ea.output,eb.output);
 const missing=await run({executionInputs:[join(root,'missing-input')]});assert.equal(missing.executionDecision.reason,'input_unreadable');
 writeFileSync(join(root,'untracked.txt'),'dirty');const dirty=await run();assert.equal(dirty.executionDecision.reason,'workspace_dirty');rmSync(join(root,'untracked.txt'));
 const failure={args:['-e',"console.log('FAIL '+Math.random());process.exitCode=1"]};
 const fa=await run(failure),fb=await run(failure);assert.equal(fa.code,1);assert.equal(fb.code,1);assert.notEqual(fa.output,fb.output);assert.equal(fa.executionDecision.reason,'execution_failed');
 check('identity changes and failed results never reuse',{environment:true,timeout:true,externalInput:true,missingInput:true,dirtyWorkspace:true,failure:true});
 const tampered={...store.readCausalEvidenceReceipt(storyId,first.executionReceipt.executionKey),outputProbe:'tampered'};
 assert.throws(()=>store.writeCausalEvidenceReceipt(storyId,tampered),/invalid|partial/);
 const abort=new AbortController();abort.abort(new Error('proof cancellation'));
 await assert.rejects(run({}, {abortSignal:abort.signal}),/proof cancellation/);
 writeFileSync(join(root,'witness.mjs'),readFileSync(join(root,'witness.mjs'),'utf8')+'// material change\n');git(['add','witness.mjs']);git(['commit','-qm','material counter control']);
 const material=await run();assert.notEqual(material.output,first.output);assert.equal(material.executionReceipt.disposition,'executed');
 const pair=await Promise.all([run({env:{PROOF_CONCURRENT:'same'}}),run({env:{PROOF_CONCURRENT:'same'}})]);
 assert.equal(pair[0].output,pair[1].output,'concurrent callers must share the actual child result');
 check('concurrent attribution',{dispositions:pair.map(x=>x.executionReceipt.disposition),runtimeSpawns:pair.filter(x=>x.runtimeTrace?.events.includes('spawn')).length});
 assert.equal(pair.filter(x=>x.executionReceipt.disposition==='executed').length,1,'REUSE_PROOF_CONCURRENT_EXECUTIONS_OVERCOUNTED');
 const config=JSON.parse(readFileSync(join(repo,'proof-or-stop.config.json')));
 const inventory=[...config.validate.commands.map((command,index)=>({consumer:'validate',index,command})),...config.doneRequiredCommands.map((command,index)=>({consumer:'done_required',index,command}))];
 const audit=inventory.map(row=>({...row,decision:shared.sharedValidationReusePolicy(row.command)}));
 assert.equal(audit.length,167,'Merged v0.3.317 inventory must include every validate and DONE-required command');assert.ok(audit.every(row=>row.decision.reason));
 assert.ok(audit.filter(x=>x.consumer==='done_required').every(x=>x.decision.reason==='build_proof_required'));
 const out=process.env.REUSE_PROOF_OUTPUT;if(out){mkdirSync(out,{recursive:true});writeFileSync(join(out,'inventory.json'),JSON.stringify(audit,null,2));writeFileSync(join(out,'proof.json'),JSON.stringify(evidence,null,2));}
 for(const flags of [[],['--disabled']]){const output=execFileSync(process.execPath,['scripts/probe-reuse-entrypoints.mjs',...flags],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});assert.match(output,/ENTRYPOINT_GREEN/);console.log(output.trim().split('\n').at(-1));}
 console.log('REUSE_PROOF_GREEN: real child executions, disk receipts, production preflight, policy and identity controls, 167-command inventory');
}finally{process.chdir(originalCwd);rmSync(root,{recursive:true,force:true});}
