import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createFixtureMachineEnvironment} from '../dist/tasks/helpers/fixture-machine-environment.js';
const fixture=createFixtureMachineEnvironment();
const root=mkdtempSync(join(fixture.root,'disposable-'));
const moduleUrl=new URL('../dist/core/validation-execution-lock.js',import.meta.url).href;
try {
 const result=spawnSync(process.execPath,['--input-type=module','-e',`
import {withWorkspaceValidationCapacity,validationCapacityLockPath,cleanupAbandonedWorkspaceValidationCoordination} from ${JSON.stringify(moduleUrl)};
import {rmSync,realpathSync,mkdirSync,writeFileSync,existsSync,renameSync,readdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
const root=${JSON.stringify(root)};
await withWorkspaceValidationCapacity({root,workspaceRoot:root,deadlineAt:Date.now()+5000},()=>{});
const target=realpathSync(validationCapacityLockPath(root));
const moved=root+'-moved';renameSync(root,moved);
cleanupAbandonedWorkspaceValidationCoordination();
assert.equal(existsSync(target),false,'empty old-root queue is reclaimable');
await withWorkspaceValidationCapacity({root:moved,workspaceRoot:moved,deadlineAt:Date.now()+5000},()=>{});
assert.equal(realpathSync(validationCapacityLockPath(moved)),target,'move must restore the exact stable owned queue');
assert.deepEqual(readdirSync(dirname(target)).filter(name=>/^[a-f0-9]{64}$/.test(name)),[target.split('/').at(-1)],'COPIED_QUEUE_UNUSED_DIRECTORY: a moved checkout must not allocate an unused second queue');
console.log('QUEUE_TARGET '+target);
rmSync(moved,{recursive:true,force:true});
for(const suffix of ['live.ticket','unknown.preparing']) {
 const marker=join(target,suffix);mkdirSync(marker);writeFileSync(join(marker,'holder.json'),JSON.stringify({pid:process.pid,opaque:suffix}));
 cleanupAbandonedWorkspaceValidationCoordination();assert.equal(existsSync(marker),true,'cleanup must preserve all nonempty ownership state');
 rmSync(marker,{recursive:true});
}

`],{env:fixture.env,encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.signal,null);
 const target=result.stdout.split('\n').find(s=>s.startsWith('QUEUE_TARGET '))?.slice(13);assert.ok(target);
 assert.equal(existsSync(target),false,'DISPOSABLE_COORDINATION_QUEUE_LEAK');
 const namespace=join(fixture.home,'.proof-or-stop/locks/workspace-validation-coordination');
 assert.deepEqual(existsSync(namespace)?readdirSync(namespace):[],[],'DISPOSABLE_COORDINATION_FENCE_LEAK');
 console.log('DISPOSABLE_COORDINATION_CLEANUP_GREEN');
}finally{fixture.cleanup();}
