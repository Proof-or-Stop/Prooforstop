import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs';
import {writeFileSync,rmSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {join,dirname,basename} from 'node:path';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
// Actual queue publication, with private OS-home lookup only. No synthetic ticket.
const runtime=nestedSourceRuntime(process.cwd()),{base,lock,env}=runtime;
// Controlled reader matrix uses the actual source functions with real private
// files and explicit kernel observations. This is not evidence of an actual reboot.
const ts=createRequire(join(process.cwd(),'packages/main/package.json'))('typescript');
const lockSource=fs.readFileSync(new URL(lock),'utf8');
const parsed=ts.createSourceFile('lock.ts',lockSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const names=['machineBootIdentity','canonicalMachineCapacityRoot','machineTicketPreviousBootIsProven','activeCapacityCandidates'];
const functions=names.map(name=>{const matches=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.equal(matches.length,1,name);return matches[0].getText(parsed).replace(/^export /,'');}).join('\n');
const home=join(base,'matrix-home'),pool=join(home,'.proof-or-stop','locks','machine-fixed-port-capacity');
const holder={lockId:'00000000-1111-2222-3333-444444444444',pid:12345,hostname:'controlled-host',processStartTimeMs:100};
const ticket=join(pool,'0000000000000001-'+holder.lockId+'.ticket'),path=join(ticket,'machine-boot.json');fs.mkdirSync(ticket,{recursive:true,mode:0o700});
const original={schema:'machine-ticket-boot.v1',platform:'darwin',uid:process.getuid(),...holder,bootId:'11111111-1111-1111-1111-111111111111'};
let classification='stale',quarantined=0;
let boot='22222222-2222-2222-2222-222222222222',queryFailure=false,owner='ESRCH',platform='darwin',queries=0;
const sandbox={...fs,capacityCandidates:()=>[{path:ticket,name:'candidate',holder,ageMs:200000}],classifyValidationCapacityLock:()=>classification,machineReservationResidualsPresent:()=>true,quarantineValidationCapacityCandidate:()=>{quarantined++;return true;},fsConstants:fs.constants,join,dirname,basename,userInfo:()=>({homedir:home,uid:process.getuid()}),hostname:()=>holder.hostname,PROOF_OR_STOP_DIR:'.proof-or-stop',MACHINE_FIXED_PORT_ARTIFACT:{directoryName:'machine-fixed-port-capacity'},VALIDATION_RESERVATION_DELEGATION_ARTIFACT:{bootFile:'machine-boot.json'},VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY:{kernelObservationMs:1000,maxMessageBytes:32768},process:{get platform(){return platform;},kill(pid,signal){assert.equal(pid,holder.pid);assert.equal(signal,0);if(owner==='live')return;throw Object.assign(new Error('controlled observation'),{code:owner});}},execFileSync(executable,args,options){queries++;assert.equal(executable,'/usr/sbin/sysctl');assert.deepEqual(Array.from(args),['-n','kern.bootsessionuuid']);assert.equal(options.timeout,1000);if(queryFailure)throw Error('controlled unavailable');return boot;}};
vm.createContext(sandbox);vm.runInContext(ts.transpileModule(functions+'\n globalThis.readBoot=machineTicketPreviousBootIsProven;globalThis.activeCandidates=activeCapacityCandidates;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,sandbox);
const save=value=>{fs.rmSync(path,{force:true});fs.writeFileSync(path,JSON.stringify(value),{mode:0o600});};
let checks=0;const expect=(wanted,label)=>{assert.equal(sandbox.readBoot(ticket,holder),wanted,label);checks++;};
save(original);expect(true,'different verified boot');
boot=original.bootId;expect(false,'same boot');boot='22222222-2222-2222-2222-222222222222';
for(const state of ['live','EPERM','EACCES']){owner=state;expect(false,'owner '+state);}owner='ESRCH';
queryFailure=true;expect(false,'kernel failure');queryFailure=false;
boot='malformed';expect(false,'invalid current UUID');boot='22222222-2222-2222-2222-222222222222';
platform='linux';expect(false,'unsupported platform');platform='darwin';
for(const [field,value] of Object.entries({schema:'other',platform:'linux',uid:original.uid+1,lockId:'other',pid:holder.pid+1,hostname:'other',processStartTimeMs:101,bootId:'bad'})){save({...original,[field]:value});expect(false,'mismatched '+field);}
save(original);fs.chmodSync(path,0o644);expect(false,'nonprivate witness');
fs.writeFileSync(path,'{');expect(false,'malformed witness');
fs.writeFileSync(path,' '.repeat(32769));expect(false,'oversized witness');
fs.rmSync(path);expect(false,'missing legacy witness');
const target=join(base,'boot-symlink-target');fs.writeFileSync(target,JSON.stringify(original),{mode:0o600});fs.symlinkSync(target,path);expect(false,'symlink witness');
save(original);fs.writeFileSync(join(ticket,'delegated-processes.json'),'{');expect(true,'different boot independent of corrupt residual');
assert.equal(sandbox.readBoot(join(base,'foreign.ticket'),holder),false);checks++;
// Exercise the actual queue decision, observing the quarantine call without
// deleting the controlled reader fixtures. No synthetic callback is admitted.
quarantined=0;assert.equal(sandbox.activeCandidates(pool,'.ticket',1000).length,0);assert.equal(quarantined,1);checks++;
classification='active';quarantined=0;assert.equal(sandbox.activeCandidates(pool,'.ticket',1000).length,1);assert.equal(quarantined,0);checks++;
classification='stale';boot=original.bootId;assert.equal(sandbox.activeCandidates(pool,'.ticket',1000).length,1);assert.equal(quarantined,0);checks++;
boot='22222222-2222-2222-2222-222222222222';owner='EPERM';assert.equal(sandbox.activeCandidates(pool,'.ticket',1000).length,1);assert.equal(quarantined,0);checks++;owner='ESRCH';
// Stale classification must stay an independent necessary condition in both readers.
assert.match(lockSource,/classification !== 'stale' \|\| lockRoot === canonicalMachineCapacityRoot\(\) && machineReservationResidualsPresent\(candidate.path\) && !machineTicketPreviousBootIsProven\(candidate.path, candidate.holder\)/);
const createNode=parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createValidationCapacityCandidate').getText(parsed);assert.ok(createNode.indexOf('bootFile')<createNode.indexOf('renameSync(preparingPath, path)'));
fs.rmSync(home,{recursive:true,force:true});console.log('MACHINE_TICKET_BOOT_READER_MATRIX PASS '+checks+' (controlled kernel observations; no reboot claimed)');
// The actual publication path must satisfy the reader: the controlled reader below is
// evaluated against the real published ticket, not a hand-made directory.
const readerFile=join(base,'boot-reader.js');writeFileSync(readerFile,ts.transpileModule(functions+'\n globalThis.readBoot=machineTicketPreviousBootIsProven;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText);
const entry=join(base,'boot-publication.mjs');
writeFileSync(entry,`import assert from 'node:assert/strict';import {execFileSync}from'node:child_process';import {readdirSync,readFileSync,lstatSync}from'node:fs';import {join}from'node:path';const {withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});
await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'actual boot-bound machine publication',deadlineAt:Date.now()+4000},async ()=>{
 const pool=join(${JSON.stringify(base)},'home','.proof-or-stop','locks','machine-fixed-port-capacity');const tickets=readdirSync(pool).filter(x=>x.endsWith('.ticket'));assert.equal(tickets.length,1);const ticket=join(pool,tickets[0]);let witness;try{witness=JSON.parse(readFileSync(join(ticket,'machine-boot.json'),'utf8'));}catch{}assert.ok(witness,'MACHINE_TICKET_BOOT_WITNESS_REQUIRED');const holder=JSON.parse(readFileSync(join(ticket,'holder.json'),'utf8'));assert.equal(witness.lockId,holder.lockId);assert.equal(witness.pid,process.pid);assert.equal(witness.bootId,execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8',timeout:1000}).trim().toLowerCase());assert.equal(lstatSync(join(ticket,'machine-boot.json')).isSymbolicLink(),false);assert.equal(lstatSync(ticket).mode&0o077,0,'MACHINE_TICKET_PRIVATE_DIRECTORY_MODE_REQUIRED');assert.equal(lstatSync(join(ticket,'machine-boot.json')).mode&0o077,0,'MACHINE_TICKET_PRIVATE_WITNESS_MODE_REQUIRED');const vm=await import('node:vm');const fs=await import('node:fs');const pathModule=await import('node:path');let bootValue='22222222-2222-2222-2222-222222222222';const sandbox={...fs,fsConstants:fs.constants,join:pathModule.join,dirname:pathModule.dirname,basename:pathModule.basename,userInfo:()=>({homedir:${JSON.stringify(join(base,'home'))},uid:process.getuid()}),hostname:()=>witness.hostname,PROOF_OR_STOP_DIR:'.proof-or-stop',MACHINE_FIXED_PORT_ARTIFACT:{directoryName:'machine-fixed-port-capacity'},VALIDATION_RESERVATION_DELEGATION_ARTIFACT:{bootFile:'machine-boot.json'},VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY:{kernelObservationMs:1000,maxMessageBytes:32768},process:{platform:'darwin',kill(pid,signal){assert.equal(pid,witness.pid);assert.equal(signal,0);throw Object.assign(new Error('controlled observation'),{code:'ESRCH'});}},execFileSync(executable){assert.equal(executable,'/usr/sbin/sysctl');return bootValue;}};vm.createContext(sandbox);vm.runInContext(readFileSync(${JSON.stringify(readerFile)},'utf8'),sandbox);const readerHolder={lockId:witness.lockId,pid:witness.pid,hostname:witness.hostname,processStartTimeMs:witness.processStartTimeMs};assert.equal(sandbox.readBoot(ticket,readerHolder),true,'MACHINE_TICKET_PUBLIC_PATH_BOOT_RECOVERY_REQUIRED');bootValue=witness.bootId;assert.equal(sandbox.readBoot(ticket,readerHolder),false,'same boot must retain the fence on the public path');console.log('MACHINE_TICKET_PUBLIC_PATH_RECOVERABLE PASS');
});console.log('MACHINE_TICKET_BOOT_PUBLICATION PASS');`);
try{const child=spawnSync(process.execPath,[entry],{env,encoding:'utf8',timeout:10000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'MACHINE_TICKET_BOOT_WITNESS_REQUIRED');}
finally{rmSync(base,{recursive:true,force:true});}
