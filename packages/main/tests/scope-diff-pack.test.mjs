import assert from 'node:assert/strict';
import fs from 'node:fs';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

// Install in packages/main/tests: only this checkout's built implementation.
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const {verifyBuildBinding}=await import(pathToFileURL(join(repo,'scripts/full-suite-build-binding.mjs')).href);
const binding=verifyBuildBinding(repo);assert(binding.sourceDigest && binding.distDigest);console.log('SCOPE_DIFF_LOCAL_BUILD '+JSON.stringify(binding));
const actualUrl=pathToFileURL(join(repo,'packages/main/dist/core/scope-diff-pack.js')).href;
const {parseUnifiedDiff,digestScopeDiffPack}=await import(actualUrl);
const root=fs.mkdtempSync(join(tmpdir(),'scope-diff-invocation-'));
const originalExec=child.execFileSync;let calls=[];
function git(...args){return originalExec('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function commit(message){git('add','.');git('-c','user.name=Scope fixture','-c','user.email=scope@example.test','commit','-qm',message);}
function write(path,text){fs.mkdirSync(dirname(join(root,path)),{recursive:true});fs.writeFileSync(join(root,path),text);}
function digest(hunks){return digestScopeDiffPack({changedFiles:[...new Set(hunks.map(h=>h.path))],hunks,generatedAt:'2000-01-01T00:00:00.000Z'});}
function observed(diff){
 calls=[];
 child.execFileSync=function(file,args,options){calls.push({file:String(file),args:[...args]});return Reflect.apply(originalExec,this,[file,args,options]);};syncBuiltinESMExports();
 try{return{hunks:parseUnifiedDiff(root,diff),calls};}
 finally{child.execFileSync=originalExec;syncBuiltinESMExports();}
}
function fileDiff(path,hunks){return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`+hunks.join('\n')+'\n';}
const h1='@@ -1,1 +1,1 @@\n-export function first() { return 1; }\n+export function first() { return 11; }';
const h2='@@ -5,1 +5,1 @@\n-export function second() { return 2; }\n+export function second() { return 22; }';
const h3='@@ -9,1 +9,1 @@\n-export function third() { return 3; }\n+export function third() { return 33; }';
const old='export function first() { return 1; }\n\n\n\nexport function second() { return 2; }\n\n\n\nexport function third() { return 3; }\n';
try{
 git('init','-q','-b','main');write('same.ts',old);write('other.ts','export function other() { return 0; }\n');write('deleted.ts','export function removed() { return 0; }\n');write('rename.ts','export function renamed() { return 0; }\n');commit('base');const base=git('rev-parse','HEAD');
 git('checkout','-qb','story/fixture');write('branch.ts','export const branch=1;\n');commit('branch divergence');
 git('checkout','-q','main');write('same.ts',old.replace('first()', 'baselineTip()'));commit('integration tip changes declaration');const tip=git('rev-parse','HEAD');assert.notEqual(tip,base);git('checkout','-q','story/fixture');
 write('same.ts',old.replace('return 1','return 11').replace('return 2','return 22').replace('return 3','return 33'));
 const diff=fileDiff('same.ts',[h1,h2,h3]);
 // Whole native results must match independent single-hunk queries, including all
 // anchors, previous anchors, context, digests and fallback fields.
 const independent=[h1,h2,h3].flatMap(h=>parseUnifiedDiff(root,fileDiff('same.ts',[h])));
 assert.equal(independent[0].previousAnchor,'baselineTip','Read integration TIP, never merge-base');
 assert.equal(independent[0].anchor,'first');assert.equal(independent[1].anchor,'second');assert.equal(independent[2].anchor,'third');
 const result=observed(diff);assert.deepEqual(result.hunks,independent);assert.equal(digest(result.hunks),digest(independent));
 const discovery=result.calls.filter(c=>c.file==='git'&&c.args[0]==='symbolic-ref');
 const shows=result.calls.filter(c=>c.file==='git'&&c.args[0]==='show');
 console.log('SCOPE_DIFF_NATIVE_COUNTS '+JSON.stringify({discovery:discovery.length,shows:shows.length,allGit:result.calls.length,digest:digest(result.hunks)}));
 // Run all compatibility controls before the deterministic performance oracle,
 // so unchanged baseline RED still proves original outputs remain admissible.
 const missing=fileDiff('absent.ts',['@@ -1,1 +1,0 @@\n-export function absent() {}']);
 const missingResult=observed(missing+missing);assert(missingResult.hunks.every(h=>h.parseFallback==='typescript_source_unavailable_fail_closed'));
 fs.rmSync(join(root,'deleted.ts'));const deletion=fileDiff('deleted.ts',['@@ -1,1 +0,0 @@\n-export function removed() { return 0; }']);const deleted=parseUnifiedDiff(root,deletion);assert.equal(deleted[0].previousAnchor,'removed');
 write('renamed.ts','export function renamed() { return 0; }\n');
 const rename='diff --git a/rename.ts b/renamed.ts\nsimilarity index 100%\nrename from rename.ts\nrename to renamed.ts\n';const renamed=parseUnifiedDiff(root,rename);assert(renamed.length);assert(renamed.some(h=>h.previousAnchor==='renamed'));
 const copy='diff --git a/rename.ts b/renamed.ts\nsimilarity index 100%\ncopy from rename.ts\ncopy to renamed.ts\n';assert(parseUnifiedDiff(root,copy).some(h=>h.parseFallback==='typescript_copy_identity_unsupported_fail_closed'));
 write('same.ts',fs.readFileSync(join(root,'same.ts'),'utf8').replace('first()', 'freshCurrent()'));const refreshed=parseUnifiedDiff(root,diff);assert.equal(refreshed[0].anchor,'freshCurrent','No cross-invocation current-source cache');
 // Move main genuinely while remaining on the independent branch; the next
 // parser call must discover its new tip rather than retain the former OID.
 const savedCurrent=fs.readFileSync(join(root,'same.ts'),'utf8');
 git('checkout','-q','-f','main');write('same.ts',old.replace('first()', 'newBaselineTip()'));commit('new integration declaration');const newer=git('rev-parse','HEAD');git('checkout','-q','-f','story/fixture');write('same.ts',savedCurrent);
 const fresh=observed(diff);assert.equal(fresh.hunks[0].previousAnchor,'newBaselineTip','New invocation must read updated selected TIP source');assert.equal(fresh.hunks[0].anchor,'freshCurrent');
 assert.equal(child.execFileSync,originalExec,'Forwarding observer restored');
 assert.equal(discovery.length,1,'SCOPE_DIFF_RED baseline discovery must occur once per invocation, not per hunk');
 assert.equal(shows.length,1,'SCOPE_DIFF_RED unchanged historical source must be read once per invocation/path');
 assert.equal(missingResult.calls.filter(c=>c.args[0]==='show').length,1,'Missing base source also memoized within invocation');
 console.log('SCOPE_DIFF_INVOCATION_GREEN exact anchors/digests, TIP semantics, freshness, rename/copy/deletion/missing, bounded Git calls');
}finally{child.execFileSync=originalExec;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
