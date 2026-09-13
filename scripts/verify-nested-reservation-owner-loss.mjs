import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
const repo=process.cwd(),runtime=nestedSourceRuntime(repo);
const {base,delegation,lock,env}=runtime;
const ownerFile=join(base,'owner.mjs'),leafFile=join(base,'leaf.mjs');
const imports=`const api=await import(${JSON.stringify(delegation)});const {withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});const root=${JSON.stringify(base)};const options=()=>({root,workspaceRoot:root,command:'controlled owner-loss fixture',deadlineAt:Date.now()+10000});`;
writeFileSync(leafFile,imports+`await new Promise(r=>process.once('message',r));await api.confirmValidationReservationRegistration();await machine(options(),async()=>{process.send({ready:true});setInterval(()=>{},1000);await new Promise(()=>{});});`);
writeFileSync(ownerFile,`import {spawn} from 'node:child_process';${imports}await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();const child=spawn(process.execPath,[${JSON.stringify(leafFile)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});child.once('message',()=>process.send({registeredChild:child.pid}));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});await new Promise(()=>{});});`);
let owner,leafPid,leafStart,output='';
const startOf=pid=>{try{return execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000}).trim()||null;}catch{return null;}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const probe=`${imports}try{await machine({...options(),resources:[{class:'machine-cpu',key:'heavy',access:'exclusive'}],deadlineAt:Date.now()+500},()=>console.log('OWNER_LOSS_PROBE_ENTERED'));}catch(error){if(!/capacity wait deadline exceeded/.test(error.message))throw error;console.log('OWNER_LOSS_PROBE_BLOCKED');}`;
try {
 owner=spawn(process.execPath,[ownerFile],{env,stdio:['ignore','pipe','pipe','ipc'],detached:true});owner.stdout.on('data',x=>output+=x);owner.stderr.on('data',x=>output+=x);
 const exited=new Promise(r=>owner.once('exit',r));
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owner-loss worker readiness unavailable')),5000);owner.once('message',message=>{leafPid=message.registeredChild;assert.ok(Number.isSafeInteger(leafPid)&&leafPid>1);leafStart=startOf(leafPid);assert.ok(leafStart);clearTimeout(timer);resolve();});});
 owner.kill('SIGKILL');await exited;
 const blocked=execFileSync(process.execPath,['--input-type=module','-e',probe],{env,encoding:'utf8',timeout:5000});
 assert.match(blocked,/OWNER_LOSS_PROBE_BLOCKED/);assert.doesNotMatch(blocked,/OWNER_LOSS_PROBE_ENTERED/);assert.equal(startOf(leafPid),leafStart);
 process.kill(leafPid,'SIGTERM');const until=Date.now()+2000;while(startOf(leafPid)===leafStart&&Date.now()<until)await wait(20);assert.notEqual(startOf(leafPid),leafStart,'owned orphan did not stop');
 const admitted=execFileSync(process.execPath,['--input-type=module','-e',probe],{env,encoding:'utf8',timeout:5000});
 assert.match(admitted,/OWNER_LOSS_PROBE_ENTERED/);assert.doesNotMatch(admitted,/OWNER_LOSS_PROBE_BLOCKED/);
 console.log('OWNER_DEATH_FENCE_AND_OBSERVED_RELEASE PASS');
}finally {
 if(leafPid&&startOf(leafPid)===leafStart){try{process.kill(leafPid,'SIGKILL');}catch{}}
 if(owner?.exitCode===null&&owner.signalCode===null)owner.kill('SIGKILL');
 const until=Date.now()+2000;while(leafPid&&startOf(leafPid)===leafStart&&Date.now()<until)await wait(20);
 assert.ok(!leafPid||startOf(leafPid)!==leafStart,'owned orphan cleanup unproven; private artifacts retained');
 rmSync(base,{recursive:true,force:true});
}
