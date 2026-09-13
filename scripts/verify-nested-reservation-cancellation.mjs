import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';

// Real capture/queue/controller. The only fault is workload expiry immediately
// after actual prepare: no fake ticket, pending token or kernel observation.
const modes=['normal','capture-deadline','explicit-cleanup-expired','spoof-cancel'];
const selected=process.argv[2]?[process.argv[2]]:modes;
for(const mode of selected){
 assert.ok(modes.includes(mode));
 const runtime=nestedSourceRuntime(process.cwd());
 const {base,delegation,lock,executor,env}=runtime;
 const anchor='const pendingSpawn = await prepareValidationReservationChild({deadlineAt: options.deadlineAt, signal: options.abortSignal});';
 runtime.writeLoader(`function patch(url,source){if(url!==${JSON.stringify(executor)}||${JSON.stringify(mode)}!=='capture-deadline')return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==2)throw Error('actual capture prepare boundary moved');return source.replace(anchor,anchor+'\\n options={...options,deadlineAt:Date.now()-1};');}`);
 const attacker=join(base,'raw-cancel.mjs');
 writeFileSync(attacker,`import {createConnection}from'node:net';const input=JSON.parse(process.argv[2]);const socket=createConnection(input.socket);let bytes='';socket.once('connect',()=>socket.write(JSON.stringify(input.request)+'\\n'));socket.on('data',chunk=>{bytes+=chunk;if(bytes.includes('\\n')){console.log(bytes.slice(0,bytes.indexOf('\\n')));socket.destroy();}});socket.on('error',error=>{console.error(error.message);process.exitCode=1;});setTimeout(()=>{socket.destroy();process.exitCode=1;},2000).unref();`);
 const entry=join(base,'cancellation.mjs');
 writeFileSync(entry,`import assert from 'node:assert/strict';import {spawn}from'node:child_process';import {fstatSync,readSync}from'node:fs';import {randomUUID}from'node:crypto';
 const api=await import(${JSON.stringify(delegation)}),{withMachineValidationResources:machine}=await import(${JSON.stringify(lock)}),{runSingleAllowlistedCommand:run}=await import(${JSON.stringify(executor)});
 const original=new Error('ORIGINAL_CAPTURE_DEADLINE');let observed;
 if(${JSON.stringify(mode)}==='spoof-cancel')await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'raw destructive cancellation refusal',deadlineAt:Date.now()+7000},async()=>{
  const token=await api.prepareValidationReservationChild(),fd=api.validationReservationChildStdio()[4],bytes=Buffer.alloc(fstatSync(fd).size);readSync(fd,bytes,0,bytes.length,0);const bootstrap=JSON.parse(bytes.toString());
  const raw={socket:bootstrap.socket,request:{operation:'cancel',pid:process.pid,start:bootstrap.start,nonce:randomUUID(),pendingToken:token,deadlineAt:Date.now()+1800}};
  const child=spawn(process.execPath,[${JSON.stringify(attacker)},JSON.stringify(raw)],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);const code=await new Promise(resolve=>child.once('close',resolve));assert.equal(code,0,errors);const response=JSON.parse(output);
  const refused=typeof response.error==='string';if(refused)await api.cancelValidationReservationChild(token,{deadlineAt:Date.now()+1500});assert.equal(refused,true,'RAW_VICTIM_TOKEN_CANCEL_MUST_REFUSE');
 });else if(${JSON.stringify(mode)}==='capture-deadline'){
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
