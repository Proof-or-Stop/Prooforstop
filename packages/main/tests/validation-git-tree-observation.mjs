import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {withGitTreeObservation as scope,readObservedGitTree as read} from '../dist/core/git-tree-observation.js';
const root=fs.mkdtempSync(join(tmpdir(),'pos-tree-observation-')),original=cp.execFileSync;let reads=0;
const git=(cwd,args)=>original('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
try{
 const a=join(root,'a'),b=join(root,'b');fs.mkdirSync(a);git(a,['init','-q','-b','main']);git(a,['config','user.name','Lab']);git(a,['config','user.email','lab@example.invalid']);fs.writeFileSync(join(a,'subject'),'A');git(a,['add','.']);git(a,['commit','-qm','base']);fs.cpSync(a,b,{recursive:true});const oid=git(a,['rev-parse','HEAD']);
 cp.execFileSync=function(cmd,args,opts){if(cmd==='git'&&args[0]==='ls-tree')reads++;return original.call(this,cmd,args,opts)};syncBuiltinESMExports();
 scope(()=>{const first=read(a,oid);assert.equal(read(a,oid),first);scope(()=>assert.equal(read(a,oid),first));assert.equal(reads,1);assert.equal(read(b,oid),first);assert.equal(reads,2,'Same oid in another cwd must not cross-hit');});
 scope(()=>read(a,oid));assert.equal(reads,3,'Next observation rereads');
 scope(()=>{read(a,'HEAD');read(a,'HEAD');});assert.equal(reads,5,'Symbolic refs never share');
 assert.throws(()=>scope(()=>{read(a,oid);throw new Error('INTERRUPT')}),/INTERRUPT/);scope(()=>read(a,oid));assert.equal(reads,7,'Throw must release observation');
 const old=process.env.GIT_OPTIONAL_LOCKS;try{scope(()=>{process.env.GIT_OPTIONAL_LOCKS='0';read(a,oid);process.env.GIT_OPTIONAL_LOCKS='1';read(a,oid);});assert.equal(reads,9,'Git environment changes do not cross-hit');}finally{if(old===undefined)delete process.env.GIT_OPTIONAL_LOCKS;else process.env.GIT_OPTIONAL_LOCKS=old;}
 const home=process.env.HOME;try{const before=reads;scope(()=>{read(a,oid);process.env.HOME=root;read(a,oid);});assert.equal(reads-before,2,'HOME changes cannot cross-hit');}finally{if(home===undefined)delete process.env.HOME;else process.env.HOME=home;}
 const beforeAwait=reads;await scope(async()=>{read(a,oid);await Promise.resolve();read(a,oid);});assert.equal(reads-beforeAwait,2,'Observation must not survive an await even if a future caller passes an async function');
 scope(()=>{read(a,oid);const formatted=original('git',['ls-tree','-r','-z','--format=%(objectname) %(path)',oid],{cwd:a,encoding:'utf8',maxBuffer:1024*1024});assert(!formatted.includes('100644 blob'));assert.throws(()=>original('git',['ls-tree','-r','-z',oid],{cwd:a,encoding:'utf8',maxBuffer:1}),e=>e.code==='ENOBUFS');});
 let failed=0;cp.execFileSync=function(cmd,args,opts){if(cmd==='git'&&args[0]==='ls-tree'){failed++;throw new Error('READ_FAILURE')}return original.call(this,cmd,args,opts)};syncBuiltinESMExports();
 scope(()=>{assert.throws(()=>read(a,oid),/READ_FAILURE/);assert.throws(()=>read(a,oid),/READ_FAILURE/);});assert.equal(failed,2,'Failures are not cached');cp.execFileSync=original;syncBuiltinESMExports();assert(scope(()=>read(a,oid)));
 const oldBytes=scope(()=>read(a,oid));fs.writeFileSync(join(a,'subject'),'B');git(a,['add','.']);git(a,['commit','-qm','replacement']);git(a,['replace',oid,'HEAD']);assert.notEqual(scope(()=>read(a,oid)),oldBytes,'Replacement object mapping is reread by next observation');
 console.log('GIT_TREE_OBSERVATION_GREEN nested cwd symbolic exception environment await format limit failure replacement');
}finally{cp.execFileSync=original;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
