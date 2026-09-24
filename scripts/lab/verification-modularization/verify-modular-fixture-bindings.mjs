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
const currentMerge=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/main-438-witness-migration.json'));
const restoredEntries=[...inventory.entries];
const repairBindings=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/finish-repair-source-bindings.json'));
for(const change of repairBindings.changes.filter(row=>row.kind==='fixture')) {
 const index=restoredEntries.findIndex(row=>JSON.stringify(row)===JSON.stringify(change.after));
 assert.ok(index>=0,'current repaired fixture binding missing');
 for(const key of Object.keys(change.before).filter(key=>!['lineNumber','sourceSha256'].includes(key)))assert.deepEqual(change.after[key],change.before[key],'fixture literal and classification must remain unchanged');
 restoredEntries[index]=change.before;
}

assert.equal(currentMerge.added.length,1);
for(const row of currentMerge.added){const index=restoredEntries.findIndex(candidate=>JSON.stringify(candidate)===JSON.stringify(row));assert.ok(index>=0);const mainText=execFileSync('git',['show',currentMerge.main+':'+row.path],{encoding:'utf8'});assert.equal(sha(mainText),row.sourceSha256);assert.equal(sha(mainText.split(/\r?\n/)[row.lineNumber-1]),row.lineSha256);assert.ok(row.evidence.includes('env -u '+row.token));restoredEntries.splice(index,1);}
for(const delta of currentMerge.deltas.filter(row=>row.kind==='fixture')) { const index=restoredEntries.findIndex(row=>JSON.stringify(row)===JSON.stringify(delta.after));assert.ok(index>=0);assert.equal(delta.before.lineSha256,delta.after.lineSha256);restoredEntries[index]=delta.before; }
for(const row of currentMerge.retired){const {priorLine,...before}=row;assert.equal(sha(priorLine),row.lineSha256);const mainText=execFileSync('git',['show',currentMerge.main+':'+row.path],{encoding:'utf8'});assert.ok(!mainText.split(/\r?\n/).includes(priorLine));assert.equal(fs.readFileSync(row.path,'utf8'),mainText);const originalIndex=originalInventory.entries.findIndex(candidate=>JSON.stringify(candidate)===JSON.stringify(before));assert.ok(originalIndex>=0);restoredEntries.splice(originalIndex,0,before);}
assert.equal(currentMerge.retired.length,3);
assert.equal(migration.rows.length,82);assert.equal(restoredEntries.length,originalInventory.entries.length);
const changed=new Set();
for(const row of migration.rows){
 assert.ok(!changed.has(row.index));changed.add(row.index);
 assert.deepEqual(originalInventory.entries[row.index],row.before);
 assert.deepEqual(restoredEntries[row.index],row.after);
 for(const key of ['token','classification','reason','evidence'])assert.equal(row.after[key],row.before[key]);
 const old=execFileSync('git',['show',row.baseline+':'+row.before.path],{encoding:'utf8'}).split(/\r?\n/);
 const currentBinding=inventory.entries.find(candidate=>candidate.path===row.after.path&&candidate.token===row.after.token&&candidate.lineSha256===row.after.lineSha256);
 assert.ok(currentBinding,'reviewed relocation literal must still exist in current inventory');
 const current=fs.readFileSync(row.after.path,'utf8').split(/\r?\n/)[currentBinding.lineNumber-1];
 assert.ok(row.originalLineCandidates.some(n=>sha(old[n-1])===row.before.lineSha256&&old[n-1].trim()===current.trim().replaceAll('context.','').replace('root: root,','root,')),'same reviewed negative line after explicit lexical context relocation');
}
const mainMigration=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/main-436-witness-migration.json'));
for(let i=0;i<restoredEntries.length;i++)if(!changed.has(i)){
 const before=originalInventory.entries[i];
 const moved=mainMigration.unchangedLiteralRows.find(row=>JSON.stringify(row.before)===JSON.stringify(before));
 if(moved){assert.equal(moved.before.lineSha256,moved.after.lineSha256);assert.equal(moved.before.token,moved.after.token);assert.deepEqual(restoredEntries[i],moved.after);}
 else assert.deepEqual(restoredEntries[i],before);
}
console.log(`MODULAR_FIXTURE_MIGRATION_GREEN: ${changed.size} exact relocations; classifications retained; ${restoredEntries.length - changed.size} other entries retain their reviewed literal and classification; exact main merge relocations recorded`);
