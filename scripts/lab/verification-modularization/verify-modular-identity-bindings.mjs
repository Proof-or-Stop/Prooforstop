import assert from 'node:assert/strict';
import fs from 'node:fs';
import './../../../scripts/identity-cutover/bootstrap.mjs';
import {verifyReviewedContextReaders,verifyBothFamilyContexts,verifyReviewedNegativeSourceIntegrity} from '../../identity-cutover/source-integrity.mjs';
import {verifyCurrentLegacyContextManifest} from '../../identity-cutover/guidance.mjs';
import {EXACT_ALLOWLIST} from '../../identity-cutover/base-contexts.mjs';
import {validateExactRows,trackedFiles} from '../../identity-cutover/repository.mjs';
const root=process.cwd();
const errors=[...verifyReviewedContextReaders(root),...verifyBothFamilyContexts(root),...verifyReviewedNegativeSourceIntegrity(root),...verifyCurrentLegacyContextManifest(root),...validateExactRows(EXACT_ALLOWLIST,new Set(trackedFiles(root)),root)];
assert.deepEqual(errors,[],'MODULAR_IDENTITY_BINDINGS_STALE: preserve exact contexts and complete witness coverage across extracted modules');
console.log('MODULAR_IDENTITY_BINDINGS_GREEN '+JSON.stringify({exactContexts:EXACT_ALLOWLIST.length}));
const {MODULAR_WITNESS_CLOSURES,REVIEWED_NEGATIVE_SOURCE_INTEGRITY}=await import('../../identity-cutover/reviewed-contexts.mjs');
const ledger=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/identity-context-migration.json','utf8'));
assert.equal(ledger.rows.length,36);assert.equal(EXACT_ALLOWLIST.length,699);
assert.deepEqual(MODULAR_WITNESS_CLOSURES,ledger.sourceClosures);
for(const row of ledger.rows){
 assert.equal(row.delta,0);assert.equal(row.destinations.length,1);
 const actual=EXACT_ALLOWLIST.find(candidate=>candidate.id===row.before.id),destination=row.destinations[0];
 const expected={...row.before,path:destination.path,contextSha256:destination.contextSha256};
 if(expected.sourceSha256){const {createHash}=await import('node:crypto');expected.sourceSha256=createHash('sha256').update(fs.readFileSync(destination.path)).digest('hex');}
 assert.deepEqual(actual,expected,'only path, bounded context digest and source witness may change');
}
const cache=new Map(REVIEWED_NEGATIVE_SOURCE_INTEGRITY.map(row=>[row.path,fs.readFileSync(row.path,'utf8')]));
let mutations=0;
for(const [entry,paths]of Object.entries(MODULAR_WITNESS_CLOSURES)){
 assert.equal(paths[0],entry);assert.equal(new Set(paths).size,paths.length);
 const folder=paths[1].slice(0,paths[1].lastIndexOf('/'));
 assert.deepEqual(paths.slice(1),fs.readdirSync(folder).filter(name=>/\.(?:mjs|ts)$/.test(name)).sort().map(name=>folder+'/'+name),'no extracted module omitted from full source witness');
 for(const path of paths){
  assert.ok(cache.has(path));
  const rejected=verifyReviewedNegativeSourceIntegrity(root,name=>cache.get(name)+(name===path?'\n// changed verification behavior\n':''));
  assert.ok(rejected.includes('reviewed negative source integrity changed: '+path),path+' mutation must be detected');mutations++;
 }
}
console.log('MODULAR_IDENTITY_WITNESSES_GREEN '+JSON.stringify({families:Object.keys(MODULAR_WITNESS_CLOSURES).length,sourceWitnesses:cache.size,sourceMutationControls:mutations}));
