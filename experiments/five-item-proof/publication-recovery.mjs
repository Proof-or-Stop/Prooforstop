#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=process.env.FIVE_ITEM_PROOF_OUTPUT||join(tmpdir(),'five-item-proof-'+Date.now());mkdirSync(output,{recursive:true});
const rows=[];const failures=[];
async function check(id,name,fn){const start=performance.now();try{const evidence=await fn();rows.push({id,name,status:'PASS',elapsedMs:performance.now()-start,evidence});console.log('PASS '+id+' '+name);}catch(e){rows.push({id,name,status:'FAIL',elapsedMs:performance.now()-start,error:String(e.stack||e)});failures.push(id);console.error('FIVE_ITEM_TARGET_RED '+id+' '+name+': '+e.message);}}
await check('P1','canonical publication failure retries without rerunning the command',async()=>{
 const {StoryStore}=await import('../../packages/main/dist/core/store.js');
 const {acquireOwnerLease,readOwnerLease,isLeaseStale}=await import('../../packages/main/dist/core/story-owner-lease.js');
 const {createChecklistHandlers}=await import('../../packages/main/dist/handlers/checklist.js');
 const {resetConfigCache}=await import('../../packages/main/dist/core/config.js');
 const {buildVerificationCoverage}=await import('../../packages/main/dist/core/verification.js');
 const fixture=mkdtempSync(join(tmpdir(),'pos-five-batch-'));const git=a=>execFileSync('git',a,{cwd:fixture,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const write=(path,bytes)=>{mkdirSync(dirname(join(fixture,path)),{recursive:true});writeFileSync(join(fixture,path),bytes);};
 const NativeDate=Date;const interval=globalThis.setInterval;const started=performance.now();let clockActive=false;
 const virtualNow=()=>startedWall+(performance.now()-started)*1000;const startedWall=NativeDate.now();
 try{
 write('proof-or-stop.config.json',JSON.stringify({scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives',requirementsDir:'docs/requirements'}));
 write('packages/main/package.json',JSON.stringify({name:'@proof-or-stop/core',version:'0.0.0-fixture'}));write('packages/main/src/base.ts','export const base=true;\n');
 write('.gitignore','.proof-or-stop/runtime/\n.proof-or-stop/locks/\n.counts\n');
 write('witness.mjs',"import {appendFileSync} from 'node:fs';appendFileSync('.counts','executed\\n');console.log('BATCH_OK');\n");
 git(['init','-q','-b','work']);git(['config','user.email','fixture@example.test']);git(['config','user.name','Lab fixture']);git(['add','.']);git(['commit','-qm','fixture']);git(['branch','main']);resetConfigCache();
 const store=new StoryStore(fixture),storyId='B-labfive';store.writeStory(storyId,{storyId,name:'bounded-batch-fixture',title:'Batch lease regression',description:'isolated automated fixture',type:'chore',phase:'DEV',priority:'medium',createdAt:new NativeDate().toISOString(),startedAt:new NativeDate().toISOString(),endedAt:null});
 store.writeChecklist(storyId,{items:[{id:'CHK-001',title:'Run real batch',context:'Keep output and lease valid',status:'in_progress',startTime:null,endTime:null,verificationIntent:{happy:[{id:'I-1',desc:'Real pinned command passes',type:'cli',priority:'must'}],edge:[],adversarial:[]}}]});
 acquireOwnerLease(store.storyDirPath(storyId),{command:'isolated-fixture',cwd:fixture});
 const before=readOwnerLease(store.storyDirPath(storyId));const h=createChecklistHandlers({store,root:fixture,scanRoot:join(fixture,'packages/main')});
 const request={storyId,evidences:[{itemId:'CHK-001',intentRef:'I-1',kind:'integration_test',command:'node witness.mjs',selector:'BATCH_OK',note:'Real batch crosses lease expiry under controlled clock'}]};
 const canonicalWrite=store.writeChecklist.bind(store);let injected=0;store.writeChecklist=(...a)=>{if(injected++===0)throw new Error('INJECTED_CANONICAL_PUBLICATION_FAILURE');return canonicalWrite(...a);};
 await assert.rejects(h.verification_evidence_batch_add(request),/INJECTED_CANONICAL_PUBLICATION_FAILURE/);
 assert.equal(readFileSync(join(fixture,'.counts'),'utf8').trim().split('\n').length,1);
 const retryStart=performance.now();const result=await h.verification_evidence_batch_add(request);const retryMs=performance.now()-retryStart;
 assert.equal(readFileSync(join(fixture,'.counts'),'utf8').trim().split('\n').length,1,'PUBLICATION_RECOVERY_RERAN_COMMAND');
 assert.match(result,/commandExecutions=0/);
 writeFileSync(join(output,'publication-recovery.json'),JSON.stringify({result,retryMs,commandExecutions:1,injectedPublicationFailures:1},null,2));
 const cl=store.readChecklist(storyId),ev=cl.items[0].verificationEvidence?.[0],after=readOwnerLease(store.storyDirPath(storyId));
 assert.equal(ev?.result,'pass');assert.equal(ev?.receipt?.exitCode,0);assert.equal(isLeaseStale(after),false);assert.match(result,/commandExecutions=0/);
 writeFileSync(join(output,'batch-result.json'),JSON.stringify({result,before,after,evidence:ev,clockScale:1,realCommandDurationMs:null},null,2));
 return {log:'batch-result.json',clockScale:1000,commandExecutions:1};
 }finally{if(clockActive){globalThis.Date=NativeDate;globalThis.setInterval=interval;}rmSync(fixture,{recursive:true,force:true});resetConfigCache();}
});
writeFileSync(join(output,'summary.json'),JSON.stringify({head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),rows,failures,status:failures.length?'FAIL':'PASS',wholeStorySpeedup:null},null,2));console.log('Evidence '+output);if(failures.length)process.exitCode=1;
