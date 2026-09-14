import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';

// Real capture/queue/controller. The only fault is workload expiry immediately
// after actual prepare: no fake ticket, pending token or kernel observation.
const preimage=process.argv.find(arg=>arg.startsWith('--preimage='))?.slice('--preimage='.length);
const modes=['normal','capture-deadline','explicit-cleanup-expired','spoof-cancel','spoof-register','delegated-abort','refused-registration-withdrawn','refused-registration-live'];
const selected=process.argv[2]?[process.argv[2]]:modes;
for(const mode of selected){
 assert.ok(modes.includes(mode));
 const runtime=nestedSourceRuntime(process.cwd());
 const {base,delegation,lock,executor,env}=runtime;
 const anchor='const pendingSpawn = await prepareValidationReservationChild({deadlineAt: options.deadlineAt, signal: options.abortSignal});';
 // The refused modes fail every registration observation of the live controller, as an
 // exhausted bounded retry would; the executor then owns the fence withdrawal decision.
 const refused=mode.startsWith('refused-registration-'),observation='target = observeWithRetry(() => identity(pid));',ready=join(base,'workload-ready');
 const hook=`target = observeWithRetry(() => { const until = Date.now() + 4000; while (!existsSync(${JSON.stringify(ready)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); throw failure('process identity unavailable'); });`;
 runtime.writeLoader(`function patch(url,source){${preimage?'if(url==='+JSON.stringify(delegation)+')return '+JSON.stringify(readFileSync(preimage,'utf8'))+';':''}if(${JSON.stringify(refused)}&&url===${JSON.stringify(delegation)}){const anchor=${JSON.stringify(observation)};if(source.split(anchor).length!==2)throw Error('registration observation anchor moved');return source.replace(anchor,${JSON.stringify(hook)});}if(url!==${JSON.stringify(executor)}||${JSON.stringify(mode)}!=='capture-deadline')return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==2)throw Error('actual capture prepare boundary moved');return source.replace(anchor,anchor+'\\n options={...options,deadlineAt:Date.now()-1};');}`);
 // Real allowlisted workloads: one exits on the refusal signal; one ignores it, leaves a
 // same-group grandchild that also ignores it, and exits, so its group outlives the direct
 // child. The refusal is issued only after the workload reports its signal handling ready.
 const refusedChild=join(base,'refused-child.mjs'),liveGroupChild=join(base,'refused-live-group.mjs'),grandchildPid=join(base,'grandchild.pid');
 writeFileSync(refusedChild,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},'1');setInterval(()=>{},1000);`);
 writeFileSync(liveGroupChild,`process.on('SIGTERM',()=>{});import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync("+JSON.stringify(${JSON.stringify(ready)})+",'1');setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(${JSON.stringify(grandchildPid)},String(grandchild.pid));grandchild.unref();`);
 const attacker=join(base,'raw-cancel.mjs');
 writeFileSync(attacker,`import {createConnection}from'node:net';const input=JSON.parse(process.argv[2]);const socket=createConnection(input.socket);let bytes='';socket.once('connect',()=>socket.write(JSON.stringify(input.request)+'\\n'));socket.on('data',chunk=>{bytes+=chunk;if(bytes.includes('\\n')){console.log(bytes.slice(0,bytes.indexOf('\\n')));socket.destroy();}});socket.on('error',error=>{console.error(error.message);process.exitCode=1;});setTimeout(()=>{socket.destroy();process.exitCode=1;},2000).unref();`);
 const delegated=join(base,'delegated-cancel.mjs');
 writeFileSync(delegated,`import assert from 'node:assert/strict';import {spawn}from'node:child_process';import {fstatSync,readSync}from'node:fs';import {randomUUID}from'node:crypto';const api=await import(${JSON.stringify(delegation)}),{withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});await new Promise(resolve=>process.once('message',resolve));await api.confirmValidationReservationRegistration();if(${JSON.stringify(mode)}==='spoof-register'){const token=await api.prepareValidationReservationChild();const fd=api.validationReservationChildStdio()[4],bytes=Buffer.alloc(fstatSync(fd).size);readSync(fd,bytes,0,bytes.length,0);const bootstrap=JSON.parse(bytes.toString()),subject=api.observeValidationReservationChild(process.pid);const raw={socket:bootstrap.socket,request:{operation:'register',targetPid:2147483647,pid:process.pid,start:subject.start,nonce:randomUUID(),pendingToken:token,deadlineAt:Date.now()+1800}};const child=spawn(process.execPath,[${JSON.stringify(attacker)},JSON.stringify(raw)],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);assert.equal(await new Promise(resolve=>child.once('close',resolve)),0,errors);const response=JSON.parse(output);console.log('RAW_REGISTER_RESPONSE '+JSON.stringify(response.error??'accepted'));const refused=typeof response.error==='string';if(refused)await api.cancelValidationReservationChild(token,{deadlineAt:Date.now()+1500});assert.equal(refused,true,'RAW_ENROLLED_VICTIM_TOKEN_REGISTER_MUST_REFUSE');console.log('DELEGATED_ABORT_CLEANUP_PASS');process.disconnect();}else{const abort=new AbortController();await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'delegated expired workload cleanup',deadlineAt:Date.now()+4000,abortSignal:abort.signal},async()=>{const pending=await api.prepareValidationReservationChild();abort.abort(new Error('WORKLOAD_ABORT_CONTROL'));await api.cancelValidationReservationChild(pending,{deadlineAt:Date.now()+1800});await assert.rejects(()=>api.prepareValidationReservationChild(),/expired|revoked|closed/);});console.log('DELEGATED_ABORT_CLEANUP_PASS');process.disconnect();}`);
 const entry=join(base,'cancellation.mjs');
 writeFileSync(entry,`import assert from 'node:assert/strict';import {spawn}from'node:child_process';import {fstatSync,readSync}from'node:fs';import {randomUUID}from'node:crypto';
 const api=await import(${JSON.stringify(delegation)}),{withMachineValidationResources:machine}=await import(${JSON.stringify(lock)}),{runSingleAllowlistedCommand:run}=await import(${JSON.stringify(executor)});
 const original=new Error('ORIGINAL_CAPTURE_DEADLINE');let observed;
 if(['delegated-abort','spoof-register'].includes(${JSON.stringify(mode)}))await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'controlled delegated cleanup parent',deadlineAt:Date.now()+8000},async()=>{
  const token=await api.prepareValidationReservationChild();const child=spawn(process.execPath,[${JSON.stringify(delegated)}],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','pipe','pipe','ipc']),detached:true});let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);const closed=new Promise(resolve=>child.once('close',resolve));await api.registerValidationReservationChild(child.pid,token);child.send({go:true});assert.equal(await closed,0,errors);assert.match(output,/DELEGATED_ABORT_CLEANUP_PASS/);
 });else if(${JSON.stringify(mode)}.startsWith('spoof-'))await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'raw destructive cancellation refusal',deadlineAt:Date.now()+7000},async()=>{
  const token=await api.prepareValidationReservationChild(),fd=api.validationReservationChildStdio()[4],bytes=Buffer.alloc(fstatSync(fd).size);readSync(fd,bytes,0,bytes.length,0);const bootstrap=JSON.parse(bytes.toString());
  const raw={socket:bootstrap.socket,request:{operation:${JSON.stringify(mode)}==='spoof-register'?'register':'cancel',targetPid:2147483647,pid:process.pid,start:bootstrap.start,nonce:randomUUID(),pendingToken:token,deadlineAt:Date.now()+1800}};
  const child=spawn(process.execPath,[${JSON.stringify(attacker)},JSON.stringify(raw)],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);const code=await new Promise(resolve=>child.once('close',resolve));assert.equal(code,0,errors);const response=JSON.parse(output);
  const refused=typeof response.error==='string';if(refused)await api.cancelValidationReservationChild(token,{deadlineAt:Date.now()+1500});assert.equal(refused,true,'RAW_VICTIM_TOKEN_MUTATION_MUST_REFUSE '+${JSON.stringify(mode)});
 });else if(${JSON.stringify(refused)}){
  const {existsSync,readdirSync,readFileSync}=await import('node:fs'),{join}=await import('node:path');
  const tickets=()=>{const pool=join(${JSON.stringify(base)},'home','.proof-or-stop','locks','machine-fixed-port-capacity');return existsSync(pool)?readdirSync(pool).filter(name=>name.endsWith('.ticket')).map(name=>join(pool,name)):[];};
  let result,outcome;
  try{await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'refused registration withdrawal control',deadlineAt:Date.now()+8000},async()=>{result=await run('node '+JSON.stringify(${JSON.stringify(mode)}==='refused-registration-live'?${JSON.stringify(liveGroupChild)}:${JSON.stringify(refusedChild)}),${JSON.stringify(base)},{timeoutMs:6000});});}catch(error){outcome=error;}
  assert.ok(result,'a refused registration must still yield a bounded command result: '+String(outcome));assert.notEqual(result.code,0,'refused registration must not report success');assert.match(result.output,/process identity unavailable/);
  if(${JSON.stringify(mode)}==='refused-registration-withdrawn'){assert.equal(outcome,undefined,'withdrawn fence must let the live controller release cleanly: '+String(outcome));assert.equal(tickets().length,0,'released ticket must be gone');console.log('REFUSED_REGISTRATION_FENCE_WITHDRAWN');}
  else{const gone=Number(readFileSync(${JSON.stringify(grandchildPid)},'utf8'));try{assert.match(outcome?.message??'',/owned group cleanup unproven/);assert.ok(outcome.cleanupDiagnostics.residuals.some(row=>row.kind==='pending'),'pending fence must remain while the group is live');const fenced=tickets();assert.equal(fenced.length,1,'fenced ticket must remain');const classified=api.classifyMachineReservationResiduals(fenced[0]);assert.deepEqual([classified.present,classified.pendingTargetless],[true,1],JSON.stringify(classified));}finally{try{process.kill(gone,'SIGKILL');}catch{}}
   console.log('REFUSED_REGISTRATION_FENCE_KEPT_WHILE_GROUP_LIVE');
  }
 }else if(${JSON.stringify(mode)}==='capture-deadline'){
  try{await run('node -e "console.log(12345)"',${JSON.stringify(base)},{timeoutMs:3000,deadlineError:()=>original});}catch(error){observed=error;}
  assert.equal(observed,original,'ACTUAL_CAPTURE_PRIMARY_ERROR_AND_NO_SPAWN_CLEANUP_REQUIRED '+String(observed));
 }else await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'owned no-spawn cancellation control',deadlineAt:Date.now()+7000},async()=>{
   const pending=await api.prepareValidationReservationChild();
   if(${JSON.stringify(mode)}==='explicit-cleanup-expired')await assert.rejects(()=>api.cancelValidationReservationChild(pending,{deadlineAt:Date.now()-1}),/expired|deadline/);
   await api.cancelValidationReservationChild(pending,{deadlineAt:Date.now()+1500});
 });
 if(${JSON.stringify(mode)}!=='refused-registration-live'){let entered=false;await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'post-cancellation actual admission',deadlineAt:Date.now()+3000},()=>{entered=true;});assert.equal(entered,true);}
 console.log('OWNED_NO_SPAWN_CANCELLATION '+${JSON.stringify(mode)}+' PASS');`);
 try{const child=spawnSync(process.execPath,[entry],{env,encoding:'utf8',timeout:12000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'ACTUAL_CAPTURE_PRIMARY_ERROR_AND_NO_SPAWN_CLEANUP_REQUIRED '+mode);}
 finally{rmSync(base,{recursive:true,force:true});}
}
console.log('NESTED_RESERVATION_CANCELLATION PASS');
