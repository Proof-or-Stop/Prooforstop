#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
const {StoryStore}=await import('../packages/main/dist/core/store.js');
const {acquireOwnerLease,getSessionId}=await import('../packages/main/dist/core/story-owner-lease.js');
const disabled=process.argv.includes('--disabled');
const workMs=Number(process.argv.find(x=>x.startsWith('--work-ms='))?.split('=')[1]??500);
assert.ok(Number.isSafeInteger(workMs)&&workMs>=0&&workMs<=5000);
const root=mkdtempSync(join(tmpdir(),'pos-real-entry-'));
const git=argv=>execFileSync('git',argv,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const storyId='B-reuse-entry',now=new Date().toISOString();
try{
 git(['init','-q','-b','main']);git(['config','user.name','Proof']);git(['config','user.email','proof@example.invalid']);
 writeFileSync(join(root,'.gitignore'),'.proof-or-stop/\n');
 mkdirSync(join(root,'packages/main'),{recursive:true});writeFileSync(join(root,'packages/main/package.json'),readFileSync(join(repo,'packages/main/package.json')));
 writeFileSync(join(root,'witness.mjs'),"import {randomUUID} from 'node:crypto';await new Promise(r=>setTimeout(r,"+workMs+"));console.log('ENTRY_WITNESS '+randomUUID());\n");
 const cmd={label:'entry witness',command:process.execPath,args:['witness.mjs'],focus:['proof'],executionReuse:disabled?undefined:'exact-inputs',executionInputs:[],timeoutMs:10000};
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives',validate:{dynamic:{mode:'off'},commands:[cmd]},doneRequiredCommands:[cmd]}));
 git(['add','.']);git(['commit','-qm','immutable fixture']);
 const store=new StoryStore(root);
 store.writeStory(storyId,{storyId,name:'entry-proof',title:'Entry proof',description:'Isolated experimental input; not formal lifecycle evidence.',type:'chore',phase:'TEST',priority:'medium',createdAt:now,startedAt:now,endedAt:null});
 store.writeChecklist(storyId,{items:[]});
 acquireOwnerLease(store.storyDirPath(storyId),{command:'validate',cwd:root});
 const env={...process.env,PROOF_OR_STOP_SESSION_ID:getSessionId()};
 const commands=[['validate',{storyId,focus:'proof',dynamicMode:'off',json:true,noSync:true}],['validate',{storyId,focus:'proof',dynamicMode:'off',json:true,noSync:true}]];
 const reports=[];const start=performance.now();
 for(const [command,args]of commands){const r=spawnSync(process.execPath,[join(repo,'bin/proof-or-stop.js'),'--root',root,command,JSON.stringify(args)],{cwd:root,env,encoding:'utf8',timeout:60000,maxBuffer:4e6});console.log('ENTRY '+JSON.stringify({command,args,status:r.status,stdout:r.stdout,stderr:r.stderr}));assert.equal(r.status,0);reports.push(JSON.parse(r.stdout));}
 assert.equal(reports[0].commandExecutions,1);
 assert.equal(reports[1].commandExecutions,disabled?1:0);
 assert.equal(reports[0].commands[0].output===reports[1].commands[0].output,!disabled);
 for(const report of reports)assert.equal(report.focus.doneRequiredProof,false);
 const {persistSyntheticAdmittedWindowForTest}=await import('../packages/main/dist/core/certification-window.js');
 const {deriveCertificationDomainInputHashes}=await import('../packages/main/dist/handlers/certification-window.js');
 const causalInputHashes=deriveCertificationDomainInputHashes(root,'HEAD',root);assert.ok(causalInputHashes);
 persistSyntheticAdmittedWindowForTest({store,storyId,projectRoot:root,causalInputHashes});
 const done=spawnSync(process.execPath,[join(repo,'bin/proof-or-stop.js'),'--root',root,'done_required_validate',JSON.stringify({storyId,json:true})],{cwd:root,env,encoding:'utf8',timeout:60000,maxBuffer:4e6});
 console.log('DONE_ENTRY '+JSON.stringify({status:done.status,stdout:done.stdout,stderr:done.stderr}));
 assert.equal(done.status,0,'DONE_REQUIRED_ENTRY_FAILED');
 const doneReport=JSON.parse(done.stdout);assert.equal(doneReport.status,'PASS');
 assert.equal(doneReport.receipts.length,1);
 const doneReceipt=doneReport.receipts[0];
 if(disabled){assert.equal(doneReceipt.executionDecision.reason,'not_opted_in');}
 else{assert.equal(doneReceipt.executionReceipt.disposition,'reused');assert.equal(doneReceipt.executionReceipt.receiptHash,reports[0].commands[0].executionReceipt.receiptHash);}
 const doneExecutions=doneReceipt.executionReceipt?.disposition==='reused'?0:1;

 const summary={disabled,workMs,totalExecutions:reports.reduce((n,r)=>n+r.commandExecutions,0)+doneExecutions,elapsedMs:performance.now()-start,formalStoryDone:false};
 const out=process.env.REUSE_PROOF_OUTPUT;if(out){mkdirSync(out,{recursive:true});writeFileSync(join(out,disabled?'entry-disabled.json':'entry-enabled.json'),JSON.stringify({summary,reports,doneReport},null,2));}
 console.log('ENTRYPOINT_GREEN '+JSON.stringify(summary));
}finally{rmSync(root,{recursive:true,force:true});}
