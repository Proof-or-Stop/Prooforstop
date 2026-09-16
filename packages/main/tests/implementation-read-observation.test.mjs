import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
import {baselineImplementationIdentity} from './implementation-identity-reference.mjs';
import {executionImplementationIdentity} from '../dist/core/execution-implementation.js';
export function checkImplementationReadObservation(){
 const original=fs.readFileSync;let reads=new Map();
 fs.readFileSync=function(file,...args){const key=String(file);reads.set(key,(reads.get(key)??0)+1);return original.call(this,file,...args);};syncBuiltinESMExports();
 const touched=[];
 try{
  const reference=baselineImplementationIdentity();reads.clear();const candidate=executionImplementationIdentity();assert.deepEqual(candidate,reference,'all file paths and content digests retain the full baseline scope');
  const duplicateReads=[...reads.values()].reduce((n,c)=>n+Math.max(0,c-1),0);const readCount=[...reads.values()].reduce((a,b)=>a+b,0);
  const probes=[['packages/main/dist/tasks/__lab_scope_probe.js','//AAAA'],['packages/main/templates/__lab_scope_probe.txt','AAAA'],['packages/main/node_modules/typescript/lib/__lab_scope_probe.json','"AAAA"']];
  for(const [relative,content] of probes){const file=path.resolve(relative);fs.rmSync(file,{force:true});/* a killed earlier run must not poison this one */fs.writeFileSync(file,content);touched.push(file);const before=executionImplementationIdentity();assert.notEqual(before.digest,candidate.digest,'added protected file changes identity');assert.deepEqual(before,baselineImplementationIdentity(),'added file stays in full scope');const stat=fs.statSync(file);fs.writeFileSync(file,content.replaceAll('A','B'));fs.utimesSync(file,stat.atime,stat.mtime);const after=executionImplementationIdentity();assert.notEqual(after.digest,before.digest,'same-size restored-mtime mutation remains visible');assert.deepEqual(after,baselineImplementationIdentity());fs.unlinkSync(file);touched.pop();assert.deepEqual(executionImplementationIdentity(),candidate,'deletion is observed without retained cache');}
  const link=path.resolve('packages/main/dist/tasks/__lab_scope_link.js');fs.rmSync(link,{force:true});fs.symlinkSync(path.resolve('packages/main/dist/core/execution-implementation.js'),link);touched.push(link);assert.throws(()=>executionImplementationIdentity(),/IMPLEMENTATION_IDENTITY_SYMLINK/);fs.unlinkSync(link);touched.pop();assert.deepEqual(executionImplementationIdentity(),candidate,'throw leaves no cache');
  const result={fileCount:candidate.fileCount,readCount,duplicateReads,scopeParity:true,mutationCategories:['compiled tasks','templates','dependency payload'],sameSizeRestoredMtime:true,additionDeletion:true,symlinkRefusal:true};console.log('IMPLEMENTATION_READ_OBSERVATION '+JSON.stringify(result));return result;
 }finally{for(const file of touched)fs.unlinkSync(file);fs.readFileSync=original;syncBuiltinESMExports();}
}
