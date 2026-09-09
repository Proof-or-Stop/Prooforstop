import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
const repo=resolve('.');
const {submitManagedHostRun,runManagedHostRunWorker,managedHostRunDirectory}=await import(repo+'/packages/main/dist/core/managed-host-run.js');
const {defaultHostRunRunner}=await import(repo+'/packages/main/dist/core/host-run.js');
const {currentMaterialHash}=await import(repo+'/packages/main/dist/core/evidence-freshness.js');
const root=mkdtempSync(join(tmpdir(),'reviewer-temp-fixture-'));
const observed=[];
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
try {
 git('init','-b','main');git('config','user.name','Temp isolation fixture');git('config','user.email','fixture@example.test');
 writeFileSync(join(root,'source.txt'),'immutable fixture source\n');git('add','.');git('commit','-m','seed');
 const headHash=git('rev-parse','HEAD'),materialHash=currentMaterialHash(root);
 for(const runId of ['reviewer-temp-a','reviewer-temp-b']) {
  let worker;
  const submitted=await submitManagedHostRun({root,cwd:root,host:'codex',storyId:'B-temp',phase:'REVIEW',agentType:'lattice-review-quality',reviewRunId:'B-temp:'+runId,lane:'lattice-review-quality',
   promptText:'Isolated provider temp regression '+runId,deadlineMs:15000,projectRootHash:'sha256:temp-fixture',profile:'managed_reviewer',isolateManagedReview:true,
   reviewBinding:{headHash,materialHash,storyFilesHash:'sha256:fixture',promptHash:'sha256:fixture',managedPromptDigest:'sha256:'+'a'.repeat(64),envelopeId:null}},
   {randomId:()=>runId,claimTimeoutMs:2000,claimPollMs:5,launchWorker:request=>{
    worker=runManagedHostRunWorker(request,{env:{PROOF_OR_STOP_USAGE_LEDGER:'0'},runner:async plan=>{
     const code="const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const marker=fs.mkdtempSync(path.join(os.tmpdir(),'lane-marker-'));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({cwd:process.cwd(),temp:os.tmpdir(),marker,aliases:[process.env.TMPDIR,process.env.TMP,process.env.TEMP]})}}));";
     let transcript='';
     const result=await defaultHostRunRunner({...plan,onChunk:chunk=>{plan.onChunk?.(chunk);if(chunk.stream==='stdout') {transcript+=chunk.text;assert.ok(transcript.length<8192,'fixture output bounded');}},command:process.execPath,argv:['-e',code],stdinText:''});
     const event=JSON.parse(transcript.trim());observed.push(JSON.parse(event.item.text));return result;
    }});return {pid:process.pid};
   }});
  const terminal=await worker;
  assert.equal(terminal.replacementSafe,true,'real provider process is reaped');
  const spec=JSON.parse(readFileSync(join(managedHostRunDirectory(root,submitted.runId),'spec.json'),'utf8'));
  observed.at(-1).scratch=spec.managedReviewScratch;
 }
 assert.notEqual(observed[0].cwd,observed[1].cwd,'control: source worktrees already isolated');
 assert.notEqual(observed[0].temp,observed[1].temp,'U08 managed reviewer lanes must have distinct owned temporary roots');
 for(const lane of observed) {
  assert.equal(dirname(resolve(lane.temp)),resolve(lane.scratch.parent),'temp root is under sealed scratch parent');
  assert.ok(lane.aliases.every(value=>resolve(value)===resolve(lane.temp)),'all common temp aliases agree');
  assert.equal(existsSync(lane.marker),false,'terminal cleanup removes provider temp writes');
  assert.equal(existsSync(lane.scratch.parent),false,'terminal cleanup removes owned parent');
 }
 console.log('PASS U08 real provider temporary roots are isolated and cleaned');
} finally {for(const lane of observed) rmSync(lane.marker,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});}
