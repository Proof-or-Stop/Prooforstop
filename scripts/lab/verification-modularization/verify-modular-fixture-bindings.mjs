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
const {execFileSync}=await import('node:child_process');
const {createHash}=await import('node:crypto');
const sha=text=>createHash('sha256').update(text).digest('hex');
const migration=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/fixture-binding-migration.json','utf8'));
const originalInventory=JSON.parse(execFileSync('git',['show','fcdd5514a5:scripts/identity-reviewed-fixture-data.json'],{encoding:'utf8'}));
assert.equal(migration.rows.length,82);assert.equal(inventory.entries.length,originalInventory.entries.length);
const changed=new Set();
for(const row of migration.rows){
 assert.ok(!changed.has(row.index));changed.add(row.index);
 assert.deepEqual(originalInventory.entries[row.index],row.before);
 assert.deepEqual(inventory.entries[row.index],row.after);
 for(const key of ['token','classification','reason','evidence'])assert.equal(row.after[key],row.before[key]);
 const old=execFileSync('git',['show',row.baseline+':'+row.before.path],{encoding:'utf8'}).split(/\r?\n/);
 const current=fs.readFileSync(row.after.path,'utf8').split(/\r?\n/)[row.after.lineNumber-1];
 assert.ok(row.originalLineCandidates.some(n=>sha(old[n-1])===row.before.lineSha256&&old[n-1].trim()===current.trim().replaceAll('context.','').replace('root: root,','root,')),'same reviewed negative line after explicit lexical context relocation');
}
const mainMigration=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/main-436-witness-migration.json'));
for(let i=0;i<inventory.entries.length;i++)if(!changed.has(i)){
 const before=originalInventory.entries[i];
 const moved=mainMigration.unchangedLiteralRows.find(row=>JSON.stringify(row.before)===JSON.stringify(before));
 if(moved){assert.equal(moved.before.lineSha256,moved.after.lineSha256);assert.equal(moved.before.token,moved.after.token);assert.deepEqual(inventory.entries[i],moved.after);}
 else assert.deepEqual(inventory.entries[i],before);
}
console.log('MODULAR_FIXTURE_MIGRATION_GREEN: 82 exact relocations; classifications retained; 219 other entries retain their reviewed literal and classification; exact main merge relocations recorded');
