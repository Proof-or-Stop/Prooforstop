import fs from 'node:fs';
import child from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const [seedArg, beforeSourceArg, afterSourceArg, outArg] = process.argv.slice(2);
assert.ok(outArg, 'Usage: profile-pairs.mjs INPUT_ROOT BEFORE_TEST AFTER_TEST NEW_OUTPUT');
const seed=fs.realpathSync(seedArg), out=path.resolve(outArg), sources={red:fs.readFileSync(beforeSourceArg,'utf8'),green:fs.readFileSync(afterSourceArg,'utf8')};
const {RUNTIME_ARTIFACT_REGISTRY}=await import(pathToFileURL(path.join(seed,'packages/main/dist/core/runtime-artifact-registry.js')));
const {ACTIVE_IDENTITY_OPERATION_BOUNDARIES}=await import(pathToFileURL(path.join(seed,'packages/main/dist/core/runtime-environment-checks.js')));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const fnNames=['git','snapshotTree','snapshotGitMaterial','snapshotPublicOperationState','publicFixtureProjection','createPublicOperationClone'];
const code=text=>{const a=ts.createSourceFile('oracle.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);return a.statements.filter(n=>(ts.isFunctionDeclaration(n)&&fnNames.includes(n.name?.text))||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(a)==='INERT_PUBLIC_FIXTURE_LOG_SUBTREE'))).map(n=>n.getText(a)).join('\n');};
const fixtureRoots=[], reads=new Map();let measuredRoot,readBytes=0,readCalls=0;
const measuredRead=(...args)=>{const value=fs.readFileSync(...args);if(measuredRoot){const name=path.relative(measuredRoot,args[0]),bytes=typeof value==='string'?Buffer.byteLength(value):value.length;readBytes+=bytes;readCalls++;const row=reads.get(name)??{path:name,bytes:0,calls:0};row.bytes+=bytes;row.calls++;reads.set(name,row);}return value;};
const common={...fs,...child,...path,createHash:crypto.createHash,assert,tmpdir,fixtureRoots,repoRoot:seed,mainRoot:seed,packageRoot:path.join(seed,'packages/main'),runtimeArtifactRegistry:RUNTIME_ARTIFACT_REGISTRY,ACTIVE_IDENTITY_OPERATION_BOUNDARIES,readFileSync:measuredRead,installFixtureFindingLedgerPrivateKey:()=>assert.fail('Profiling does not copy signing keys')};
const functions={};
for(const arm of ['red','green'])functions[arm]=new Function(...Object.keys(common),code(sources[arm])+'\nreturn {clone:createPublicOperationClone,snapshot:snapshotPublicOperationState,projection:typeof publicFixtureProjection===\'function\'?publicFixtureProjection:undefined};')(...Object.values(common));
assert.ok(functions.green.projection);
const projection=functions.green.projection();
const decode=material=>{const rows=[];const re=/([\s\S]*?)\0(deleted|(?:symlink:)?[a-f0-9]{64})(?:\n|$)/gu;let m,end=0;while((m=re.exec(material))){rows.push([m[1],m[2]]);end=re.lastIndex;}assert.equal(end,material.length);return rows;};
const results=[],pairChecks=[];
try{
 for(let pair=1;pair<=3;pair++){
  const states={};
  for(const arm of pair%2?['red','green']:['green','red']){
   const started=performance.now();const root=functions[arm].clone('proof-or-stop-history-profile-',false);const setupMs=performance.now()-started;
   reads.clear();readBytes=0;readCalls=0;measuredRoot=root;
   let state;const began=performance.now();try{state=functions[arm].snapshot(root,['B-49df']);}finally{measuredRoot=undefined;}
   const snapshotMs=performance.now()-began;const material=decode(state.gitMaterial);
   states[arm]={outside:material.filter(([p])=>projection.materialized(p)),index:state.gitIndex,head:state.head,refs:state.refs,storyBytes:state.storyBytes};
   const result={pair,arm,sourceSha256:hash(sources[arm]),setupMs,snapshotMs,setupAndSnapshotMs:setupMs+snapshotMs,readBytes,readCalls,uniqueReadPaths:reads.size,indexedMaterialRows:material.length,materialDigest:hash(state.gitMaterial),outsideProjectionDigest:hash(JSON.stringify(states[arm].outside)),files:[...reads.values()].sort((a,b)=>b.bytes-a.bytes)};
   results.push(result);console.log(JSON.stringify({...result,files:undefined}));
   fs.rmSync(root,{recursive:true,force:true});fixtureRoots.splice(fixtureRoots.indexOf(root),1);
  }
  assert.deepEqual(states.red,states.green,'Projection changed retained material, target Story bytes, complete index, HEAD or refs');pairChecks.push({pair,retainedMaterialAndIndexAndRefsEqual:true});
 }
 fs.writeFileSync(out,JSON.stringify({scope:'Three alternating pairs with exactly the same frozen Git source and copied runtime input. Actual before/after fixture builders and snapshot functions extracted without changing their bodies. Creation plus snapshot measured; not full Story delivery timing.',seed,seedHead:child.execFileSync('git',['rev-parse','HEAD'],{cwd:seed,encoding:'utf8'}).trim(),beforeSourceSha256:hash(sources.red),afterSourceSha256:hash(sources.green),pairChecks,results},null,2)+'\n',{flag:'wx'});
}finally{for(const root of fixtureRoots)fs.rmSync(root,{recursive:true,force:true});}
