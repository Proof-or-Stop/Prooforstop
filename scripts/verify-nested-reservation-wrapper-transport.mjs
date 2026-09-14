import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';

// On Darwin a plain Node wrapper (npm, a suite runner spawning with stdio 'inherit')
// receives only its listed stdio descriptors, so the reserved descriptor is dropped
// while the locator environment survives. The descendant must then run without a
// borrowed reservation, diagnose the loss exactly once and forward no locator. A
// cooperating wrapper that forwards through the exported helpers keeps delegation.
// Both wrappers are real registered detached children of a live controller; no
// synthetic ticket, token or kernel observation is used.
const runtime=nestedSourceRuntime(process.cwd()),{base,delegation,lock,env}=runtime;
const probe=join(base,'transport-probe.mjs');
writeFileSync(probe,`const api=await import(${JSON.stringify(delegation)});const mode=process.argv[2];const token=await api.prepareValidationReservationChild({deadlineAt:Date.now()+3000});const forwarded=api.validationReservationChildEnvironment({...process.env});const stdio=api.validationReservationChildStdio(['ignore','pipe','pipe']);console.log('TRANSPORT_PROBE '+JSON.stringify({mode,token:typeof token,locator:forwarded.PROOF_OR_STOP_VALIDATION_RESERVATION_FD??null,slots:stdio.length}));if(typeof token==='string')await api.cancelValidationReservationChild(token,{deadlineAt:Date.now()+1500});`);
const wrapperSource=cooperating=>`import {spawnSync}from'node:child_process';const api=await import(${JSON.stringify(delegation)});await new Promise(resolve=>process.once('message',resolve));await api.confirmValidationReservationRegistration();const options=${cooperating
 ?"{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['inherit','inherit','inherit'])}"
 :"{env:{...process.env,PROOF_OR_STOP_DELEGATION_DIAGNOSTICS:process.env.WRAPPER_TRANSPORT_DIAGNOSE},stdio:process.env.WRAPPER_TRANSPORT_LINKED==='1'?['inherit','inherit','inherit','ignore',(await import('node:fs')).openSync("+JSON.stringify(join(base,'unrelated-linked-file'))+",'w')]:'inherit'}"};const result=spawnSync(process.execPath,[${JSON.stringify(probe)},${JSON.stringify(cooperating?'cooperating':'plain')}],options);process.disconnect();process.exit(result.status??1);`;
const plainWrapper=join(base,'plain-wrapper.mjs'),cooperatingWrapper=join(base,'cooperating-wrapper.mjs');
writeFileSync(plainWrapper,wrapperSource(false));writeFileSync(cooperatingWrapper,wrapperSource(true));
const entry=join(base,'wrapper-transport.mjs');
writeFileSync(entry,`import assert from 'node:assert/strict';import {spawn}from'node:child_process';const api=await import(${JSON.stringify(delegation)}),{withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});
await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'wrapper transport control',deadlineAt:Date.now()+20000},async()=>{
 const run=async (wrapper,extra={})=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[wrapper],{env:{...api.validationReservationChildEnvironment(process.env),...extra},stdio:api.validationReservationChildStdio(['ignore','pipe','pipe','ipc']),detached:true});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);await api.registerValidationReservationChild(child.pid,token);child.send({go:true});const status=await new Promise(resolve=>child.once('close',code=>resolve(code)));return {status,stdout,stderr};};
 const plain=await run(${JSON.stringify(plainWrapper)},{WRAPPER_TRANSPORT_DIAGNOSE:'1'});assert.equal(plain.status,0,'plain wrapper: '+plain.stdout+plain.stderr);
 const plainProbe=JSON.parse(plain.stdout.match(/TRANSPORT_PROBE (\\{.*\\})/)[1]);
 assert.deepEqual(plainProbe,{mode:'plain',token:'undefined',locator:null,slots:3},'dropped transport must degrade without a token, locator or reserved slot: '+plain.stdout);
 assert.equal((plain.stderr.match(/VALIDATION_DELEGATION_UNAVAILABLE/g)||[]).length,1,'dropped transport is diagnosed exactly once when opted in: '+plain.stderr);
 const silent=await run(${JSON.stringify(plainWrapper)});assert.equal(silent.status,0,'silent plain wrapper: '+silent.stdout+silent.stderr);
 assert.deepEqual(JSON.parse(silent.stdout.match(/TRANSPORT_PROBE (\\{.*\\})/)[1]),plainProbe,'degradation is identical without the opt-in');
 assert.equal(silent.stderr,'','child output stays byte-identical without the diagnostics opt-in: '+silent.stderr);
 const linked=await run(${JSON.stringify(plainWrapper)},{WRAPPER_TRANSPORT_DIAGNOSE:'1',WRAPPER_TRANSPORT_LINKED:'1'});assert.equal(linked.status,0,'plain wrapper with a linked file at the reserved slot: '+linked.stdout+linked.stderr);
 assert.deepEqual(JSON.parse(linked.stdout.match(/TRANSPORT_PROBE (\\{.*\\})/)[1]),plainProbe,'an unrelated linked file at the reserved slot degrades like a dropped transport');
 assert.match(linked.stderr,/VALIDATION_DELEGATION_UNAVAILABLE: reserved descriptor is an unrelated linked file/,'the linked-file degradation names its reason: '+linked.stderr);
 const cooperating=await run(${JSON.stringify(cooperatingWrapper)});assert.equal(cooperating.status,0,'cooperating wrapper: '+cooperating.stdout+cooperating.stderr);
 const cooperatingProbe=JSON.parse(cooperating.stdout.match(/TRANSPORT_PROBE (\\{.*\\})/)[1]);
 assert.deepEqual(cooperatingProbe,{mode:'cooperating',token:'string',locator:'4',slots:5},'cooperating wrapper must forward the pending fence capability: '+cooperating.stdout);
 assert.doesNotMatch(cooperating.stderr,/VALIDATION_DELEGATION_UNAVAILABLE/,'forwarded transport is not diagnosed as dropped');
});
console.log('NESTED_RESERVATION_WRAPPER_TRANSPORT PASS');`);
try{const child=spawnSync(process.execPath,[entry],{env,encoding:'utf8',timeout:40000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'NESTED_RESERVATION_WRAPPER_TRANSPORT');}
finally{rmSync(base,{recursive:true,force:true});}
