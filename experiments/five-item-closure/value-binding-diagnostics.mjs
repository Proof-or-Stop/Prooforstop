import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {ACTIVE_IDENTITY_OPERATION_BOUNDARIES:boundaries,assertCanonicalActiveIdentityBoundary:check}=await import(join(root,'packages/main/dist/core/runtime-environment-checks.js'));
const expected=[
 'packages/main/src/core/evidence-freshness.ts#proof-or-stop.verifier-dependency-manifest.v1',
 'packages/main/src/core/evidence-freshness.ts#proof-or-stop.verifier-dependency-manifest-binding.v1',
 'packages/main/src/core/review-inventory-epoch.ts#proof-or-stop.inventory-verification-observation.v1',
 'packages/main/src/core/review-inventory-epoch.ts#proof-or-stop.verification-receipt-bundle.v5',
 'packages/main/src/core/verification-execution-evidence.ts#proof-or-stop.verification-receipt-bundle.v5',
];
assert.deepEqual(boundaries.flatMap(b=>b.identitySites.filter(s=>s.valueBinding).map(s=>s.siteId)).sort(),expected.sort(),'the independently reviewed value-binding inventory must remain complete');
const fixture=mkdtempSync(join(tmpdir(),'lab-value-diagnostic-')),pkg=join(fixture,'packages/main');
mkdirSync(pkg,{recursive:true});
cpSync(join(root,'packages/main/dist'),join(pkg,'dist'),{recursive:true});
cpSync(join(root,'packages/main/templates'),join(pkg,'templates'),{recursive:true});
cpSync(join(root,'packages/main/package.json'),join(pkg,'package.json'));
cpSync(join(root,'package.json'),join(fixture,'package.json'));
symlinkSync(join(root,'node_modules'),join(fixture,'node_modules'),'dir');
const rows=[];
const publicHandler=(boundary)=>{
 const incremental=boundary==='review-incremental-context';
 const name=incremental?'createReviewIncrementalContextHandlers':'createCertificationWindowHandlers';
 const command=incremental?'review_incremental_context':'certification_window_status';
 const module=join(pkg,'dist/handlers',incremental?'review-incremental-context.js':'certification-window.js');
 const script=`import {${name}} from ${JSON.stringify(module)};try{${name}({})[${JSON.stringify(command)}]({storyId:'',role:''});console.log(JSON.stringify({accepted:true}));}catch(error){console.log(JSON.stringify({message:error.message}));}`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:fixture,encoding:'utf8',timeout:60000});
 assert.equal(result.status,0,result.stderr);
 return {message:JSON.parse(result.stdout).message,canonicalInputError:command+': storyId is required'};
};
try{
 for(const boundary of boundaries)for(const site of boundary.identitySites.filter(s=>s.valueBinding)){
  const path=join(pkg,boundary.paths.find(p=>p.sourcePath===site.sourcePath).path),original=readFileSync(path,'utf8');
  const input={boundaryId:boundary.id,runtimePackageRoot:pkg,projectRoot:fixture};
  check(input);const canonical=publicHandler(boundary.id);assert.equal(canonical.message,canonical.canonicalInputError,'canonical handler must reach ordinary input validation');
  for(const observed of [site.retired,'proof-or-stop.diagnostic-control.v999']){
   const changed=original.split(site.canonical).join(observed);assert.notEqual(changed,original);
   writeFileSync(path,changed);
   try{
    let message='';try{check(input)}catch(error){message=error.message}
    const handler=publicHandler(boundary.id);
    rows.push({boundary:boundary.id,site:site.siteId,canonical:site.canonical,observed,message,handlerMessage:handler.message,
     refused:!!message&&handler.message!==handler.canonicalInputError,
     boundaryDiagnosticComplete:message.includes(site.siteId)&&message.includes(site.canonical)&&message.includes(observed),
     handlerDiagnosticComplete:!!handler.message&&handler.message.includes(site.siteId)&&handler.message.includes(site.canonical)&&handler.message.includes(observed)});
   }finally{writeFileSync(path,original)}
   check(input);
  }
 }
}finally{rmSync(fixture,{recursive:true,force:true})}
console.log(JSON.stringify(rows,null,2));
assert.ok(rows.every(r=>r.refused),'all invalid bindings must refuse');
assert.ok(rows.every(r=>r.boundaryDiagnosticComplete&&r.handlerDiagnosticComplete),'VALUE_BINDING_DIAGNOSTIC_INCOMPLETE');
console.log('VALUE_BINDING_DIAGNOSTICS_GREEN '+rows.length+' boundary and production-handler controls');
