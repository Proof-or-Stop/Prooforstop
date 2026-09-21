import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { modularIdentityChildClosure } from '../../../scripts/identity-modular-child-closure.mjs';
import { CANONICAL } from '../../../scripts/identity-child-closure.mjs';
import { modularRegistrations, dispatcher, dispatcherSource } from './identity-modular-dispatch-fixture.mjs';
const registrations = modularRegistrations();
const matrix = registrations.filter(row => row.name === 'CHK-007:adversarial:0 every registered identity boundary rejects through its public operation with zero mutation');
assert.equal(matrix.length, 1, 'archive must retain one discoverable campaign');
const contract = JSON.parse(readFileSync(new URL('../../../scripts/identity-child-contract.json', import.meta.url), 'utf8'));
const groups = [null, 'identity-cutover', 'identity-config-boundary', 'identity-policy-boundary', 'f050', 'round24', 'identity-migration-archive'];
async function selections(source, compareClosure) {
  const results=[];
  for(const selectedGroup of groups){let executions=0;const context=dispatcher(selectedGroup,{},source);await context.check(matrix[0].groups,matrix[0].name,async()=>{executions++;});results.push({group:selectedGroup??'default-all',executions});
    if(compareClosure){const row=matrix[0],file=row.file.slice(process.cwd().length+1);const closure=modularIdentityChildClosure({ts,file,text:row.text,ast:row.ast,entry:CANONICAL,argv:selectedGroup===null?[]:['--group='+selectedGroup],contract,root:process.cwd()});assert.deepEqual(closure.errors,[]);let skipped=false;for(let node=row.callback;node;node=node.parent)skipped ||= closure.shouldSkip(node);assert.equal(skipped,executions===0,'static traversal must match actual runtime selection: '+selectedGroup);}
  }
  return results;
}
function assertRetired(rows){assert.ok(rows.slice(0,-1).every(row=>row.executions===0),'RETIRED_MATRIX_STILL_ROUTINE: archived campaign must not run routinely');assert.equal(rows.at(-1).executions,1);}
const source=dispatcherSource(), actual=await selections(source,true);assertRetired(actual);
const guard="  if (groups.includes('identity-migration-archive') && !selectedGroups?.includes('identity-migration-archive')) return;";
assert.ok(source.includes(guard));const mutated=await selections(source.replace(guard,''),false);assert.throws(()=>assertRetired(mutated),/RETIRED_MATRIX_STILL_ROUTINE/);
assert.ok(registrations.find(row=>row.name==='CHK-007 canonical controls: every distinct registered public operation succeeds before mutation')?.groups.includes('identity-canonical'));
assert.ok(registrations.find(row=>row.name==='normal consumer controls and invalid project configuration retain zero-mutation checks')?.groups.includes('identity-consumer-smoke'));
console.log('MIGRATION_MATRIX_SELECTION '+JSON.stringify(actual));
console.log('IDENTITY_RETIREMENT_SELECTION_GREEN: routine zero; explicit archive one; removed guard rejected; normal controls retained');
