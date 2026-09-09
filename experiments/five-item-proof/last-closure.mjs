import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const failures=[];
for(const name of ['capacity-claim-dedup.mjs','final-review-regressions.mjs']){
 const result=spawnSync(process.execPath,[fileURLToPath(new URL(name,import.meta.url))],{encoding:'utf8',timeout:45000});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');if(result.status!==0)failures.push({name,status:result.status});
}
assert.deepEqual(failures,[],'LAST_CLOSURE_REGRESSION_TARGET');console.log('LAST_CLOSURE_REGRESSIONS_GREEN');
