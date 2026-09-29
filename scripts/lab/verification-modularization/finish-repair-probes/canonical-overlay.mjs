import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source=fs.readFileSync(process.argv[2],'utf8');
const parsed=ts.createSourceFile('release.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const fn=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='createIdentityVerifierClone');assert(fn);
const root=fs.mkdtempSync(join(tmpdir(),'canonical-overlay-proof-'));
const repoRoot=join(root,'candidate'),clone=join(root,'clone');
const modulePath='packages/main/tests/canonical-new-story-artifacts/new-module.mjs';
const write=(base,path,bytes)=>{fs.mkdirSync(dirname(join(base,path)),{recursive:true});fs.writeFileSync(join(base,path),bytes);};
try{
 for(const base of [repoRoot,clone]){
  for(const name of ['packages/main/tests/canonical-new-story-artifacts.test.mjs','packages/main/tests/brand-role-migration.test.mjs',...['source','json','fixture'].flatMap(kind=>[`scripts/identity-reviewed-${kind}-data.json`,`scripts/identity-reviewed-${kind}-contexts.mjs`])])write(base,name,'{}');
  write(base,modulePath,'export const candidate = "committed";');
 }
 write(repoRoot,modulePath,'export const candidate = "working-tree";');
 write(repoRoot,'scripts/verify-proof-or-stop-identity-cutover.mjs',`import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';assert.equal(readFileSync(${JSON.stringify(modulePath)},'utf8'),'export const candidate = "working-tree";','CANONICAL_SPLIT_MODULE_OVERLAY_MISSING');console.log('PASS identity-boundary-scan');`);
 const body=fn.getText(parsed).replace('export ','');
 const invoke=vm.runInNewContext(body+';createIdentityVerifierClone',{
  assert,...fs,join,dirname,repoRoot,process,spawnSync,
  createPublicOperationClone:()=>clone,
  materializeIdentityVerifierCheckout:()=>{},
  identityCutoverSourceMap:()=>new Map(),
  identityVerifierFixtureEntrypoint:root=>join(root,'scripts/verify-proof-or-stop-identity-cutover.mjs'),
 });
 invoke();
 assert.equal(fs.readFileSync(join(clone,modulePath),'utf8'),fs.readFileSync(join(repoRoot,modulePath),'utf8'));
 console.log('CANONICAL_MODULE_OVERLAY_PASS realChildScan=true boundary=ownedCloneOverlayOnly');
}finally{fs.rmSync(root,{recursive:true,force:true});}
