import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {declaredValidationCapacity} from '../../packages/main/dist/core/validation-execution-lock.js';
import {resolveValidationPlanEntries} from '../../packages/main/dist/core/validation-executor.js';
import {canonicalizeEntries,claimsConflict} from '../../packages/main/dist/core/keyed-scheduler.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const config=JSON.parse(readFileSync(resolve(root,'proof-or-stop.config.json')));
const indexOf = argv => { const matches=config.validate.commands.map((c,i)=>[[c.command,...c.args].join(' '),i]).filter(([key])=>key===argv); assert.equal(matches.length,1,'UNIQUE_COMMAND_REQUIRED: '+argv); return matches[0][1]; };

const commands=config.validate.commands.map((c,i)=>({...c,label:String(i)}));
const done=config.doneRequiredCommands;
for(const [label,list] of [['routine',commands],['DONE',done]]){
 assert.ok(list.every(c=>c.resources?.length),'INCOMPLETE_REAL_CAPACITY_DECLARATIONS: '+label);
 assert.equal(declaredValidationCapacity(list,root).maxConcurrent,2);
}
const entries=canonicalizeEntries(resolveValidationPlanEntries({provider:'real-config',commands}),root);
const writers=["npm --prefix packages/main run build", "node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js", "node packages/main/dist/tasks/command-catalog-smoke.js", "node packages/main/tests/red/red-b49d4-registration-derivation.mjs", "node packages/main/tests/red/red-b49d4-chk002-receipt.mjs", "node packages/main/tests/red/red-1734-lock-liveness.mjs", "node packages/main/tests/red/red-1734-content-binding.mjs", "node packages/main/tests/red/red-1734-reader-race.mjs", "node packages/main/dist/tasks/proofstory-acceptance-rollout-smoke.js --issuer-mutations", "npm --prefix packages/graph run check"].map(indexOf);
for(const index of writers)assert.ok(entries.every((other,i)=>i===index||claimsConflict(entries[index],other)),'WRITER_MUST_CONFLICT_WITH_EVERY_LOCAL_READER: '+index);
assert.ok(!claimsConflict(entries[indexOf("node packages/main/tests/red/red-w2d-entropy-differential.mjs")],entries[indexOf("node packages/main/tests/red/red-w2d-specificity-conjunction.mjs")]),'Independent assertion suites remain parallel');
const fixture=mkdtempSync(resolve(tmpdir(),'capacity-real-config-'));
try {
 const base=resolve(fixture,'base'),left=resolve(fixture,'left'),right=resolve(fixture,'right');mkdirSync(base);
 const git=args=>execFileSync('git',args,{cwd:base,stdio:'pipe'});
 git(['init','-q']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','fixture']);
 git(['worktree','add','-q','-b','left',left]);git(['worktree','add','-q','-b','right',right]);
 const entry=(name,dir)=>canonicalizeEntries([{name,resources:declaredValidationCapacity(commands,dir).resources}],dir)[0];
 const a=entry('a',left),b=entry('b',right);
 assert.ok(!claimsConflict(a,b),'DISJOINT_WORKTREE_ROUTINES_MUST_NOT_HAVE_GLOBAL_WRITER_CONFLICT');
 assert.ok(a.resources.some(x=>x.class==='git-common-dir'&&b.resources.some(y=>x.canonicalKey===y.canonicalKey)),'The private worktrees really share Git metadata');
} finally {rmSync(fixture,{recursive:true,force:true});}
assert.ok(done[1].resources.some(r=>r.class==='fixed-port'&&r.key==='43127'&&r.access==='exclusive'),'Full-suite fixed TCP port stays exclusive');
assert.equal(commands[indexOf("npm --prefix packages/graph run check")].env.GRAPH_VERIFY_PORT,'0','Graph verifier uses an OS-assigned port');
console.log('ALL_REAL_CAPACITY_DECLARATIONS_GREEN');
