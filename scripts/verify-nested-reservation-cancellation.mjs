import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';

// Real capture/queue/controller. The only fault is workload expiry immediately
// after actual prepare: no fake ticket, pending token or kernel observation.
const modes=['normal','capture-deadline','explicit-cleanup-expired'];
const selected=process.argv[2]?[process.argv[2]]:modes;
for(const mode of selected){
 assert.ok(modes.includes(mode));
 const runtime=nestedSourceRuntime(process.cwd());
 const {base,delegation,lock,executor,env}=runtime;
 const anchor='const pendingSpawn = await prepareValidationReservationChild({deadlineAt: options.deadlineAt, signal: options.abortSignal});';
 runtime.writeLoader(`function patch(url,source){if(url!==${JSON.stringify(executor)}||${JSON.stringify(mode)}!=='capture-deadline')return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==2)throw Error('actual capture prepare boundary moved');return source.replace(anchor,anchor+'\\n options={...options,deadlineAt:Date.now()-1};');}`);
 const entry=join(base,'cancellation.mjs');
 writeFileSync(entry,`import assert from 'node:assert/strict';
 const api=await import(${JSON.stringify(delegation)}),{withMachineValidationResources:machine}=await import(${JSON.stringify(lock)}),{runSingleAllowlistedCommand:run}=await import(${JSON.stringify(executor)});
 const original=new Error('ORIGINAL_CAPTURE_DEADLINE');let observed;
 if(${JSON.stringify(mode)}==='capture-deadline'){
  try{await run('node -e "console.log(12345)"',${JSON.stringify(base)},{timeoutMs:3000,deadlineError:()=>original});}catch(error){observed=error;}
  assert.equal(observed,original,'ACTUAL_CAPTURE_PRIMARY_ERROR_AND_NO_SPAWN_CLEANUP_REQUIRED '+String(observed));
 }else await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'owned no-spawn cancellation control',deadlineAt:Date.now()+7000},async()=>{
   const pending=await api.prepareValidationReservationChild();
   if(${JSON.stringify(mode)}==='explicit-cleanup-expired')await assert.rejects(()=>api.cancelValidationReservationChild(pending,{deadlineAt:Date.now()-1}),/expired|deadline/);
   await api.cancelValidationReservationChild(pending,{deadlineAt:Date.now()+1500});
 });
 let entered=false;await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'post-cancellation actual admission',deadlineAt:Date.now()+3000},()=>{entered=true;});assert.equal(entered,true);
 console.log('OWNED_NO_SPAWN_CANCELLATION '+${JSON.stringify(mode)}+' PASS');`);
 try{const child=spawnSync(process.execPath,[entry],{env,encoding:'utf8',timeout:12000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'ACTUAL_CAPTURE_PRIMARY_ERROR_AND_NO_SPAWN_CLEANUP_REQUIRED '+mode);}
 finally{rmSync(base,{recursive:true,force:true});}
}
console.log('NESTED_RESERVATION_CANCELLATION PASS');
