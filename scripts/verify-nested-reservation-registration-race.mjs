import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
const modes=['gone','alive','unknown'];if(process.argv[2])assert.ok(modes.includes(process.argv[2]));
for(const mode of process.argv[2]?[process.argv[2]]:modes){
 const runtime=nestedSourceRuntime(process.cwd()),{base,delegation,lock,env,writeLoader}=runtime;
 const anchor='const target = identity(pid);';
 writeLoader(`function patch(url,source){if(url!==${JSON.stringify(delegation)})return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==2)throw Error('registration race anchor mismatch');return source.replace(anchor,'const target = (()=>{globalThis.__registrationRace?.(pid);return identity(pid);})();');}`);
 const launcher=join(base,'launcher.mjs'),owner=join(base,'owner.mjs');
 writeFileSync(launcher,`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});process.send({pid:child.pid});child.once('exit',()=>process.send({gone:true}));process.on('message',()=>process.exit(0));`);
 writeFileSync(owner,`import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
const api=await import(${JSON.stringify(delegation)}),{withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});
let launcher,leaf,record,hooked=false,observed,unknown=false;
const originalKill=process.kill;process.kill=function(pid,signal){if(unknown&&pid===-leaf&&signal===0){const e=new Error('controlled observation unavailable');e.code='EPERM';throw e;}return originalKill.apply(this,arguments);};
globalThis.__registrationRace=pid=>{assert.equal(pid,leaf);const current=api.observeValidationReservationChild(pid);assert.deepEqual(current,record);assert.equal(current.pid,current.pgid);hooked=true;
 if(${JSON.stringify(mode)}==='gone'){originalKill(pid,'SIGTERM');const end=Date.now()+2000;while(!api.validationReservationGroupIsAbsent(pid)&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);assert.equal(api.validationReservationGroupIsAbsent(pid),true,'owned child was not independently reaped');}
 else {unknown=${JSON.stringify(mode)}==='unknown';throw new Error('CONTROLLED_IDENTITY_LOOKUP_UNAVAILABLE');}
};
try{
 await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'actual registration race control',deadlineAt:Date.now()+7000},async()=>{
  const token=await api.prepareValidationReservationChild();launcher=spawn(process.execPath,[${JSON.stringify(launcher)}],{env:process.env,stdio:['ignore','inherit','inherit','ipc']});
  leaf=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned launcher readiness unavailable')),3000);launcher.once('message',value=>{clearTimeout(timer);resolve(value.pid);});});record=api.observeValidationReservationChild(leaf);
  await api.registerValidationReservationChild(leaf,token);assert.equal(${JSON.stringify(mode)},'gone');console.log('REGISTER_DISAPPEARED_OWN_GROUP_RESOLVED');
 });
}catch(error){observed=error;}
finally{unknown=false;if(record&&api.validationReservationChildIdentityMatches(record))originalKill(-record.pgid,'SIGTERM');if(record){const end=Date.now()+2000;while(!api.validationReservationGroupIsAbsent(record.pgid)&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);assert.equal(api.validationReservationGroupIsAbsent(record.pgid),true,'test-owned group cleanup unproven');}if(launcher?.connected)launcher.send({stop:true});if(launcher)await new Promise(resolve=>launcher.exitCode!==null?resolve():launcher.once('exit',resolve));}
assert.equal(hooked,true);
if(${JSON.stringify(mode)}==='gone')assert.equal(observed,undefined,'REGISTER_DISAPPEARED_GROUP_REQUIRED: '+String(observed));
else {assert.match(observed?.message??'',/owned group cleanup unproven/);assert.match(String(observed.cause),/CONTROLLED_IDENTITY_LOOKUP_UNAVAILABLE/);assert.ok(observed.cleanupDiagnostics.residuals.some(row=>row.kind==='pending'));}
console.log('REGISTRATION_RACE_CONTROL '+${JSON.stringify(mode)}+' PASS');`);
 try{const child=spawnSync(process.execPath,[owner],{env,encoding:'utf8',timeout:10000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,mode+' REGISTER_DISAPPEARED_GROUP_REQUIRED');}
 finally{rmSync(base,{recursive:true,force:true});}
}
console.log('NESTED_RESERVATION_REGISTRATION_RACE PASS');
