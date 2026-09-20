import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { withWorkspaceValidationCapacity, validationCapacityLockPath } from '../dist/core/validation-execution-lock.js';
import { createFixtureMachineEnvironment } from '../dist/tasks/helpers/fixture-machine-environment.js';

// The runtime verifier imports this module. Do not exit its process after the
// child completes: subsequent runtime assertions must still execute.
if (!process.argv.includes('--private-coordination-residue')) {
  const fixture = createFixtureMachineEnvironment();
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--private-coordination-residue'], {
    env: fixture.env, stdio: 'inherit', timeout: 30000,
  });
  assert.equal(result.error, undefined, 'residue fixture must execute');
  assert.equal(result.signal, null, 'residue fixture must close normally');
  assert.equal(result.status, 0, 'residue fixture must pass before namespace cleanup');
  fixture.cleanup();
  assert.equal(existsSync(fixture.root), false, 'all ten residue cases must release their private external namespace');
} else {
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
await once(child, 'spawn');
const deadPid = child.pid;
const closed = once(child, 'close');child.kill('SIGKILL');await closed;
for (const suffix of ['preparing', 'quarantine']) {
  for (const owner of ['dead', 'live', 'unknown', 'invalid', 'out-of-range']) {
    const root=mkdtempSync(join(tmpdir(),'validation-migration-residue-'));
    const legacy=validationCapacityLockPath(root), residue=join(legacy,`retained.${suffix}`);
    mkdirSync(residue,{recursive:true});
    const holder=owner==='unknown'?null:{pid:owner==='dead'?deadPid:owner==='invalid'?0:owner==='out-of-range'?2**40:process.pid,hostname:hostname()};
    if(holder) writeFileSync(join(residue,'holder.json'),JSON.stringify({...holder,lockId:'migration-regression',command:'fixture',acquiredAt:new Date().toISOString(),...(owner==='live'?{processStartTimeMs:0}:{})}));
    // A separate live process avoids claiming the current process with a false start identity.
    let live;
    if(owner==='live') {live=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(live,'spawn');writeFileSync(join(residue,'holder.json'),JSON.stringify({...holder,pid:live.pid,lockId:'migration-regression',command:'fixture',acquiredAt:new Date().toISOString()}));}
    let entered=false,target;
    try {
      const invoke=()=>withWorkspaceValidationCapacity({root,workspaceRoot:root,command:'migration-regression',deadlineAt:Date.now()+300},()=>{entered=true;});
      if(owner==='dead') {
        await assert.doesNotReject(invoke,`DEAD_COORDINATION_RESIDUE_BLOCKS_MIGRATION: ${suffix}`);
        assert.equal(entered,true);assert.equal(existsSync(residue),false);target=realpathSync(legacy);
      } else {
        await assert.rejects(invoke,error=>{assert.match(String(error),/WORKSPACE_COORDINATION_MIGRATION_BLOCKED/);assert.ok(String(error).includes(legacy));assert.ok(String(error).includes(`retained.${suffix}`));return true;},'MALFORMED_COORDINATION_OWNER_MUST_NOT_BE_RECLAIMED: '+owner);
        assert.equal(entered,false);assert.equal(existsSync(residue),true,'unproven ownership must survive');
      }
    } finally {if(live){const done=once(live,'close');live.kill();await done;}rmSync(root,{recursive:true,force:true});if(target)rmSync(target,{recursive:true,force:true});}
  }
}
console.log('COORDINATION_RESIDUE_GREEN: dead preparation/quarantine reclaimed; live and unknown owners preserved with named migration diagnostic');
}
