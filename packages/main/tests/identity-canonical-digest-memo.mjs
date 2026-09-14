import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,statSync,utimesSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {assertCanonicalActiveIdentityBoundary,ACTIVE_IDENTITY_OPERATION_BOUNDARIES} from '../dist/core/runtime-environment-checks.js';
const roots=[mkdtempSync(join(tmpdir(),'identity-canonical-a-')),mkdtempSync(join(tmpdir(),'identity-canonical-b-'))];
const boundary=ACTIVE_IDENTITY_OPERATION_BOUNDARIES.find(row=>row.id==='review-incremental-context');
const relative='dist/core/executable-digest-observation.js';
try {
  const paths=new Set(boundary.paths.map(row=>{assert.equal(row.scope,'runtime-package');return row.path;}));
  for(const site of boundary.identitySites)if(site.identityOrigin)paths.add(site.identityOrigin.sourcePath.replace('packages/main/src/','dist/').replace(/\.ts$/u,'.js'));
  for(const root of roots)for(const file of paths){mkdirSync(dirname(join(root,file)),{recursive:true});copyFileSync(resolve('packages/main',file),join(root,file));}
  const check=root=>assertCanonicalActiveIdentityBoundary({boundaryId:boundary.id,runtimePackageRoot:root});
  check(roots[0]);check(roots[0]);
  const original=readFileSync(join(roots[0],relative),'utf8');
  const mutant=original.replace('known !== undefined','known === undefined');
  assert.notEqual(mutant,original);assert.equal(Buffer.byteLength(mutant),Buffer.byteLength(original));
  for(const root of roots){
    const file=join(root,relative),before=statSync(file);
    writeFileSync(file,mutant);utimesSync(file,before.atime,before.mtime);
    assert.throws(()=>check(root),/executable declaration\/producer\/consumer binding changed/);
    writeFileSync(file,original);utimesSync(file,before.atime,before.mtime);check(root);
  }
  const file=join(roots[0],relative);
  rmSync(file);assert.throws(()=>check(roots[0]),/missing/);
  writeFileSync(file,original);check(roots[0]);
  console.log('IDENTITY_CANONICAL_DIGEST_MEMO_GREEN same-size restored-mtime mutation rejected; separate roots and deletion stay fresh');
} finally {for(const root of roots)rmSync(root,{recursive:true,force:true});}
