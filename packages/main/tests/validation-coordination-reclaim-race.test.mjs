import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
import {createFixtureMachineEnvironment} from '../dist/tasks/helpers/fixture-machine-environment.js';
const fixture=createFixtureMachineEnvironment();
const root=fs.mkdtempSync(join(fixture.root,'owner-')),copy=root+'-copy';
const ready=join(fixture.root,'ready'),trigger=join(fixture.root,'trigger'),cleaned=join(fixture.root,'cleaned');
const moduleUrl=new URL('../dist/core/validation-execution-lock.js',import.meta.url).href;
let owner;
try {
 owner=spawn(process.execPath,['--input-type=module','-e',`
import fs from 'node:fs';import{setTimeout as pause}from'node:timers/promises';
import {withWorkspaceValidationCapacity,cleanupAbandonedWorkspaceValidationCoordination}from ${JSON.stringify(moduleUrl)};
const root=${JSON.stringify(root)};
await withWorkspaceValidationCapacity({root,workspaceRoot:root,deadlineAt:Date.now()+5000},()=>{});
fs.writeFileSync(${JSON.stringify(ready)},'ready');
const end=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(trigger)})){if(Date.now()>end)throw Error('waiter did not reach ticket creation');await pause(10);}
fs.rmSync(root,{recursive:true});cleanupAbandonedWorkspaceValidationCoordination();fs.writeFileSync(${JSON.stringify(cleaned)},'cleaned');
`],{env:fixture.env,stdio:['ignore','ignore','pipe']});
 let ownerError='';owner.stderr.on('data',b=>ownerError+=b);
 const end=Date.now()+5000;while(!fs.existsSync(ready)){assert(Date.now()<end,'owner setup timed out: '+ownerError);await pause(10);}
 fs.cpSync(root,copy,{recursive:true,verbatimSymlinks:true});
 const waiter=spawnSync(process.execPath,['--input-type=module','-e',`
import fs from 'node:fs';import {dirname}from'node:path';import{syncBuiltinESMExports}from'node:module';
import assert from'node:assert/strict';
import{withWorkspaceValidationCapacity,validationCapacityLockPath}from ${JSON.stringify(moduleUrl)};
const root=${JSON.stringify(copy)},queue=validationCapacityLockPath(root),original=fs.mkdirSync;let injected=false,calls=0;
fs.mkdirSync=function(path,...args){
 if(!injected&&dirname(String(path))===queue&&String(path).endsWith('.preparing')){
  injected=true;fs.writeFileSync(${JSON.stringify(trigger)},'ticket publication window');
  const end=Date.now()+5000;while(!fs.existsSync(${JSON.stringify(cleaned)})){if(Date.now()>end)throw Error('owner cleanup timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
 }
 return original.call(this,path,...args);
};syncBuiltinESMExports();
await withWorkspaceValidationCapacity({root,workspaceRoot:root,deadlineAt:Date.now()+8000},()=>{calls++;});
assert(injected,'reclamation interleaving was not exercised');assert.equal(calls,1,'callback runs exactly once');
console.log('COPIED_QUEUE_RECLAIM_RACE_GREEN');
`],{env:fixture.env,encoding:'utf8',timeout:15000});
 assert.equal(waiter.status,0,'COPIED_QUEUE_RECLAIM_RACE: '+waiter.stderr);
 assert.match(waiter.stdout,/COPIED_QUEUE_RECLAIM_RACE_GREEN/);
 console.log('COPIED_QUEUE_RECLAIM_RACE_GREEN: real owner cleanup between copied checkout queue preparation and ticket creation');
} finally {
 if(owner&&owner.exitCode===null){owner.kill('SIGTERM');await new Promise(resolve=>owner.once('exit',resolve));}
 fixture.cleanup();
}
