import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ACTIVE_IDENTITY_OPERATION_BOUNDARIES as boundaries,assertCanonicalActiveIdentityBoundary as check} from '../../packages/main/dist/core/runtime-environment-checks.js';

const root=resolve(import.meta.dirname,'../..');
const expected=[
  ['review-incremental-context','packages/main/src/core/evidence-freshness.ts','proof-or-stop.verifier-dependency-manifest.v1'],
  ['review-incremental-context','packages/main/src/core/evidence-freshness.ts','proof-or-stop.verifier-dependency-manifest-binding.v1'],
  ['review-inventory-epoch','packages/main/src/core/review-inventory-epoch.ts','proof-or-stop.inventory-verification-observation.v1'],
  ['review-inventory-epoch','packages/main/src/core/review-inventory-epoch.ts','proof-or-stop.verification-receipt-bundle.v5'],
];
const fixture=mkdtempSync(join(tmpdir(),'pos-current-schema-'));
const pkg=join(fixture,'packages/main');mkdirSync(pkg,{recursive:true});
const rows=[];
try{
  cpSync(join(root,'packages/main/dist'),join(pkg,'dist'),{recursive:true});
  cpSync(join(root,'packages/main/templates'),join(pkg,'templates'),{recursive:true});
  cpSync(join(root,'proof-or-stop.config.json'),join(fixture,'proof-or-stop.config.json'));
  for(const [boundaryId,path,canonical] of expected){
    const boundary=boundaries.find(b=>b.id===boundaryId);
    assert.ok(boundary,'CURRENT_SCHEMA_BOUNDARY_MISSING '+boundaryId);
    const sites=boundary.identitySites.filter(s=>s.sourcePath===path&&s.canonical===canonical);
    assert.equal(sites.length,1,'CURRENT_SCHEMA_SITE_MISSING '+canonical);
    assert.equal(boundary.retiredIdentityCases.filter(c=>c.siteId===sites[0].siteId).length,1,'CURRENT_SCHEMA_MUTATION_CASE_MISSING '+canonical);
    const input={boundaryId,projectRoot:fixture,runtimePackageRoot:pkg};
    check(input);
    const file=join(pkg,path.replace('packages/main/src/','dist/').replace(/\.ts$/,'.js'));
    const original=readFileSync(file,'utf8');
    for(const [label,replacement] of [['missing',''],['unsupported-version',canonical.replace(/v\d+$/,'v999')],['retired-family',sites[0].retiredNeedle]]){
      writeFileSync(file,original.replaceAll(canonical,replacement));
      assert.throws(()=>check(input),/consumer rejected active identity bytes/,canonical+' '+label);
      rows.push({canonical,negative:label,refused:true});
    }
    writeFileSync(file,original);check(input);
  }
  const configBoundary=boundaries.find(b=>b.identitySites.some(s=>s.sourcePath==='proof-or-stop.config.json'&&s.canonical==='proof-or-stop.config.json'));
  const site=configBoundary.identitySites.find(s=>s.sourcePath==='proof-or-stop.config.json'&&s.canonical==='proof-or-stop.config.json');
  assert.deepEqual(site.sourceOccurrences,{canonical:12,retired:0},'EXACT_CONFIG_BINDING_REMOVED_OR_WIDENED');
  // Use the actual root configuration, modifying only a private fixture copy.
  const file=join(fixture,'proof-or-stop.config.json'),original=readFileSync(file,'utf8');
  const input={boundaryId:configBoundary.id,projectRoot:fixture,runtimePackageRoot:pkg};
  for(const [label,value] of [
    ['eleven',original.replace('"proof-or-stop.config.json"','"unrelated-config.json"')],
    ['thirteen',original.replace('{','{"extraReference":"proof-or-stop.config.json",')],
    ['retired',original.replace('{','{"extraReference":"proofbound.config.json",')],
  ]){
    writeFileSync(file,value);assert.throws(()=>check(input),/consumer rejected active identity bytes/,label);rows.push({configCountMutation:label,refused:true});
  }
  writeFileSync(file,original);check(input);
  console.log('CURRENT_SCHEMA_CONTROLS_GREEN '+JSON.stringify({schemas:expected.length,negativeControls:rows}));
}finally{rmSync(fixture,{recursive:true,force:true});}
