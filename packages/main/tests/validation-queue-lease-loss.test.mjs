import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {withWorkspaceValidationCapacity,withOfficialValidationExecution} from '../dist/core/validation-execution-lock.js';
import {acquireOwnerLease,releaseOwnerLease,readOwnerLease} from '../dist/core/story-owner-lease.js';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rows=[], failures=[];
async function scenario(kind,replicate) {
 const root=mkdtempSync(join(tmpdir(),'pos-queue-lease-'));
 const storyDir=join(root,'.proof-or-stop/story/actives/B-lab-queue');mkdirSync(storyDir,{recursive:true});
 const marker=join(root,'child-launched');
 let holder,contender,releaseHolder,reportQueued;
 const queued=new Promise(resolve=>reportQueued=resolve);
 try {
  acquireOwnerLease(storyDir,{command:'validate',cwd:root});const generation=readOwnerLease(storyDir).leaseId;
  let ready;const started=new Promise(resolve=>ready=resolve);
  holder=withWorkspaceValidationCapacity({root,workspaceRoot:root,command:'private-holder'},async()=>{
   ready();await new Promise(resolve=>{releaseHolder=resolve;});
  });await started;
  const abort=new AbortController();let callback=0;const start=performance.now();
  contender=withOfficialValidationExecution({root,workspaceRoot:root,command:'validate',storyId:'B-lab-queue',ownerLeaseDir:storyDir,
   ownerLeaseHeartbeat:{intervalMs:20},pollMs:10,abortSignal:abort.signal,onWaitProgress:()=>reportQueued()},()=>{
    callback++;execFileSync(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`]);return 'accepted';
   }).then(value=>({value,error:null,settled:performance.now()}),error=>({value:null,error:error.message,settled:performance.now()}));
  await Promise.race([queued,sleep(500).then(()=>{throw new Error('fixture did not reach capacity queue');})]);
  const queuedAt=performance.now();const timer=setTimeout(()=>releaseHolder(),1000);
  if(kind==='lost')assert.equal(releaseOwnerLease(storyDir),true);
  if(kind==='abort')abort.abort(new Error('caller cancellation'));
  const revokedAt=performance.now();const result=await contender;
  const row={kind,replicate,holderBudgetMs:1000,heartbeatMs:20,pollMs:10,queueReachedMs:queuedAt-start,
   outcomeMs:result.settled-start,afterTriggerMs:result.settled-revokedAt,callback,marker:existsSync(marker),error:result.error,value:result.value};
  rows.push(row);console.log('QUEUE_RESULT '+JSON.stringify(row));
  clearTimeout(timer);releaseHolder();await holder;
  let next=false;await withWorkspaceValidationCapacity({root,workspaceRoot:root,command:'subsequent'},()=>{next=true;});assert.equal(next,true);
  if(kind==='lost') {assert.match(result.error??'',/lease lost|expired|transferred/);assert.equal(callback,0,'lost owner entered execution callback');assert.equal(row.marker,false);assert.ok(row.afterTriggerMs<400,'lost owner continued waiting for capacity');}
  if(kind==='abort') {assert.equal(result.error,'caller cancellation');assert.equal(callback,0);assert.ok(row.afterTriggerMs<400);}
  if(kind==='healthy') {assert.equal(result.error,null);assert.equal(result.value,'accepted');assert.equal(callback,1);assert.ok(row.outcomeMs>=900);assert.equal(readOwnerLease(storyDir).leaseId,generation);}
 } finally {releaseHolder?.();if(holder)await holder.catch(()=>{});if(contender)await contender;rmSync(root,{recursive:true,force:true});}
}
for(const kind of ['lost','healthy','abort'])for(let i=1;i<=3;i++) {
 try {await scenario(kind,i);console.log('PASS '+kind+' '+i);}catch(e){failures.push({kind,replicate:i,message:e.message});console.error('QUEUE_LEASE_RED '+kind+' '+i+': '+e.message);}
}
console.log('QUEUE_SUMMARY '+JSON.stringify({rows:rows.length,failures}));
if(failures.length)process.exitCode=1;else console.log('QUEUE_LEASE_GREEN');
