import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {declaredValidationCapacity} from '../../packages/main/dist/core/validation-execution-lock.js';
import {resolveValidationPlanEntries} from '../../packages/main/dist/core/validation-executor.js';
import {canonicalizeEntries,claimsConflict} from '../../packages/main/dist/core/keyed-scheduler.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const config=JSON.parse(readFileSync(resolve(root,'proof-or-stop.config.json')));
const commands=config.validate.commands.map((c,i)=>({...c,label:String(i)}));
const done=config.doneRequiredCommands;
for(const [label,list] of [['routine',commands],['DONE',done]]){
 assert.ok(list.every(c=>c.resources?.length),'INCOMPLETE_REAL_CAPACITY_DECLARATIONS: '+label);
 assert.equal(declaredValidationCapacity(list,root).maxConcurrent,2);
}
const entries=canonicalizeEntries(resolveValidationPlanEntries({provider:'real-config',commands}),root);
const writers=[1,3,6,40,79,80,81,82,83,105,125];
for(const index of writers)assert.ok(entries.every((other,i)=>i===index||claimsConflict(entries[index],other)),'WRITER_MUST_CONFLICT_WITH_EVERY_LOCAL_READER: '+index);
assert.ok(!claimsConflict(entries[117],entries[118]),'Independent assertion suites remain parallel');
const a=canonicalizeEntries([{name:'a',resources:declaredValidationCapacity(commands,'/tmp/lab-capacity-a').resources}],'/tmp/lab-capacity-a')[0];
const b=canonicalizeEntries([{name:'b',resources:declaredValidationCapacity(commands,'/tmp/lab-capacity-b').resources}],'/tmp/lab-capacity-b')[0];
assert.ok(!claimsConflict(a,b),'DISJOINT_WORKTREE_ROUTINES_MUST_NOT_HAVE_GLOBAL_WRITER_CONFLICT');
assert.ok(done[1].resources.some(r=>r.class==='fixed-port'&&r.key==='43127'&&r.access==='exclusive'),'Full-suite fixed TCP port stays exclusive');
assert.equal(commands[125].env.GRAPH_VERIFY_PORT,'0','Graph verifier uses an OS-assigned port');
console.log('ALL_REAL_CAPACITY_DECLARATIONS_GREEN');
