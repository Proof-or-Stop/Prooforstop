import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'../..');
const out=process.env.FIVE_ITEM_PROOF_OUTPUT??join(tmpdir(),'full-validation-preconditions-'+Date.now());mkdirSync(out,{recursive:true});
const commands=[['proofstory-acceptance-basis-smoke.js'],['proofstory-acceptance-rollout-smoke.js','--issuer-mutations'],['validation-tier-planner-smoke.js'],['validation-protocol-smoke.js'],['retired-authority-vocabulary-guard-smoke.js']];
const rows=[];
for(const [name,...args] of commands){const p=spawnSync(process.execPath,['packages/main/dist/tasks/'+name,...args],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024,timeout:180000});writeFileSync(join(out,name+'.log'),p.stdout+p.stderr);rows.push({name,exitCode:p.status,signal:p.signal});console.log(name,p.status);}
writeFileSync(join(out,'results.json'),JSON.stringify(rows,null,2)+'\n');console.log('Evidence '+out);
assert.ok(rows.every(r=>r.exitCode===0),'UNPREPARED_FULL_VALIDATION_FIXTURES: unchanged full-suite assertions require complete fixture prerequisites and current reviewed source approvals');
console.log('FULL_VALIDATION_PRECONDITIONS_GREEN');
