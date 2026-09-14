import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
const mode=process.argv[2]??'registered';
assert.ok(['registered','same-group','pending','coalesced','finite-owner','pending-lineage','declared-owner-unclassified','declared-owner-expansion','retirement-backoff','controller-transport-unavailable','drain-observation-transient','unattempted-owner-loss','attempted-owner-loss','registered-row-pruned','spawned-owner-loss'].includes(mode));
const repo=process.cwd();
// The pre-repair delegation source, when supplied, replaces the module for every mode before
// any mode-specific hook is applied, so a RED replay can never silently run current source.
const preimage=process.argv.find(arg=>arg.startsWith('--preimage='))?.slice('--preimage='.length);
const preimageSource=preimage?readFileSync(preimage,'utf8'):null;
// The executor imports the delegation module's exports, so a pre-repair delegation source is
// replayed together with the executor of the same revision (`--preimage-executor=FILE`).
const preimageExecutor=process.argv.find(arg=>arg.startsWith('--preimage-executor='))?.slice('--preimage-executor='.length);
const preimageExecutorSource=preimageExecutor?readFileSync(preimageExecutor,'utf8'):null;
const delegationUrl=pathToFileURL(join(repo,'packages/main/src/core/validation-reservation-delegation.ts')).href;
const executorUrl=pathToFileURL(join(repo,'packages/main/src/core/validation-executor.ts')).href;
const withPreimage=body=>`function patch(url,source){${preimageSource?'if(url==='+JSON.stringify(delegationUrl)+')source='+JSON.stringify(preimageSource)+';':''}${preimageExecutorSource?'if(url==='+JSON.stringify(executorUrl)+')source='+JSON.stringify(preimageExecutorSource)+';':''}${body}}`;
const {base,loader,delegation,lock,env,writeLoader}=nestedSourceRuntime(repo,withPreimage('return source;'));
const owner=join(base,'owner.mjs'),holder=join(base,'holder.mjs'),leaf=join(base,'leaf.mjs'),sibling=join(base,'sibling.mjs');
if(mode==='retirement-backoff') {
 const anchor='function identity(pid: number): ProcessIdentity {';
 writeLoader(withPreimage(`if(url!==${JSON.stringify(delegation)})return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==2)throw Error('identity observation anchor mismatch');return source.replace(anchor,anchor+'globalThis.__identityObservations=(globalThis.__identityObservations??0)+1;');`));
}
if(mode==='coalesced') {
 const anchor="socket.write(JSON.stringify({ grant, signature: signCanonical(grant, keys.privateKey) }) + '\\n');";
 const replacement="const revocation={reservation:owner.lockId,grantId:grant.grantId};socket.write(JSON.stringify({grant,signature:signCanonical(grant,keys.privateKey)})+'\\n'+JSON.stringify({revocation,signature:signCanonical(revocation,keys.privateKey)})+'\\n');";
 writeLoader(withPreimage(`if(url!==${JSON.stringify(delegation)}||!process.argv.includes('--coalesce-owner'))return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==3)throw Error('coalesce source anchor mismatch');return source.replace(anchor,${JSON.stringify(replacement)});`));
}
const imports=`import {spawn} from 'node:child_process';import assert from 'node:assert/strict';const api=await import(${JSON.stringify(delegation)});const {withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});const root=${JSON.stringify(base)};const options=()=>({root,workspaceRoot:root,command:'own EOF diagnostic',deadlineAt:Date.now()+10000});const wait=ms=>new Promise(r=>setTimeout(r,ms));const go=()=>new Promise(r=>process.once('message',r));`;
writeFileSync(leaf,imports+`await go();await api.confirmValidationReservationRegistration();process.send({ready:true});setInterval(()=>{},1000);`);
writeFileSync(sibling,imports+`await go();await api.confirmValidationReservationRegistration();await machine(options(),()=>process.send({entered:true}));process.disconnect();`);
writeFileSync(holder,imports+`await go();await api.confirmValidationReservationRegistration();await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(leaf)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});child.once('message',()=>process.send({leafPid:child.pid}));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});await new Promise(()=>{});});`);
writeFileSync(owner,imports+`let leafPid,leafStart;const {observedProcessStartTimeMs}=await import(${JSON.stringify('file://'+repo+'/packages/main/src/core/mkdir-lock.ts')});await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const childClosed=new Promise(r=>child.once('close',r));const ready=new Promise(r=>child.once('message',m=>{leafPid=m.leafPid;leafStart=observedProcessStartTimeMs(leafPid);r();}));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});await ready;child.kill('SIGKILL');await childClosed;const siblingToken=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(siblingToken);const other=spawn(process.execPath,[${JSON.stringify(sibling)},'--request-observer'],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});let entered=false,requestResolve;const requestReady=new Promise(r=>{requestResolve=r;});other.on('message',m=>{if(m.entered)entered=true;if(m.requestSent)requestResolve();});const otherClosed=new Promise(r=>other.once('close',(code,signal)=>r({code,signal})));await api.registerValidationReservationChild(other.pid,siblingToken);other.send({go:true});await requestReady;await wait(700);assert.equal(entered,false,'EOF released a live registered descendant claim');assert.equal(observedProcessStartTimeMs(leafPid),leafStart);process.kill(leafPid,'SIGTERM');const goneBy=Date.now()+2000;for(;;){try{process.kill(leafPid,0);}catch(error){if(error.code==='ESRCH')break;throw error;}if(Date.now()>goneBy)throw Error('own diagnostic leaf did not disappear');await wait(10);}const siblingResult=await otherClosed;assert.deepEqual(siblingResult,{code:0,signal:null});assert.equal(entered,true);console.log('UNEXPECTED_EOF_RETAINS_DESCENDANT_CLAIMS PASS');});`);
if(mode==='same-group'||mode==='pending') {
 let value=readFileSync(holder,'utf8');
 if(mode==='same-group')value=value.replace('const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);','').replace('detached:true','detached:false').replace('await api.registerValidationReservationChild(child.pid,token);','');
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
 writeFileSync(owner,imports+`await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const closed=new Promise(r=>child.once('close',r));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});assert.equal(await closed,0);});`);
}
if(mode==='finite-owner') {
 writeFileSync(owner,imports+`const {fstatSync,readSync}=await import('node:fs');await machine({...options(),resources:[{class:'machine-cpu',key:'heavy',access:'exclusive'}]},async()=>{const fd=api.validationReservationChildStdio(['ignore','inherit','inherit','ipc'])[4];const bytes=Buffer.alloc(Number(fstatSync(fd).size));readSync(fd,bytes,0,bytes.length,0);const owner=JSON.parse(bytes);let entered=false;await assert.rejects(()=>api.withMachineReservationController({...owner,resources:null},()=>true,()=>{entered=true;}),/declaration mismatch/);assert.equal(entered,false);console.log('FINITE_OWNER_WIDENED_CONTROLLER_REFUSED PASS');});`);
}
if(mode.startsWith('declared-owner-')) {
 // A resource-declaring owner (exactly the claims the registered selectors declare) admits a
 // cross-process descendant whose command carries no classification, and refuses one that
 // claims a resource outside the declaration. Real executor, controller and detached child.
 const declared="[{class:'machine-cpu',key:'heavy',access:'exclusive'},{class:'machine-process',key:'fanout',access:'exclusive'}]";
 writeFileSync(holder,imports+(mode==='declared-owner-unclassified'
  ?`await go();await api.confirmValidationReservationRegistration();const {runSingleAllowlistedCommand:run}=await import(${JSON.stringify(new URL('../packages/main/src/core/validation-executor.ts',pathToFileURL(repo+'/scripts/')).href)});const result=await run('node -e "console.log(4321)"',root,{timeoutMs:3000});assert.equal(result.code,0,'DECLARED_OWNER_UNCLASSIFIED_DESCENDANT_REFUSED '+result.output);assert.match(result.output,/4321/);console.log('DECLARED_OWNER_UNCLASSIFIED_DESCENDANT_ADMITTED PASS');process.disconnect();`
  :`await go();await api.confirmValidationReservationRegistration();const {createServer}=await import('node:net');const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));let entered=false;await assert.rejects(()=>machine({...options(),resources:[{class:'machine-cpu',key:'heavy',access:'exclusive'},{class:'fixed-port',key:String(port),access:'exclusive'}]},()=>{entered=true;}),/resource expansion/);assert.equal(entered,false);await machine({...options(),resources:[{class:'machine-cpu',key:'heavy',access:'exclusive'}]},()=>{entered=true;});assert.equal(entered,true,'exact subset claim must still be admitted');console.log('DECLARED_OWNER_EXPANSION_REFUSED PASS');process.disconnect();`));
 writeFileSync(owner,imports+`await machine({...options(),resources:${declared}},async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const closed=new Promise(r=>child.once('close',r));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});assert.equal(await closed,0);});`);
}
if(mode==='retirement-backoff') {
 // A descendant that released its grant but stays alive is not yet retirable. Its
 // retirement must not spawn a kernel observation every 20 ms for as long as it lives.
 // The holder releases its grant but leaves a same-group grandchild alive, so the released
 // grant cannot retire while that work remains; retirement polling must back off meanwhile.
 writeFileSync(holder,imports+`await go();await api.confirmValidationReservationRegistration();const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await machine(options(),()=>{});process.send({released:true});await wait(1500);grandchild.kill('SIGKILL');await new Promise(r=>grandchild.once('exit',r));process.disconnect();`);
 writeFileSync(owner,imports+`await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const closed=new Promise(r=>child.once('close',r));const released=new Promise(r=>child.on('message',m=>{if(m.released)r();}));await api.registerValidationReservationChild(child.pid,token);assert.ok((globalThis.__identityObservations??0)>0,'identity observation hook must be active');child.send({go:true});await released;await wait(100);const before=globalThis.__identityObservations??0;await wait(1000);const during=(globalThis.__identityObservations??0)-before;assert.equal(await closed,0);assert.ok(during>0,'a lingering released grant must still be observed');assert.ok(during<=12,'RETIREMENT_OBSERVATIONS_UNBOUNDED '+during);console.log('RETIREMENT_BACKOFF_BOUNDED PASS observations='+during);});`);
}
if(mode==='controller-transport-unavailable') {
 // The first listen of this process fails; later listens succeed. The owner's admission must be
 // refused by name, leave no scratch directory behind and keep the machine ticket usable.
 const anchor='server.listen(socketPath, resolve);';
 writeLoader(withPreimage(`if(url!==${JSON.stringify(delegation)})return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==2)throw Error('listen anchor mismatch');return source.replace(anchor,"if(!globalThis.__listenFailed){globalThis.__listenFailed=true;server.listen(socketPath+'/missing/s', resolve);}else server.listen(socketPath, resolve);");`));
 writeFileSync(owner,imports+`const {readdirSync}=await import('node:fs');const {tmpdir}=await import('node:os');const scratch=()=>readdirSync(tmpdir()).filter(name=>name.startsWith('validation-owner-')).length;const before=scratch();await assert.rejects(()=>machine(options(),()=>{throw Error('UNEXPECTED_ENTRY');}),/controller transport unavailable/);assert.equal(scratch(),before,'transport failure must leave no scratch directory');let entered=false;await machine(options(),()=>{entered=true;});assert.equal(entered,true,'ticket must remain usable after a transport failure');console.log('CONTROLLER_TRANSPORT_UNAVAILABLE_NAMED_AND_CLEAN PASS');`);
}
if(mode==='drain-observation-transient') {
 // The controller's retirement tick observes the requesting sibling; its first four observations
 // fail (more than one bounded retry), so the queued request must survive a requeue and be granted.
 const anchor='function identity(pid: number): ProcessIdentity {';
 writeLoader(withPreimage(`if(url!==${JSON.stringify(delegation)})return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==2)throw Error('identity anchor mismatch');return source.replace(anchor,anchor+"if(pid===globalThis.__transientPid&&(globalThis.__transientFailures=(globalThis.__transientFailures??0)+1)<=4)throw failure('controlled transient observation unavailable');");`));
 writeFileSync(holder,imports+`await go();await api.confirmValidationReservationRegistration();process.send({confirmed:true});await go();let entered=false;await machine(options(),()=>{entered=true;});assert.equal(entered,true);console.log('DRAIN_OBSERVATION_TRANSIENT_RECOVERED PASS');process.disconnect();`);
 writeFileSync(owner,imports+`await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const closed=new Promise(r=>child.once('close',r));const confirmed=new Promise(r=>child.on('message',m=>{if(m.confirmed)r();}));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});await confirmed;globalThis.__transientPid=child.pid;child.send({go:true});assert.equal(await closed,0);assert.ok((globalThis.__transientFailures??0)>=4,'transient failures must have been injected: '+globalThis.__transientFailures);});`);
}
if(mode==='unattempted-owner-loss'||mode==='attempted-owner-loss') {
 // A descendant prepares a pending fence and dies before spawning. Without a spawn-attempt marker
 // the fence resolves once the descendant is proven gone; with the marker it stays terminal.
 const attempted=mode==='attempted-owner-loss';
 writeFileSync(holder,imports+`await go();await api.confirmValidationReservationRegistration();const token=await api.prepareValidationReservationChild();${attempted?'await api.attemptValidationReservationSpawn(token);':''}process.send({prepared:true});process.exit(0);`);
 writeFileSync(owner,imports+`await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const closed=new Promise(r=>child.once('close',r));const prepared=new Promise(r=>child.on('message',m=>{if(m.prepared)r();}));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});await prepared;assert.equal(await closed,0);console.log(${JSON.stringify(attempted?'ATTEMPTED_PENDING_FENCE_RETAINED_AFTER_OWNER_LOSS':'UNATTEMPTED_PENDING_RELEASED_AFTER_OWNER_LOSS')});});console.log(${JSON.stringify(attempted?'ATTEMPTED_PENDING_FENCED PASS':'UNATTEMPTED_PENDING_RELEASED PASS')});`);
}
if(mode==='spawned-owner-loss') {
 // A descendant marks its fence, spawns a detached leaf, notes the leaf PID on the fence and dies
 // before registering. While the leaf lives the fence stays (doctor reports a noted spawned PID);
 // once the leaf and its group are gone the fence resolves through the note and the owner releases
 // cleanly. The note call is guarded so a pre-repair replay reaches the assertions, where the marked
 // fence stays targetless and terminal.
 writeFileSync(leaf,`setInterval(()=>{},1000);`);
 writeFileSync(holder,imports+`await go();await api.confirmValidationReservationRegistration();const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(leaf)}],{stdio:'ignore',detached:true});await new Promise(r=>child.once('spawn',r));if(typeof api.noteValidationReservationSpawn==='function')await api.noteValidationReservationSpawn(token,child.pid);child.unref();process.send({leafPid:child.pid});process.exit(0);`);
 writeFileSync(owner,imports+`const {readdirSync}=await import('node:fs');const {join}=await import('node:path');await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const closed=new Promise(r=>child.once('close',r));let leafPid;const noted=new Promise(r=>child.on('message',m=>{if(m.leafPid){leafPid=m.leafPid;process.send({ownedPid:leafPid});r();}}));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});await noted;assert.equal(await closed,0,'holder must exit cleanly');const pool=join(root,'home','.proof-or-stop','locks','machine-fixed-port-capacity');const tickets=readdirSync(pool).filter(name=>name.endsWith('.ticket')).map(name=>join(pool,name));assert.equal(tickets.length,1);await wait(300);const live=api.classifyMachineReservationResiduals(tickets[0]);assert.equal(live.pendingTargetless,0,'a noted spawned PID must not leave the fence targetless: '+JSON.stringify(live));assert.equal(live.pendingSpawnedLive,1,'the noted spawned PID keeps the fence while the leaf lives: '+JSON.stringify(live));process.kill(leafPid,'SIGTERM');const until=Date.now()+4000;let classified;for(;;){classified=api.classifyMachineReservationResiduals(tickets[0]);if(classified.pendingSpawnedLive===0&&classified.pendingTargetless===0&&classified.pendingSpawnedResolved===0&&classified.pendingUnattemptedResolved===0)break;if(Date.now()>until)throw new Error('SPAWNED_OWNER_LOSS_NOT_RESOLVED '+JSON.stringify(classified));await wait(50);}console.log('SPAWNED_OWNER_LOSS_RESOLVED '+JSON.stringify(classified));});console.log('SPAWNED_OWNER_LOSS PASS');`);
}
if(mode==='registered-row-pruned') {
 // A registered descendant that exits leaves a resolved enrollment; once its PID and whole group are
 // proven absent the controller prunes the row from the published residual record instead of carrying
 // it, and its classification, for the rest of the run.
 writeFileSync(holder,imports+`await go();await api.confirmValidationReservationRegistration();process.exit(0);`);
 writeFileSync(owner,imports+`const {readdirSync}=await import('node:fs');const {join}=await import('node:path');await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const closed=new Promise(r=>child.once('close',r));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});assert.equal(await closed,0,'registered descendant must exit cleanly');const pool=join(root,'home','.proof-or-stop','locks','machine-fixed-port-capacity');const tickets=readdirSync(pool).filter(name=>name.endsWith('.ticket')).map(name=>join(pool,name));assert.equal(tickets.length,1,'one live ticket expected');const until=Date.now()+4000;let classified;for(;;){classified=api.classifyMachineReservationResiduals(tickets[0]);if(classified.registeredLive===0&&classified.registeredResolved===0)break;if(Date.now()>until)throw new Error('RESOLVED_ENROLLMENT_NOT_PRUNED '+JSON.stringify(classified));await wait(50);}console.log('RESOLVED_ENROLLMENT_PRUNED '+JSON.stringify(classified));});console.log('REGISTERED_ROW_PRUNED PASS');`);
}
if(mode==='pending-lineage') {
 writeFileSync(leaf,`setInterval(()=>{},1000);`);
 writeFileSync(holder,imports+`await go();await api.confirmValidationReservationRegistration();let pending,child;await machine({...options(),resources:[{class:'machine-cpu',key:'heavy',access:'exclusive'}]},async()=>{pending=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(pending);child=spawn(process.execPath,[${JSON.stringify(leaf)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});});const closed=new Promise(r=>child.once('close',r));try{await assert.rejects(()=>api.registerValidationReservationChild(child.pid,pending),/pending parent invocation released/);console.log('PENDING_ANCESTRY_LAUNDERING_REFUSED PASS');}finally{child.kill('SIGTERM');await closed;}process.disconnect();`);
 writeFileSync(owner,imports+`await machine(options(),async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(holder)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});const closed=new Promise(r=>child.once('close',r));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});assert.equal(await closed,0);});`);
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
 console.log(output);assert.equal(result.code,['pending','pending-lineage','attempted-owner-loss'].includes(mode)?1:0,output);assert.match(output,mode==='spawned-owner-loss'?/SPAWNED_OWNER_LOSS PASS/:mode==='registered-row-pruned'?/REGISTERED_ROW_PRUNED PASS/:mode==='pending-lineage'?/PENDING_ANCESTRY_LAUNDERING_REFUSED PASS/:mode==='finite-owner'?/FINITE_OWNER_WIDENED_CONTROLLER_REFUSED PASS/:mode==='coalesced'?/COALESCED_SIGNED_REVOCATION_REFUSES_ENTRY PASS/:mode==='declared-owner-unclassified'?/DECLARED_OWNER_UNCLASSIFIED_DESCENDANT_ADMITTED PASS/:mode==='declared-owner-expansion'?/DECLARED_OWNER_EXPANSION_REFUSED PASS/:mode==='retirement-backoff'?/RETIREMENT_BACKOFF_BOUNDED PASS/:mode==='controller-transport-unavailable'?/CONTROLLER_TRANSPORT_UNAVAILABLE_NAMED_AND_CLEAN PASS/:mode==='drain-observation-transient'?/DRAIN_OBSERVATION_TRANSIENT_RECOVERED PASS/:mode==='unattempted-owner-loss'?/UNATTEMPTED_PENDING_RELEASED PASS/:mode==='attempted-owner-loss'?/ATTEMPTED_PENDING_FENCE_RETAINED_AFTER_OWNER_LOSS/:/UNEXPECTED_EOF_RETAINS_DESCENDANT_CLAIMS PASS/);if(['pending','pending-lineage','attempted-owner-loss'].includes(mode))assert.match(output,/owned group cleanup unproven/);console.log('NESTED_RESERVATION_FAULT '+mode+' PASS');
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

