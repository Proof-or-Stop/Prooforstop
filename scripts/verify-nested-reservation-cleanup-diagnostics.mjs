import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
// Actual private-home queue/controller. The fault is an explicitly unresolved
// prepare-without-spawn fence, never a fake ticket, owner or observation.
for(const mode of ['clean-result','clean-error','error','result']) {
 const {base,delegation,lock,env}=nestedSourceRuntime(process.cwd());
 const entry=join(base,'diagnostics.mjs');
 writeFileSync(entry,`import assert from 'node:assert/strict';
const api=await import(${JSON.stringify(delegation)}),{withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});
const original=new Error('PRIMARY_CALLBACK_WITNESS');
let getterRead=false;
const result=Object.freeze(Object.defineProperty({code:0,output:'CAPTURED_CHILD_WITNESS '+('x'.repeat(100000)),timedOut:false},'stderr',{get(){getterRead=true;throw Error('diagnostics invoked getter');}}));
let observed;
try {
 const value=await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'bounded cleanup diagnostic control',deadlineAt:Date.now()+5000},async()=>{
  if(!${JSON.stringify(mode)}.startsWith('clean'))await api.prepareValidationReservationChild();
  if(${JSON.stringify(mode)}.endsWith('error'))throw original;
  return result;
 });
 assert.equal(${JSON.stringify(mode)},'clean-result');assert.equal(value,result);
}catch(error){observed=error;}
assert.equal(getterRead,false);
if(${JSON.stringify(mode)}==='clean-error')assert.equal(observed,original);
else if(${JSON.stringify(mode)}==='clean-result')assert.equal(observed,undefined);
else {
 assert.match(observed?.message??'',/owned group cleanup unproven/);
 assert.ok(observed.cleanupDiagnostics,'CLEANUP_DIAGNOSTICS_REQUIRED');
 const d=observed.cleanupDiagnostics;assert.equal(d.schema,'validation-reservation-cleanup.v1');
 assert.equal(d.owner.pid,process.pid);assert.ok(Number.isSafeInteger(d.owner.start));
 assert.ok(d.residuals.some(row=>row.kind==='pending'&&row.pid===process.pid&&row.reason==='unresolved pre-spawn fence'));
 assert.ok(Buffer.byteLength(JSON.stringify(d))<=32768);assert.match(observed.message,/VALIDATION_RESERVATION_CLEANUP_DIAGNOSTICS/);
 if(${JSON.stringify(mode)}==='error'){assert.equal(observed.cause,original);assert.equal(d.callback.state,'threw');assert.match(observed.message,/PRIMARY_CALLBACK_WITNESS/);}
 else {assert.equal(d.callback.state,'returned');assert.equal(d.callback.result.code,0);assert.match(d.callback.result.output,/CAPTURED_CHILD_WITNESS/);assert.equal(d.truncated,true);assert.equal(result.output.length,100023);}
}
console.log('CLEANUP_DIAGNOSTICS_CONTROL '+${JSON.stringify(mode)}+' PASS');`);
 try{const child=spawnSync(process.execPath,[entry],{env,encoding:'utf8',timeout:10000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,mode+' CLEANUP_DIAGNOSTICS_REQUIRED');}
 finally{rmSync(base,{recursive:true,force:true});}
}
console.log('NESTED_RESERVATION_CLEANUP_DIAGNOSTICS PASS');
