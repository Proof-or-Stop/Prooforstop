#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,existsSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
const script=fileURLToPath(import.meta.url),storyId='B-longoutput';
const lab=dirname(dirname(dirname(script)));
const runtime=process.argv[2]==='--worker'?join(process.argv[3],'runtime'):lab;
const {StoryStore}=await import('file://'+join(runtime,'packages/main/dist/core/store.js'));
const {createChecklistHandlers}=await import('file://'+join(runtime,'packages/main/dist/handlers/checklist.js'));
const {acquireOwnerLease}=await import('file://'+join(runtime,'packages/main/dist/core/story-owner-lease.js'));
process.env.PROOF_OR_STOP_SESSION_ID='five-item-long-output';
const request={storyId,evidences:[{itemId:'CHK-001',intentRef:'I-1',kind:'integration_test',command:'node witness.mjs',selector:'PUBLISH_RESTART_OK',note:'Recover the original successful execution after the publishing process exits.'}]};
if(process.argv[2]==='--worker'){
 const [fixture,mode]=process.argv.slice(3),store=new StoryStore(fixture);
 const handlers=createChecklistHandlers({store,root:fixture,scanRoot:join(fixture,'packages/main')});
 if(mode!=='restored')store.writeChecklist=()=>{throw new Error('INJECTED_PENDING_PUBLICATION_FAILURE');};

 try{console.log(await handlers.verification_evidence_batch_add(request));}
 catch(error){console.error(String(error.stack));process.exitCode=70;}
}else{
 const output=process.env.FIVE_ITEM_PROOF_OUTPUT||join(tmpdir(),'publication-restart-'+Date.now());mkdirSync(output,{recursive:true});
 const fixture=mkdtempSync(join(tmpdir(),'pub-restart-fixture-'));
 const git=args=>execFileSync('git',args,{cwd:fixture,stdio:'pipe',encoding:'utf8'}).trim();
 const write=(path,value)=>{mkdirSync(dirname(join(fixture,path)),{recursive:true});writeFileSync(join(fixture,path),value);};
 try{
  write('proof-or-stop.config.json',JSON.stringify({scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives',requirementsDir:'docs/requirements'}));
  write('packages/main/package.json',JSON.stringify({name:'@proof-or-stop/core',version:'0.0.0-fixture'}));write('packages/main/src/base.ts','export const base=true;\n');
  write('.gitignore','.proof-or-stop/runtime/\n.proof-or-stop/locks/\n.counts\nruntime/\n');
  write('witness.mjs',"import {appendFileSync} from 'node:fs';appendFileSync('.counts','executed\\n');console.log('PUBLISH_RESTART_OK');\n");
  git(['init','-q','-b','work']);git(['config','user.name','Lab fixture']);git(['config','user.email','fixture@example.test']);git(['add','.']);git(['commit','-qm','isolated fixture']);git(['branch','main']);
  const store=new StoryStore(fixture),now=new Date().toISOString();
  store.writeStory(storyId,{storyId,name:'publication-restart-fixture',title:'Recover successful command after process exit',description:'Isolated fault injection fixture',type:'chore',phase:'DEV',priority:'medium',createdAt:now,startedAt:now,endedAt:null});
  store.writeChecklist(storyId,{items:[{id:'CHK-001',title:'Preserve original command receipt',context:'Retry canonical publication without running again',status:'in_progress',startTime:null,endTime:null,verificationIntent:{happy:[{id:'I-1',desc:'Original successful command receipt is imported',type:'cli',priority:'must'},{id:'I-2',desc:'A second intent reuses the complete original output',type:'cli',priority:'must'},{id:'I-3',desc:'Changed runtime executes anew',type:'cli',priority:'must'},{id:'I-4',desc:'Restored runtime reuses its original receipt',type:'cli',priority:'must'}],edge:[],adversarial:[]}}]});
  acquireOwnerLease(store.storyDirPath(storyId),{command:'isolated-fixture',cwd:fixture});
  for(const name of ['main','utils','lab']){const dest=join(fixture,'runtime/packages',name);mkdirSync(dest,{recursive:true});for(const sub of ['dist','package.json'])if(existsSync(join(lab,'packages',name,sub)))cpSync(join(lab,'packages',name,sub),join(dest,sub),{recursive:true,verbatimSymlinks:true});}
  for(const path of ['node_modules','bin','scripts','packages/main/templates'])cpSync(join(lab,path),join(fixture,'runtime',path),{recursive:true,verbatimSymlinks:true});
  cpSync(join(lab,'package.json'),join(fixture,'runtime/package.json'));
  const helper=join(fixture,'runtime/scripts/build-lock-target.mjs'),original=readFileSync(helper);
  const runs=[];
  for(const mode of ['first','same','changed','restored']){
   if(mode==='changed')appendFileSync(helper,'\n// Same version bootstrap bytes changed\n');
   if(mode==='restored')writeFileSync(helper,original);
   const start=performance.now();const result=spawnSync(process.execPath,[script,'--worker',fixture,mode],{cwd:fixture,encoding:'utf8',timeout:60000,env:{...process.env}});
   writeFileSync(join(output,mode+'.log'),result.stdout+result.stderr);
   runs.push({mode,elapsedMs:performance.now()-start,exitCode:result.status,executions:readFileSync(join(fixture,'.counts'),'utf8').trim().split('\n').length});
   assert.equal(result.status,mode==='restored'?0:70,'EVIDENCE_HANDLER_EXECUTION_FAILED: '+result.stdout+result.stderr);
   if(mode!=='restored')assert.match(result.stderr,/INJECTED_PENDING_PUBLICATION_FAILURE/);
   if(mode==='restored')assert.match(result.stdout,/commandExecutions=0/);
   assert.equal(runs.at(-1).executions,['changed','restored'].includes(mode)?2:1,'EVIDENCE_HANDLER_IMPLEMENTATION_NOT_BOUND');

  }
  assert.equal(runs[0].executions,1);assert.equal(runs[1].executions,1,'LONG_OUTPUT_FANOUT_RERAN_COMMAND');
  const allEvidence=store.readChecklist(storyId).items[0].verificationEvidence;assert.equal(allEvidence.length,1);const evidence=allEvidence[0];assert.equal(evidence.result,'pass');assert.equal(evidence.receipt.exitCode,0);
  writeFileSync(join(output,'results.json'),JSON.stringify({runs,evidence,commandExecutions:2,publicationAttempts:4,canonicalConsumers:1,limitations:['This fixture exercises pending-publication recovery and same-version implementation invalidation across independent handler processes; it does not measure full-Story delivery time.']},null,2));
  console.log('EVIDENCE_HANDLER_IMPLEMENTATION_GREEN');
 }finally{rmSync(fixture,{recursive:true,force:true});}
}
