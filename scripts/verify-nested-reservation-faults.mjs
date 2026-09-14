import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
const mode=process.argv[2]??'registered';
assert.ok(['registered','same-group','pending','coalesced','finite-owner','pending-lineage'].includes(mode));
const repo=process.cwd();
const {base,loader,delegation,lock,env,writeLoader}=nestedSourceRuntime(repo);
const owner=join(base,'owner.mjs'),holder=join(base,'holder.mjs'),leaf=join(base,'leaf.mjs'),sibling=join(base,'sibling.mjs');
if(mode==='coalesced') {
 const anchor="socket.write(JSON.stringify({ grant, signature: signCanonical(grant, keys.privateKey) }) + '\\n');";
 const replacement="const revocation={reservation:owner.lockId,grantId:grant.grantId};socket.write(JSON.stringify({grant,signature:signCanonical(grant,keys.privateKey)})+'\\n'+JSON.stringify({revocation,signature:signCanonical(revocation,keys.privateKey)})+'\\n');";
 writeLoader(`function patch(url,source){if(url!==${JSON.stringify(delegation)}||!process.argv.includes('--coalesce-owner'))return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==3)throw Error('coalesce source anchor mismatch');return source.replace(anchor,${JSON.stringify(replacement)});}`);
}
const imports=`import {spawn} from 'node:child_process';import assert from 'node:assert/strict';const api=await import(${JSON.stringify(delegation)});const {withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});const root=${JSON.stringify(base)};const options=()=>({root,workspaceRoot:root,command:'own EOF diagnostic',deadlineAt:Date.now()+10000});const wait=ms=>new Promise(r=>setTimeout(r,ms));const go=()=>new Promise(r=>process.once('message',r));`;
writeFileSync(leaf,imports+`await go();await api.confirmValidationReservationRegistration();process.send({ready:true});setInterval(()=>{},1000);`);
writeFileSync(sibling,imports+`await go();await api.confirmValidationReservationRegistration();await machine(options(),()=>process.send({entered:true}));process.disconnect();`);
writeFileSync(holder,imports+`await go();await api.confirmValidationReservationRegistration();await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();const child=spawn(process.execPath,[${JSON.stringify(leaf)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});child.once('message',()=>process.send({leafPid:child.pid}));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});await new Promise(()=>{});});`);
writeFileSync(owner,imports+`let leafPid,leafStart;const {observedProcessStartTimeMs}=await import(${JSON.stringify('file://'+repo+'/packages/main/src/core/mkdir-lock.ts')});await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const childClosed=new Promise(r=>child.once('close',r));const ready=new Promise(r=>child.once('message',m=>{leafPid=m.leafPid;leafStart=observedProcessStartTimeMs(leafPid);r();}));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});await ready;child.kill('SIGKILL');await childClosed;const siblingToken=await api.prepareValidationReservationChild();const other=spawn(process.execPath,[${JSON.stringify(sibling)},'--request-observer'],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});let entered=false,requestResolve;const requestReady=new Promise(r=>{requestResolve=r;});other.on('message',m=>{if(m.entered)entered=true;if(m.requestSent)requestResolve();});const otherClosed=new Promise(r=>other.once('close',(code,signal)=>r({code,signal})));await api.registerValidationReservationChild(other.pid,siblingToken);other.send({go:true});await requestReady;await wait(700);assert.equal(entered,false,'EOF released a live registered descendant claim');assert.equal(observedProcessStartTimeMs(leafPid),leafStart);process.kill(leafPid,'SIGTERM');const goneBy=Date.now()+2000;for(;;){try{process.kill(leafPid,0);}catch(error){if(error.code==='ESRCH')break;throw error;}if(Date.now()>goneBy)throw Error('own diagnostic leaf did not disappear');await wait(10);}const siblingResult=await otherClosed;assert.deepEqual(siblingResult,{code:0,signal:null});assert.equal(entered,true);console.log('UNEXPECTED_EOF_RETAINS_DESCENDANT_CLAIMS PASS');});`);
if(mode==='same-group'||mode==='pending') {
 let value=readFileSync(holder,'utf8');
 if(mode==='same-group')value=value.replace('const token=await api.prepareValidationReservationChild();','').replace('detached:true','detached:false').replace('await api.registerValidationReservationChild(child.pid,token);','');
 else {
  value=value.replace('await api.registerValidationReservationChild(child.pid,token);child.send({go:true});','');
  writeFileSync(leaf,`process.send({ready:true});setInterval(()=>{},1000);`);
  // The queued grant request is refused at its deadline either by the sibling's own handshake
  // timer ("handshake deadline") or, when the controller's expiry response arrives first, by the
  // controller ("reservation/request expired"); both are the same deadline refusal, and entry is
  // asserted separately through the owner's `entered` flag.
  writeFileSync(sibling,readFileSync(sibling,'utf8').replace("await machine(options(),()=>process.send({entered:true}));", "await assert.rejects(()=>machine({...options(),deadlineAt:Date.now()+1200},()=>process.send({entered:true})),/deadline|reservation\\/request expired/);process.send({blocked:true});"));
  writeFileSync(owner,readFileSync(owner,'utf8').replace('assert.equal(entered,true);','assert.equal(entered,false);'));
 }
 writeFileSync(holder,value);
}
if(mode==='coalesced') {
 writeFileSync(holder,imports+`await go();await api.confirmValidationReservationRegistration();let entered=false;await assert.rejects(()=>machine(options(),()=>{entered=true;}),/revoked/);assert.equal(entered,false);console.log('COALESCED_SIGNED_REVOCATION_REFUSES_ENTRY PASS');process.disconnect();`);
 writeFileSync(owner,imports+`await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const closed=new Promise(r=>child.once('close',r));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});assert.equal(await closed,0);});`);
}
if(mode==='finite-owner') {
 writeFileSync(owner,imports+`const {fstatSync,readSync}=await import('node:fs');await machine({...options(),resources:[{class:'machine-cpu',key:'heavy',access:'exclusive'}]},async()=>{const fd=api.validationReservationChildStdio(['ignore','inherit','inherit','ipc'])[4];const bytes=Buffer.alloc(Number(fstatSync(fd).size));readSync(fd,bytes,0,bytes.length,0);const owner=JSON.parse(bytes);let entered=false;await assert.rejects(()=>api.withMachineReservationController({...owner,resources:null},()=>true,()=>{entered=true;}),/declaration mismatch/);assert.equal(entered,false);console.log('FINITE_OWNER_WIDENED_CONTROLLER_REFUSED PASS');});`);
}
if(mode==='pending-lineage') {
 writeFileSync(leaf,`setInterval(()=>{},1000);`);
 writeFileSync(holder,imports+`await go();await api.confirmValidationReservationRegistration();let pending,child;await machine({...options(),resources:[{class:'machine-cpu',key:'heavy',access:'exclusive'}]},async()=>{pending=await api.prepareValidationReservationChild();child=spawn(process.execPath,[${JSON.stringify(leaf)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});});const closed=new Promise(r=>child.once('close',r));try{await assert.rejects(()=>api.registerValidationReservationChild(child.pid,pending),/pending parent invocation released/);console.log('PENDING_ANCESTRY_LAUNDERING_REFUSED PASS');}finally{child.kill('SIGTERM');await closed;}process.disconnect();`);
 writeFileSync(owner,imports+`await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const closed=new Promise(r=>child.once('close',r));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});assert.equal(await closed,0);});`);
 const preimage=process.argv.find(arg=>arg.startsWith('--preimage='))?.slice('--preimage='.length);
 if(preimage) {const source=readFileSync(preimage,'utf8');writeLoader(`function patch(url,value){return url===${JSON.stringify(delegation)}?${JSON.stringify(source)}:value;}`);}
}
// Parent-side observations bind cleanup to only this diagnostic's children.
let ownerSource=readFileSync(owner,'utf8');
ownerSource=ownerSource.replaceAll('await api.registerValidationReservationChild(child.pid,token);',"process.send({ownedPid:child.pid});await api.registerValidationReservationChild(child.pid,token);")
 .replaceAll('await api.registerValidationReservationChild(other.pid,siblingToken);',"process.send({ownedPid:other.pid});await api.registerValidationReservationChild(other.pid,siblingToken);")
 .replace('leafPid=m.leafPid;leafStart=',"leafPid=m.leafPid;process.send({ownedPid:leafPid});leafStart=");
writeFileSync(owner,ownerSource);
const observed=new Map();
const startOf=pid=>{try{return execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000}).trim()||null;}catch{return null;}};
const observe=pid=>{assert.ok(Number.isSafeInteger(pid)&&pid>1);const start=startOf(pid);if(start)observed.set(pid,start);};
let child,output='';
try {
 child=spawn(process.execPath,[owner,...(mode==='coalesced'?['--coalesce-owner']:[])],{env,stdio:['ignore','pipe','pipe','ipc'],detached:true});observe(child.pid);child.on('message',message=>{if(message.ownedPid)observe(message.ownedPid);});child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('own diagnostic deadline; partial output:\n'+output)),15000);child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
 console.log(output);assert.equal(result.code,['pending','pending-lineage'].includes(mode)?1:0,output);assert.match(output,mode==='pending-lineage'?/PENDING_ANCESTRY_LAUNDERING_REFUSED PASS/:mode==='finite-owner'?/FINITE_OWNER_WIDENED_CONTROLLER_REFUSED PASS/:mode==='coalesced'?/COALESCED_SIGNED_REVOCATION_REFUSES_ENTRY PASS/:/UNEXPECTED_EOF_RETAINS_DESCENDANT_CLAIMS PASS/);if(['pending','pending-lineage'].includes(mode))assert.match(output,/owned group cleanup unproven/);console.log('NESTED_RESERVATION_FAULT '+mode+' PASS');
}finally{
 for(const [pid,start] of observed)if(startOf(pid)===start){try{process.kill(pid,'SIGTERM');}catch{}}
 let deadline=Date.now()+2000;
 while([...observed].some(([pid,start])=>startOf(pid)===start)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 for(const [pid,start] of observed)if(startOf(pid)===start){try{process.kill(pid,'SIGKILL');}catch{}}
 deadline=Date.now()+2000;
 while([...observed].some(([pid,start])=>startOf(pid)===start)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.ok(![...observed].some(([pid,start])=>startOf(pid)===start),'own diagnostic child cleanup unproven; private artifacts retained');
 rmSync(base,{recursive:true,force:true});
}

