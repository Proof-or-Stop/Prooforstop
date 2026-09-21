import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateReviewedFixtureSources,reviewedFixtureResidueAllowed} from '../../identity-reviewed-fixture-contexts.mjs';
const errors=validateReviewedFixtureSources(path=>fs.readFileSync(path,'utf8'));
assert.deepEqual(errors,[],'MODULAR_FIXTURE_BINDINGS_STALE: every reviewed fixture must bind its actual source');
const inventory=JSON.parse(fs.readFileSync('scripts/identity-reviewed-fixture-data.json','utf8'));
let controls=0;
for(const row of inventory.entries){
 const text=fs.readFileSync(row.path,'utf8'),line=text.split(/\r?\n/)[row.lineNumber-1];
 const input={path:row.path,token:row.token,lineNumber:row.lineNumber,line,text};
 assert.equal(reviewedFixtureResidueAllowed(input),true);
 for(const change of [{path:'unregistered/'+row.path},{lineNumber:row.lineNumber+1},{text:text+'\n// altered witness\n'},{line:line+' '}]){
  assert.equal(reviewedFixtureResidueAllowed({...input,...change}),false,'path, line, source and line content remain bound');controls++;
 }
}
console.log('MODULAR_FIXTURE_BINDINGS_GREEN '+JSON.stringify({entries:inventory.entries.length,negativeControls:controls}));
