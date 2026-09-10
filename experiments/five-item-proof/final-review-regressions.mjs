import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const failures=[];
for(const name of ['batch-retry-selector.mjs','resource-audit-contract.mjs']){
 const result=spawnSync(process.execPath,[fileURLToPath(new URL(name,import.meta.url))],{encoding:'utf8',timeout:30000});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');if(result.status!==0)failures.push({name,status:result.status});
}
assert.deepEqual(failures,[],'FINAL_REVIEW_REGRESSION_TARGET');console.log('FINAL_REVIEW_REGRESSIONS_GREEN');
