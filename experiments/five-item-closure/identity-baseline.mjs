import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {identityCutoverReviewedContexts} from '../../scripts/verify-proof-or-stop-identity-cutover.mjs';

const root=resolve(import.meta.dirname,'../..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const reviewed=identityCutoverReviewedContexts();
const issues=[];
// Compare the production scanner's declarations to actual bytes. Preserve each
// existing exact token/count and independently recompute its context witness.
for(const row of reviewed.rows){
  const text=readFileSync(resolve(root,row.path),'utf8');
  const count=text.split(row.token).length-1;
  const context=digest(text.split(/\r?\n/).filter(line=>line.includes(row.token)).join('\n'));
  if(count!==row.expectedOccurrences||context!==row.contextSha256)
    issues.push({kind:'context',id:row.id,path:row.path,count,expectedCount:row.expectedOccurrences});
}
for(const row of reviewed.witnesses){
  if(digest(readFileSync(resolve(root,row.path)))!==row.sha256)
    issues.push({kind:'witness',path:row.path});
}
console.log(JSON.stringify({rows:reviewed.rows.length,witnesses:reviewed.witnesses.length,issues}));
assert.deepEqual(issues,[],'CURRENT_IDENTITY_CONTEXT_INVALID: current exact denial witnesses reject the unchanged configured workload');
console.log('CURRENT_IDENTITY_CONTEXT_GREEN');
for(const file of ['current-schema-controls.mjs','schema-value-controls.mjs','child-environment-controls.mjs','maintenance-boundaries.mjs','historical-fixture-controls.mjs'])
  await import(new URL(file,import.meta.url));
for(const args of [['scripts/verify-proof-or-stop-identity-cutover.mjs','--self-test'],['experiments/five-item-integration/verify.mjs']]){
  const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  assert.equal(result.status,0,'CURRENT_CLOSURE_REGRESSION_FAILED '+args[0]);
}
console.log('CURRENT_MISSING_CLOSURE_TARGETS_GREEN');
