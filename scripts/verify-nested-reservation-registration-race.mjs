import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
const preimage=process.argv.find(arg=>arg.startsWith('--preimage='))?.slice('--preimage='.length);
const modes=['gone','gone-before-ancestry','alive','unknown','nonleader','unknown-pid','unknown-group','known-exit','retry-recovers','retry-exhausted','retry-exhausted-withdrawn'];if(process.argv[2])assert.ok(modes.includes(process.argv[2]));
for(const mode of process.argv[2]?[process.argv[2]]:modes){
 const runtime=nestedSourceRuntime(process.cwd()),{base,delegation,lock,env,writeLoader}=runtime;
 const registry=delegation.replace('validation-reservation-delegation.ts','runtime-fact-registry.ts');
 // The race hook fires once at each observation boundary, outside the bounded
 // transient-observation retry, so a reaped or controlled-unavailable target is
 // observed exactly as the live registration path would observe it.
 const anchor=mode==='known-exit'?'registered.set(pid, { ...target, parents:inheritedParents });':mode==='gone-before-ancestry'?'if (!observeWithRetry(() => ancestors(pid)).includes(parent))':'target = observeWithRetry(() => identity(pid));';
 // The retry modes fail the inner observation itself: transient for all but the last
 // attempt (recovers) or on every attempt (exhausted), counting attempts in the owner.
 const replacement=mode==='known-exit'?'globalThis.__registrationRace?.(pid);registered.set(pid, { ...target, parents:inheritedParents });':mode==='gone-before-ancestry'?'if (!(globalThis.__registrationRace?.(pid),observeWithRetry(() => ancestors(pid))).includes(parent))':mode==='retry-recovers'?'target = observeWithRetry(() => { globalThis.__retryAttempts = (globalThis.__retryAttempts ?? 0) + 1; if (globalThis.__retryAttempts < policy.observationRetries) throw failure(\'process identity unavailable\'); return identity(pid); });':mode.startsWith('retry-exhausted')?'target = observeWithRetry(() => { globalThis.__retryAttempts = (globalThis.__retryAttempts ?? 0) + 1; throw failure(\'process identity unavailable\'); });':'target = (globalThis.__registrationRace?.(pid), observeWithRetry(() => identity(pid)));';
 writeLoader(`function patch(url,source){if(url!==${JSON.stringify(delegation)})return source;${preimage?'source='+JSON.stringify(readFileSync(preimage,'utf8'))+';':''}const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==2)throw Error('registration race anchor mismatch');return source.replace(anchor,${JSON.stringify(replacement)});}`);
 const launcher=join(base,'launcher.mjs'),owner=join(base,'owner.mjs');
 writeFileSync(launcher,`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:${JSON.stringify(mode!=='nonleader')},stdio:'ignore'});process.send({pid:child.pid});child.once('exit',()=>process.send({gone:true}));process.on('message',()=>process.exit(0));`);
 writeFileSync(owner,`import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
const api=await import(${JSON.stringify(delegation)}),{withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});
let launcher,leaf,record,hooked=false,observed,unknown=false;
const originalKill=process.kill;process.kill=function(pid,signal){if(unknown&&signal===0&&pid===(${JSON.stringify(mode)}==='unknown-pid'?leaf:-leaf)){const e=new Error('controlled observation unavailable');e.code='EPERM';throw e;}return originalKill.apply(this,arguments);};
globalThis.__registrationRace=pid=>{assert.equal(pid,leaf);if(${JSON.stringify(mode)}==='nonleader')return;const current=api.observeValidationReservationChild(pid);assert.deepEqual(current,record);assert.equal(current.pid,current.pgid);hooked=true;
 if(${JSON.stringify(mode)}.startsWith('gone')||${JSON.stringify(mode)}==='unknown-pid'||${JSON.stringify(mode)}==='unknown-group'){originalKill(pid,'SIGTERM');const end=Date.now()+2000;while(!api.validationReservationGroupIsAbsent(pid)&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);assert.equal(api.validationReservationGroupIsAbsent(pid),true,'owned child was not independently reaped');if(!${JSON.stringify(mode)}.startsWith('gone'))unknown=true;}
 else {unknown=${JSON.stringify(mode)}==='unknown';throw new Error('CONTROLLED_IDENTITY_LOOKUP_UNAVAILABLE');}
};
try{
 await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'actual registration race control',deadlineAt:Date.now()+7000},async()=>{
  const token=await api.prepareValidationReservationChild();launcher=spawn(process.execPath,[${JSON.stringify(launcher)}],{env:process.env,stdio:['ignore','inherit','inherit','ipc']});
  leaf=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned launcher readiness unavailable')),3000);launcher.once('message',value=>{clearTimeout(timer);resolve(value.pid);});});record=api.observeValidationReservationChild(leaf);
  if(${JSON.stringify(mode)}==='retry-recovers'||${JSON.stringify(mode)}.startsWith('retry-exhausted')){
   const {VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY:policy}=await import(${JSON.stringify(registry)});
   if(${JSON.stringify(mode)}==='retry-recovers'){await api.registerValidationReservationChild(leaf,token);assert.equal(globalThis.__retryAttempts,policy.observationRetries,'recovery must consume every attempt but the last');assert.equal(api.validationReservationChildIdentityMatches(record),true);originalKill(-record.pgid,'SIGTERM');const end=Date.now()+2000;while(!api.validationReservationGroupIsAbsent(record.pgid)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(api.validationReservationGroupIsAbsent(record.pgid),true);console.log('REGISTER_RETRY_RECOVERED');}
   else{let refusal;try{await api.registerValidationReservationChild(leaf,token);}catch(error){refusal=error;}assert.match(String(refusal),/process identity unavailable/,'exhausted observation must refuse the registration');assert.equal(globalThis.__retryAttempts,policy.observationRetries,'exhaustion must use every attempt');
    if(${JSON.stringify(mode)}==='retry-exhausted-withdrawn'){originalKill(-leaf,'SIGTERM');const end=Date.now()+2000;while(!api.unregisteredValidationReservationChildGone(leaf)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(api.unregisteredValidationReservationChildGone(leaf),true,'refused leaf must be proven absent before withdrawal');await api.cancelValidationReservationChild(token);console.log('REGISTER_RETRY_EXHAUSTED_WITHDRAWN');}
    else{console.log('REGISTER_RETRY_EXHAUSTED');throw refusal;}}
  }else if(${JSON.stringify(mode)}==='known-exit'){
   await assert.rejects(()=>api.registerValidationReservationChild(leaf,token),/CONTROLLED_IDENTITY_LOOKUP_UNAVAILABLE/);
   assert.equal(api.validationReservationChildIdentityMatches(record),true);originalKill(-record.pgid,'SIGTERM');
   const end=Date.now()+2000;while(!api.validationReservationGroupIsAbsent(record.pgid)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
   assert.equal(api.validationReservationGroupIsAbsent(record.pgid),true);assert.throws(()=>originalKill(record.pid,0),error=>error.code==='ESRCH');
  }else{await api.registerValidationReservationChild(leaf,token);assert.equal(${JSON.stringify(mode)}.startsWith('gone'),true);console.log('REGISTER_DISAPPEARED_OWN_GROUP_RESOLVED');}
 });
}catch(error){observed=error;}
finally{unknown=false;if(record&&api.validationReservationChildIdentityMatches(record))originalKill(record.pid===record.pgid?-record.pgid:record.pid,'SIGTERM');if(record){const absent=()=>{try{originalKill(record.pid,0);return false;}catch(error){if(error.code!=='ESRCH')return false;}return record.pid!==record.pgid||api.validationReservationGroupIsAbsent(record.pgid);};const end=Date.now()+2000;while(!absent()&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);assert.equal(absent(),true,'test-owned cleanup unproven');}if(launcher?.connected)launcher.send({stop:true});if(launcher)await new Promise(resolve=>launcher.exitCode!==null?resolve():launcher.once('exit',resolve));}
assert.equal(hooked,!['nonleader','retry-recovers','retry-exhausted','retry-exhausted-withdrawn'].includes(${JSON.stringify(mode)}));
if(${JSON.stringify(mode)}.startsWith('gone')||${JSON.stringify(mode)}==='known-exit'||${JSON.stringify(mode)}==='retry-recovers'||${JSON.stringify(mode)}==='retry-exhausted-withdrawn')assert.equal(observed,undefined,'REGISTER_DISAPPEARED_GROUP_REQUIRED: '+String(observed));
else {assert.match(observed?.message??'',/owned group cleanup unproven/);assert.match(String(observed.cause),${JSON.stringify(mode)}==='nonleader'?/registered child must own its detached group/:${JSON.stringify(mode)}.startsWith('unknown-')||${JSON.stringify(mode)}==='retry-exhausted'?/process identity unavailable/:/CONTROLLED_IDENTITY_LOOKUP_UNAVAILABLE/);assert.ok(observed.cleanupDiagnostics.residuals.some(row=>row.kind==='pending'));}
console.log('REGISTRATION_RACE_CONTROL '+${JSON.stringify(mode)}+' PASS');`);
 try{const child=spawnSync(process.execPath,[owner],{env,encoding:'utf8',timeout:10000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,mode+' REGISTER_DISAPPEARED_GROUP_REQUIRED');}
 finally{rmSync(base,{recursive:true,force:true});}
}
console.log('NESTED_RESERVATION_REGISTRATION_RACE PASS');
