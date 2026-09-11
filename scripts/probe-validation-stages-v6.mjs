import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {withOfficialValidationExecution as official,withWorkspaceValidationCapacity as capacity,withValidationExecutionLock as storyLock,withValidationPlanStages as plan,withValidationCommandStage as command,assertCurrentValidationPublicationOwner as publication,validationCapacityLockPath} from '../packages/main/dist/core/validation-execution-lock.js';
const root=mkdtempSync(join(tmpdir(),'pos-stage-v6-'));
execFileSync('git',['init','-q'],{cwd:root});
const base={root,workspaceRoot:root,command:'stage-proof',storyId:'B-stage-proof',commandStages:true};
const rows=[];
async function test(name,fn){const start=performance.now();try{await fn();rows.push({name,pass:true,ms:performance.now()-start});}catch(e){rows.push({name,pass:false,error:String(e),ms:performance.now()-start});}}
try{
 await test('inverse capacity then unowned Story is rejected',async()=>{
  let entered=false;
  await assert.rejects(capacity(base,()=>official(base,()=>{entered=true;})),/VALIDATION_LOCK_ORDER/);
  assert.equal(entered,false);
 });
 await test('already owned Story then capacity permits nested legacy call',async()=>{
  let entered=0;await storyLock(base,()=>capacity(base,()=>official(base,()=>{entered++;})));assert.equal(entered,1);
 });
 await test('plan failure preserves original exception despite simultaneous cancellation',async()=>{
  const ac=new AbortController(),original=new Error('ORIGINAL_PLAN_FAILURE');
  await assert.rejects(official({...base,abortSignal:ac.signal},()=>plan(async()=>{ac.abort(new Error('CANCELLED'));throw original;})),e=>e===original);
 });
 await test('caught plan failure cannot publish',async()=>{
  await official(base,async()=>{await assert.rejects(plan(async()=>{throw new Error('PLAN_FAILED');}),/PLAN_FAILED/);assert.throws(()=>publication(root,base.storyId),/VALIDATION_PUBLICATION_CAPACITY_LOST/);});
 });
 await test('successful command stage and nested invocation restore publication',async()=>{
  await official(base,async()=>{await official(base,()=>plan(async()=>{assert.throws(()=>publication(root,base.storyId),/VALIDATION_PUBLICATION_CAPACITY_LOST/);await command({label:'safe',resources:[{class:'fixed-path',key:root,access:'exclusive'}]},async()=>{});}));publication(root,base.storyId);});
 });
 await test('normal return with cancelled invocation cannot publish',async()=>{
  const ac=new AbortController();let published=false;await assert.rejects(official({...base,abortSignal:ac.signal},async()=>{await plan(async()=>ac.abort(new Error('CANCELLED')));published=true;}),/CANCELLED/);assert.equal(published,false);
 });
 await test('returned command FAIL can publish FAIL',async()=>{
  await official(base,async()=>{const result=await plan(async()=>({status:'FAIL'}));assert.equal(result.status,'FAIL');publication(root,base.storyId);});
 });
 await test('deadline elapsed during plan cannot publish',async()=>{
  let published=false;await assert.rejects(official({...base,deadlineAt:Date.now()+200,deadlineError:()=>new Error('STAGE_DEADLINE')},async()=>{await plan(async()=>new Promise(r=>setTimeout(r,230)));published=true;}),/STAGE_DEADLINE/);assert.equal(published,false);
 });
 await test('nested resource upgrade remains refused',async()=>{
  await official(base,()=>assert.rejects(official({...base,commandStages:false,resources:undefined},async()=>{}),/upgrade|widen|reservation|capacity/i));
 });
 await test('independent commands in one invocation retain parallelism',async()=>{
  let active=0,maximum=0;
  await official(base,()=>plan(()=>Promise.all(['a','b','c'].map(key=>command({label:key,resources:[{class:'fixed-path',key:join(root,key),access:'exclusive'}]},async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,80));active--;})))));
  assert.equal(maximum,3,'STAGES_MUST_NOT_SERIALIZE_INDEPENDENT_LOCAL_COMMANDS');
 });
 await test('grouped capacity still serializes conflicting resources',async()=>{
  let active=0,maximum=0;const invocationGroup=randomUUID();await Promise.all([1,2].map(()=>capacity({...base,invocationGroup,maxConcurrent:2,resources:[{class:'fixed-path',key:join(root,'conflict'),access:'exclusive'}]},async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,50));active--;})));assert.equal(maximum,1);
 });
 await test('three invocation groups cannot exceed two capacity slots',async()=>{
  const active=new Map();let maximum=0,release,reject;
  // Observe two admitted groups before releasing either: a short sleep is not
  // evidence that the scheduler had an opportunity to admit the second group.
  const twoGroups=new Promise((resolve,fail)=>{release=resolve;reject=fail;});
  const deadline=setTimeout(()=>{
   const queue=validationCapacityLockPath(root);console.log('CAPACITY_GROUP_TIMEOUT_TICKETS='+JSON.stringify(readdirSync(queue).filter(n=>n.endsWith('.ticket')).map(n=>({holder:JSON.parse(readFileSync(join(queue,n,'holder.json'),'utf8')),resources:JSON.parse(readFileSync(join(queue,n,'resources.json'),'utf8'))}))));
   reject(new Error('TWO_GROUP_ADMISSION_DEADLINE'));
  },2000);
  try {
   const results=await Promise.allSettled([1,2,3].flatMap(g=>{const invocationGroup=randomUUID();return [1,2,3].map(k=>capacity({...base,invocationGroup,maxConcurrent:2,resources:[{class:'fixed-path',key:join(root,`g${g}-${k}`),access:'exclusive'}]},async()=>{
    active.set(g,(active.get(g)??0)+1);maximum=Math.max(maximum,active.size);if(active.size>=2){
     const queue=validationCapacityLockPath(root),starts=readdirSync(queue).filter(n=>n.endsWith('.ticket')).map(n=>JSON.parse(readFileSync(join(queue,n,'holder.json'),'utf8')).processStartTimeMs);
     assert.equal(new Set(starts).size,1,'ONE_PROCESS_MUST_PUBLISH_ONE_STABLE_INCARNATION_IDENTITY');release();
    }
    try{await twoGroups;}finally{const n=active.get(g)-1;if(n)active.set(g,n);else active.delete(g);}
   }));}));
   for(const result of results)assert.equal(result.status,'fulfilled',result.reason?.message);
   assert.equal(maximum,2);
  } finally {clearTimeout(deadline);}
 });
 console.log(JSON.stringify(rows,null,2));assert(rows.every(r=>r.pass),'STAGE_SAFETY_REQUIRED');console.log('VALIDATION_STAGES_V6_GREEN');
}finally{rmSync(root,{recursive:true,force:true});}
