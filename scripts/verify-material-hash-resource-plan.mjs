import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const repo=resolve(process.argv[2]||process.cwd());
const {canonicalizeEntries}=await import(join(repo,'packages/main/dist/core/keyed-scheduler.js'));
const {runValidationCommand}=await import(join(repo,'packages/main/dist/core/validation-executor.js'));
const {configuredValidationCommands}=await import(join(repo,'packages/main/dist/handlers/verifier.js'));
const actual=configuredValidationCommands(repo).find(c=>c.args.includes('packages/main/dist/tasks/material-hash-large-tree-smoke.js'));
assert.ok(actual,'actual configured large-tree entry exists');
const candidate=[{class:'git-common-dir',key:'.',access:'shared'},{class:'machine-cpu',key:'heavy',access:'exclusive'}];
// Consume actual configured claims; never substitute proposed claims for the target.
const resources=actual.resources;
assert.ok(resources?.length,'MATERIAL_LARGE_TREE_MUST_NOT_USE_UNKNOWN_EXCLUSIVE');
canonicalizeEntries([{name:'large-tree',resources}],repo);
assert.ok(resources.some(c=>c.class==='machine-cpu'&&c.key==='heavy'&&c.access==='exclusive'));
assert.ok(resources.some(c=>c.class==='git-common-dir'&&c.access==='shared'));
const base=mkdtempSync(join(tmpdir(),'large-tree-resources-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f){const end=Date.now()+10000;while(!f()){assert.ok(Date.now()<end,'marker timeout');await sleep(20);}}
const roots=['a','b','c'].map(n=>join(base,n));
for(const root of roots){mkdirSync(root);execFileSync('git',['init','-q',root]);}
const leaf=join(base,'leaf.cjs');
writeFileSync(leaf,`const fs=require('fs');const [marker,release]=process.argv.slice(2);fs.writeFileSync(marker,'started');if(release){const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);process.exit(0)}},20);setTimeout(()=>process.exit(9),15000).unref();}`);
const release=join(base,'release'),heavyMarker=join(base,'heavy'),lightMarker=join(base,'light'),otherHeavyMarker=join(base,'other-heavy');
const command=(marker,claims,held=false)=>({command:process.execPath,args:[leaf,marker,...(held?[release]:[])],resources:claims,timeoutMs:20000});
let holder;
try {
 holder=runValidationCommand(command(heavyMarker,resources,true),roots[0]);
 await until(()=>existsSync(heavyMarker));
 const light=await runValidationCommand(command(lightMarker,[{class:'git-common-dir',key:'.',access:'shared'}]),roots[1]);
 assert.equal(light.code,0,light.output);assert.ok(existsSync(lightMarker));assert.ok(!existsSync(release),'light ran while heavy held');
 const blocked=await runValidationCommand(command(otherHeavyMarker,candidate),roots[2],20000,{deadlineAt:Date.now()+250});
 assert.equal(blocked.code,124);assert.ok(!existsSync(otherHeavyMarker),'competing heavy never spawned');
 writeFileSync(release,'release');assert.equal((await holder).code,0);holder=null;
 const after=await runValidationCommand(command(otherHeavyMarker,candidate),roots[2]);assert.equal(after.code,0);assert.ok(existsSync(otherHeavyMarker));
 console.log('PASS actual configured resource classification; light concurrent with heavy; heavy deadline zero spawn; reacquire after release');
} finally {writeFileSync(release,'release');if(holder)await holder;rmSync(base,{recursive:true,force:true});}
const original=await runValidationCommand(actual,repo);
assert.equal(original.code,0,original.output);
assert.match(original.output,/material-hash-large-tree smoke passed/);
console.log('MATERIAL_LARGE_TREE_REAL_SCHEDULER_AND_ORIGINAL_SMOKE_PASS');
