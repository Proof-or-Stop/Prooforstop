import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
// Actual queue publication, with private OS-home lookup only. No synthetic ticket.
const runtime=nestedSourceRuntime(process.cwd()),{base,lock,env}=runtime;
const entry=join(base,'boot-publication.mjs');
writeFileSync(entry,`import assert from 'node:assert/strict';import {execFileSync}from'node:child_process';import {readdirSync,readFileSync,lstatSync}from'node:fs';import {join}from'node:path';const {withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});
await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'actual boot-bound machine publication',deadlineAt:Date.now()+4000},()=>{
 const pool=join(${JSON.stringify(base)},'home','.proof-or-stop','locks','machine-fixed-port-capacity');const tickets=readdirSync(pool).filter(x=>x.endsWith('.ticket'));assert.equal(tickets.length,1);const ticket=join(pool,tickets[0]);let witness;try{witness=JSON.parse(readFileSync(join(ticket,'machine-boot.json'),'utf8'));}catch{}assert.ok(witness,'MACHINE_TICKET_BOOT_WITNESS_REQUIRED');const holder=JSON.parse(readFileSync(join(ticket,'holder.json'),'utf8'));assert.equal(witness.lockId,holder.lockId);assert.equal(witness.pid,process.pid);assert.equal(witness.bootId,execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8',timeout:1000}).trim().toLowerCase());assert.equal(lstatSync(join(ticket,'machine-boot.json')).isSymbolicLink(),false);
});console.log('MACHINE_TICKET_BOOT_PUBLICATION PASS');`);
try{const child=spawnSync(process.execPath,[entry],{env,encoding:'utf8',timeout:10000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'MACHINE_TICKET_BOOT_WITNESS_REQUIRED');}
finally{rmSync(base,{recursive:true,force:true});}
