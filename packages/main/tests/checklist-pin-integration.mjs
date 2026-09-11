import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {assertCanonicalActiveIdentityBoundary} from '../dist/core/runtime-environment-checks.js';
const root=mkdtempSync(join(tmpdir(),'pos-checklist-pin-'));
try {
 cpSync(resolve('packages/main/dist'),join(root,'dist'),{recursive:true});
 const check=()=>assertCanonicalActiveIdentityBoundary({boundaryId:'review-inventory-epoch',runtimePackageRoot:root});
 check();
 const path=join(root,'dist/handlers/checklist.js');const before=readFileSync(path,'utf8');
 const guard='if (!intent.scope || !intent.expectation || !intent.requirementSource)';
 assert.equal(before.split(guard).length-1,1,'exactly one incoming metadata guard');
 writeFileSync(path,before.replace(guard,'if (false)'));
 assert.throws(check,/handlers\/checklist.ts consumer rejected active identity bytes/,'Removing incoming classification guard must invalidate reviewed pin');
 writeFileSync(path,before);check();
 console.log('CHECKLIST_PIN_INTEGRATION_GREEN reviewed-guard-present removal-rejected restored-control');
}finally {rmSync(root,{recursive:true,force:true});}
