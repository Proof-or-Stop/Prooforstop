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
writeFileSync(ownerFile,`import {spawn} from 'node:child_process';${imports}await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(leafFile)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});child.once('message',()=>process.send({registeredChild:child.pid}));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});await new Promise(()=>{});});`);
let owner,leafPid,leafStart,output='';
const startOf=pid=>{try{return execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000}).trim()||null;}catch{return null;}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const probe=`${imports}try{await machine({...options(),resources:[{class:'machine-cpu',key:'heavy',access:'exclusive'}],deadlineAt:Date.now()+500},()=>console.log('OWNER_LOSS_PROBE_ENTERED'));}catch(error){if(!/capacity wait deadline exceeded/.test(error.message))throw error;console.log('OWNER_LOSS_PROBE_BLOCKED');}`;
try {
 owner=spawn(process.execPath,[ownerFile],{env,stdio:['ignore','pipe','pipe','ipc'],detached:true});owner.stdout.on('data',x=>output+=x);owner.stderr.on('data',x=>output+=x);
 const exited=new Promise(r=>owner.once('exit',r));
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owner-loss worker readiness unavailable')),5000);owner.once('message',message=>{leafPid=message.registeredChild;assert.ok(Number.isSafeInteger(leafPid)&&leafPid>1);leafStart=startOf(leafPid);assert.ok(leafStart);clearTimeout(timer);resolve();});});
 owner.kill('SIGKILL');await exited;
 // Doctor's fence projection consumes the same classifier: the dead owner's ticket must
 // report exactly one live registered group while the orphan lives, and a resolved one after it stops.
 const classify=`${imports}const {readdirSync}=await import('node:fs');const {join}=await import('node:path');const pool=join(root,'home','.proof-or-stop','locks','machine-fixed-port-capacity');const tickets=readdirSync(pool).filter(name=>name.endsWith('.ticket'));if(tickets.length!==1)throw new Error('OWNER_LOSS_TICKET_COUNT '+tickets.length);console.log('CLASSIFY '+JSON.stringify(api.classifyMachineReservationResiduals(join(pool,tickets[0]))));`;
 const classifyOnce=()=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',classify],{env,encoding:'utf8',timeout:5000}).match(/CLASSIFY (\{.*\})/)[1]);
 const fenced=classifyOnce();assert.deepEqual([fenced.present,fenced.registeredLive,fenced.pendingTargetless,fenced.pendingTargetLive],[true,1,0,0],'live orphan must classify as one live registered group: '+JSON.stringify(fenced));
 const blocked=execFileSync(process.execPath,['--input-type=module','-e',probe],{env,encoding:'utf8',timeout:5000});
 assert.match(blocked,/OWNER_LOSS_PROBE_BLOCKED/);assert.doesNotMatch(blocked,/OWNER_LOSS_PROBE_ENTERED/);assert.equal(startOf(leafPid),leafStart);
 process.kill(leafPid,'SIGTERM');const until=Date.now()+2000;while(startOf(leafPid)===leafStart&&Date.now()<until)await wait(20);assert.notEqual(startOf(leafPid),leafStart,'owned orphan did not stop');
 const resolved=classifyOnce();assert.deepEqual([resolved.registeredLive,resolved.registeredResolved,resolved.pendingTargetless],[0,1,0],'stopped orphan must classify as a resolved registered group: '+JSON.stringify(resolved));
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
