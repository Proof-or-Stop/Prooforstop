#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const cases=[
  ['epoch-lineage','packages/main/tests/review-finalize-managed-lineage.test.mjs','REVIEW_FINALIZE_MANAGED_LINEAGE_GREEN'],
  ['identity-binding','scripts/verify-review-inventory-identity.mjs','REVIEW_REWORK_IDENTITY_BINDING PASS'],
];
const failures=[];
for(const [name,path,marker] of cases){
  const result=spawnSync(process.execPath,[path],{cwd:process.cwd(),encoding:'utf8',timeout:60_000});
  const output=`${result.stdout??''}\n${result.stderr??''}`;
  if(result.error||result.signal||result.status!==0||!output.includes(marker)){
    failures.push(name);
    process.stderr.write(`${name}: ${output.slice(-2500)}\n`);
  }
}
assert.deepEqual(failures,[],'REVIEW_CERTIFICATION_REGRESSIONS_RED: '+failures.join(','));
console.log('REVIEW_CERTIFICATION_REGRESSIONS_GREEN');
