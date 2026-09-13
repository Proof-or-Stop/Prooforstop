import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';

// Actual admitted private-home queue; only the workload cancellation inputs are
// controlled. No child is spawned between prepare and its owning cancellation.
const modes=['normal','expired','aborted'];
const selected=process.argv[2]?[process.argv[2]]:modes;
for(const mode of selected){
 assert.ok(modes.includes(mode));
 const {base,delegation,lock,env}=nestedSourceRuntime(process.cwd());
 const entry=join(base,'cancellation.mjs');
 writeFileSync(entry,`import assert from 'node:assert/strict';
 const api=await import(${JSON.stringify(delegation)}),{withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});
 let observed;
 try {await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'owned no-spawn cancellation control',deadlineAt:Date.now()+7000},async()=>{
   const pending=await api.prepareValidationReservationChild();
   const abort=new AbortController();if(${JSON.stringify(mode)}==='aborted')abort.abort(new Error('ORIGINAL_WORKLOAD_ABORT'));
   await api.cancelValidationReservationChild(pending,{deadlineAt:Date.now()+(${JSON.stringify(mode)}==='expired'?-1:3000),signal:abort.signal});
 });}catch(error){observed=error;}
 assert.equal(observed,undefined,'OWNED_NO_SPAWN_CANCELLATION_REQUIRED '+String(observed));
 let entered=false;await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'post-cancellation actual admission',deadlineAt:Date.now()+3000},()=>{entered=true;});assert.equal(entered,true);
 console.log('OWNED_NO_SPAWN_CANCELLATION '+${JSON.stringify(mode)}+' PASS');`);
 try{const child=spawnSync(process.execPath,[entry],{env,encoding:'utf8',timeout:12000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'OWNED_NO_SPAWN_CANCELLATION_REQUIRED '+mode);}
 finally{rmSync(base,{recursive:true,force:true});}
}
console.log('NESTED_RESERVATION_CANCELLATION PASS');
