import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const root=fs.mkdtempSync(join(tmpdir(),'learning-scope-'));
const original=cp.execFileSync;let calls=[];let fail=false;
cp.execFileSync=function(command,args,options){if(command==='git'){calls.push({args,cwd:options?.cwd});if(fail)throw new Error('injected Git discovery failure');}return original.apply(this,arguments);};syncBuiltinESMExports();
const git=(cwd,...args)=>original('git',args,{cwd,encoding:'utf8',stdio:'pipe'});
const {buildMemoryFreshnessPack}=await import('../packages/main/dist/core/playbook-runtime-memory.js');
const learning=await import('../packages/main/dist/core/learning-store.js');
const {resolveProjectMemoryPath}=await import('../packages/main/dist/core/dev-memory.js');
process.env.PROOF_OR_STOP_GLOBAL_MEMORY_DIR=join(root,'global');
try {
 const main=join(root,'main');fs.mkdirSync(main);git(main,'init','-b','main');git(main,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture');
 const path=resolveProjectMemoryPath(main);fs.mkdirSync(dirname(path),{recursive:true});fs.writeFileSync(path,JSON.stringify({id:'one',createdAt:'2026-09-01T00:00:00.000Z',sourceAgent:'fixture',category:'workflow',scope:'project',summary:'intake',trigger:'intake',lesson:'intake',reusePrompt:'intake',tags:[],evidenceRefs:[],gateEvidence:false,authority:'non_authoritative'})+'\n');
 const options={projectRoot:main,query:'intake',generatedAt:'2026-09-01T00:00:00.000Z'};const prime=buildMemoryFreshnessPack(options);calls=[];const warm=buildMemoryFreshnessPack(options);assert.deepEqual(warm,JSON.parse(JSON.stringify(prime)));console.log('LEARNING_SCOPE_MEASURE '+JSON.stringify({warmGit:calls.length,calls}));assert.equal(calls.length,2,'LEARNING_SCOPE_RED: one warm pack must resolve learning owner once');
 const scope=learning.withLearningRootScope;assert.equal(typeof scope,'function');
 const linked=join(root,'linked');git(main,'worktree','add','-b','linked',linked);
 const separate=join(root,'separate');fs.mkdirSync(separate);git(separate,'init','--separate-git-dir='+join(root,'storage'),'-b','main');
 for(const [origin,expected] of [[main,main],[linked,main],[separate,separate]]){calls=[];scope(()=>{assert.equal(learning.resolveLearningOwnerRoot(origin),expected);assert.equal(learning.resolveLearningOwnerRoot(origin),expected);});const n=calls.length;assert(n>=2&&n<=3);scope(()=>learning.resolveLearningOwnerRoot(origin));assert.equal(calls.length,n*2,'new operation must rediscover');}
 calls=[];scope(()=>{assert.equal(learning.resolveLearningOwnerRoot(main),main);assert.equal(learning.resolveLearningOwnerRoot(separate),separate);});assert.equal(calls.length,5,'different origins must not alias');
 calls=[];scope(()=>{fail=true;assert.equal(learning.resolveLearningOwnerRoot(linked),linked);fail=false;assert.equal(learning.resolveLearningOwnerRoot(linked),main);assert.equal(learning.resolveLearningOwnerRoot(linked),main);});assert.equal(calls.length,4,'failed discovery must not be memoized');
 assert.throws(()=>scope(()=>{learning.resolveLearningOwnerRoot(main);throw new Error('scope exception');}),/scope exception/);calls=[];learning.resolveLearningOwnerRoot(main);learning.resolveLearningOwnerRoot(main);assert.equal(calls.length,4,'scope must clear after throwing');
 const plain=join(root,'plain');fs.mkdirSync(plain);scope(()=>assert.equal(learning.resolveLearningOwnerRoot(plain),plain));git(plain,'init','-b','main');calls=[];scope(()=>learning.resolveLearningOwnerRoot(plain));assert.equal(calls.length,2,'new Git topology observed');
 console.log('LEARNING_SCOPE_GREEN pack-parity linked separate origins transient-failure exception next-operation');
}finally{cp.execFileSync=original;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
