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
const {parseUnifiedDiff,digestScopeDiffPack,SCOPE_ANCHOR_PARSER_VERSION}=await import(actualUrl);
const root=fs.mkdtempSync(join(tmpdir(),'scope-diff-invocation-'));
const originalExec=child.execFileSync;let calls=[];
const priorCeiling=process.env.GIT_CEILING_DIRECTORIES;
process.env.GIT_CEILING_DIRECTORIES=dirname(root); // Prevent pre-init parent repository discovery, even with TMPDIR inside a checkout.
function git(...args){return originalExec('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function commit(message){git('add','.');git('-c','user.name=Scope fixture','-c','user.email=scope@example.test','commit','-qm',message);}
function write(path,text){fs.mkdirSync(dirname(join(root,path)),{recursive:true});fs.writeFileSync(join(root,path),text);}
function digest(hunks){return digestScopeDiffPack({changedFiles:[...new Set(hunks.map(h=>h.path))],hunks,generatedAt:'2000-01-01T00:00:00.000Z'});}
function observed(diff,afterExec,beforeExec){
 calls=[];
 child.execFileSync=function(file,args,options){calls.push({file:String(file),args:[...args]});beforeExec?.(String(file),args);const value=Reflect.apply(originalExec,this,[file,args,options]);afterExec?.(String(file),args);return value;};syncBuiltinESMExports();
 try{return{hunks:parseUnifiedDiff(root,diff),calls};}
 finally{child.execFileSync=originalExec;syncBuiltinESMExports();}
}
function fileDiff(path,hunks){return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`+hunks.join('\n')+'\n';}
const h1='@@ -1,1 +1,1 @@\n-export function first() { return 1; }\n+export function first() { return 11; }';
const h2='@@ -5,1 +5,1 @@\n-export function second() { return 2; }\n+export function second() { return 22; }';
const h3='@@ -9,1 +9,1 @@\n-export function third() { return 3; }\n+export function third() { return 33; }';
const old='export function first() { return 1; }\n\n\n\nexport function second() { return 2; }\n\n\n\nexport function third() { return 3; }\n';
try{
 const prose=observed(fileDiff('README.md',['@@ -1,1 +1,1 @@\n-old\n+new']));assert.equal(prose.calls.length,0,'No TS/JS hunks must not discover a baseline');
 write('same.ts',old);const noBaseline=observed(fileDiff('same.ts',[h1]));assert.equal(noBaseline.hunks[0].previousAnchor,undefined,'Missing repository history remains unavailable');
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
 const result=observed(diff);assert.deepEqual(result.hunks,independent);assert.equal(digest(result.hunks),digest(independent));assert.equal(SCOPE_ANCHOR_PARSER_VERSION,'typescript-5.9-ast-v1','Parser version changed: review explicit golden digest before updating its pin');assert.equal(digest(result.hunks),'0a0d069bb60c9fa653fc3453e0faa1023b88c484254d275ed182fcd168cd73b6','Exact unchanged baseline full hunk digest');
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
 const otherDiff=fileDiff('other.ts',['@@ -1,1 +1,1 @@\n-export function other() { return 0; }\n+export function other() { return 9; }']);write('other.ts','export function other() { return 9; }\n');
 const distinct=observed(diff+otherDiff);assert.equal(distinct.hunks.at(-1).anchor,'other');assert.equal(distinct.hunks.at(-1).previousAnchor,'other');
 let advanced=false;let pinned;
 try{pinned=observed(diff+otherDiff,(file,args)=>{if(!advanced&&file==='git'&&args[0]==='show'){advanced=true;git('update-ref','refs/heads/main',tip,newer);}});}
 finally{git('update-ref','refs/heads/main',newer);}
 assert(advanced,'Genuine ref move occurred during the parser invocation');assert.deepEqual(pinned.hunks,distinct.hunks,'One invocation must retain its selected historical tip');
 assert(pinned.calls.filter(c=>c.args[0]==='show').every(c=>String(c.args[1]).startsWith(newer+':')),'Every historical path reads the pinned tip OID');
 // Explicit fault injection only for the additional pin, after the genuine
 // resolver's identical successful rev-parse. No fake Git result or authority.
 let pinCalls=0;const failedPin=observed(diff+otherDiff,undefined,(file,args)=>{if(file==='git'&&args[0]==='rev-parse'&&args.at(-1)==='refs/heads/main^{commit}'&&++pinCalls===2)throw new Error('fixture additional baseline pin failure');});
 assert.equal(pinCalls,2,'Real baseline resolution succeeded before the injected additional pin failure');
 assert(failedPin.hunks.every(h=>h.anchor&&h.parseFallback==='typescript_baseline_pin_unresolved_fail_closed'),'Valid baseline pin failure must be explicit for all current-anchor paths');
 assert.equal(failedPin.calls.filter(c=>c.args[0]==='show').length,0,'No live-ref history fallback after unresolved pin');
 const {checkSemanticScope}=await import(pathToFileURL(join(repo,'packages/main/dist/core/semantic-scope-gate.js')).href);
 const contract={mode:'enforce',fileRules:[{path:'same.ts',allowedAnchors:['freshCurrent','second','third']},{path:'other.ts',allowedAnchors:['other']}],acknowledgements:[{paths:['same.ts','other.ts'],hunkDigests:failedPin.hunks.map(h=>h.hunkDigest)}]};
 const gate=checkSemanticScope(contract,{hunks:failedPin.hunks});assert.equal(gate.status,'fail');assert.equal(gate.violations.length,failedPin.hunks.length);assert(gate.violations.every(v=>v.detail.includes('typescript_baseline_pin_unresolved_fail_closed')));
 assert.deepEqual(observed(diff+otherDiff).hunks,distinct.hunks,'Fresh invocation recovers after the injected pin failure');
 assert.equal(child.execFileSync,originalExec,'Forwarding observer restored');
 assert.equal(discovery.length,1,'SCOPE_DIFF_RED baseline discovery must occur once per invocation, not per hunk');
 assert.equal(shows.length,1,'SCOPE_DIFF_RED unchanged historical source must be read once per invocation/path');
 assert.equal(missingResult.calls.filter(c=>c.args[0]==='show').length,1,'Missing base source also memoized within invocation');
 assert.equal(distinct.calls.filter(c=>c.args[0]==='symbolic-ref').length,1);
 assert.equal(distinct.calls.filter(c=>c.args[0]==='show').length,2,'Different historical paths must not alias');
 // The unchanged semantic-scope suite is verified separately, not nested twice in the full-suite runner.
 const {entriesFromSerialReference}=await import(pathToFileURL(join(repo,'packages/main/dist/tasks/full-suite-runner.js')).href);
 const scripts=JSON.parse(fs.readFileSync(join(repo,'package.json'),'utf8')).scripts;
 const entries=entriesFromSerialReference([scripts['test:serial-reference-prefix'],scripts['test:serial-reference']].filter(Boolean).join(' && '),scripts);
 assert.equal(entries.filter(e=>e.name==='test:scope-diff-pack').length,1,'Regression must execute exactly once in canonical suite');
 assert.equal(scripts['test:scope-diff-pack'],'node packages/main/tests/scope-diff-pack.test.mjs');
 console.log('SCOPE_DIFF_INVOCATION_GREEN exact anchors/digests, TIP semantics, freshness, rename/copy/deletion/missing, bounded Git calls');
}finally{child.execFileSync=originalExec;syncBuiltinESMExports();if(priorCeiling===undefined)delete process.env.GIT_CEILING_DIRECTORIES;else process.env.GIT_CEILING_DIRECTORIES=priorCeiling;fs.rmSync(root,{recursive:true,force:true});}
