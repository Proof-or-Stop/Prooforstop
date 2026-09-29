// Case 88 must be able to fail: a run whose earlier cases requested fixtures but left none is rejected.
import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const label='isolation: all artifacts live under the temp root (no repo pollution)';
if(process.argv[2]==='--child'){
 const support=await import(pathToFileURL(resolve('packages/main/dist/tasks/host-run-usage/support.js')).href);
 const {rmSync}=await import('node:fs');
 try{
  if(process.argv[3]==='prior-request')support.freshRoot();
  const {case88}=await import(pathToFileURL(resolve('packages/main/dist/tasks/host-run-usage/evidence-mapping.js')).href);
  await case88();
  console.log('CASE88_FAILURES '+JSON.stringify(support.failures));
 }finally{rmSync(support.root,{recursive:true,force:true});}
} else {
 const run=mode=>{const r=spawnSync(process.execPath,[process.argv[1],'--child',mode],{encoding:'utf8',timeout:60000});assert.equal(r.signal,null);const line=r.stdout.split('\n').find(l=>l.startsWith('CASE88_FAILURES '));assert(line,r.stdout+r.stderr);return JSON.parse(line.slice(16));};
 assert.deepEqual(run('standalone'),[],'standalone selection must pass');
 assert.deepEqual(run('prior-request'),[label],'ISOLATION_ORACLE_TAUTOLOGY: requested but unwritten prior fixtures must fail case 88');
 console.log('ISOLATION_ORACLE_DISCRIMINATES standalone=pass priorRequestWithoutFixture=fail');
}
