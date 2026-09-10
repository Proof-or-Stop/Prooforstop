import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const repo=resolve(process.argv[2]||process.cwd());
const original=cp.execFileSync;let active=false;const calls=[];
cp.execFileSync=function(command,args,...rest){if(active&&command==='git')calls.push(args);return original.call(this,command,args,...rest)};syncBuiltinESMExports();
const {currentStoryFilesHash}=await import(pathToFileURL(join(repo,'packages/main/dist/core/evidence-freshness.js')));
const root=mkdtempSync(join(tmpdir(),'u17-story-budget-'));const git=(...args)=>original('git',args,{cwd:root,encoding:'utf8'}).trim();
try{
 git('init','-q');git('checkout','-qb','main');writeFileSync(join(root,'a.ts'),'export const a=1;\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','base');git('checkout','-qb','story');writeFileSync(join(root,'a.ts'),'export const a=2;\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','story');
 active=true;const values=Array.from({length:3},()=>currentStoryFilesHash(root));active=false;
 assert.equal(typeof values[0],'string');assert.ok(values.every(v=>v===values[0]));const counts=Object.fromEntries(['ls-tree','diff','merge-base'].map(k=>[k,calls.filter(a=>a[0]===k).length]));console.log(JSON.stringify({values,counts,calls}));
 assert.ok(counts['ls-tree']<=1,'same immutable target tree should be read at most once');assert.ok(counts.diff<=1,'same immutable base/head diff should be read at most once');
}finally{rmSync(root,{recursive:true,force:true});cp.execFileSync=original;syncBuiltinESMExports();}
for (const script of ['verify-story-hash-memo-boundaries.mjs', 'verify-material-tree-memo.mjs', 'verify-git-root-probe-memo.mjs']) {
  original(process.execPath, [join(repo, 'scripts', script)], { cwd: repo, stdio: 'inherit', timeout: 120_000 });
}
console.log('PASS U17 immutable story hash reads and invalidation boundaries');
