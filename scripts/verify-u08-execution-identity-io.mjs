import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';import{tmpdir}from'node:os';import{pathToFileURL,fileURLToPath}from'node:url';
const repo=resolve(process.argv[2]||process.cwd()),load=n=>import(pathToFileURL(join(repo,'packages/main/dist/core',n+'.js')));
const {readManagedExecutionIdentityKey,loadManagedExecutionIdentityKey}=await load('managed-execution-identity-key');
const {identifyManagedExecutionInputs}=await load('managed-execution-input-identity');
const {captureManagedProviderState}=await load('managed-review-provider-state');
if(process.argv[3]==='child'){
 const root=process.argv[4],kind=process.argv[5];
 if(kind==='key')assert.throws(()=>readManagedExecutionIdentityKey(join(root,'fifo-key')),/invalid controller identity key/);
 else{
  const key=loadManagedExecutionIdentityKey(join(root,'good-key'));const state=captureManagedProviderState('codex',{CODEX_HOME:join(root,'source')});
  assert.throws(()=>identifyManagedExecutionInputs({key,host:'codex',providerState:state,executablePath:join(root,'fifo-exe'),cwd:root,environment:{},reviewProfile:'managed_reviewer',reviewArgv:['exec']}),/executable regular file/);
 }
 console.log('PASS bounded FIFO '+kind);
}else{
 const root=mkdtempSync(join(tmpdir(),'u08-identity-io-'));
 try{
  assert.throws(()=>readManagedExecutionIdentityKey(join(root,'missing-directory')));assert.equal(existsSync(join(root,'missing-directory')),false);
  const empty=join(root,'empty');mkdirSync(empty,{mode:0o700});assert.throws(()=>readManagedExecutionIdentityKey(empty));assert.deepEqual(readdirSync(empty),[]);
  const source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'auth.json'),JSON.stringify({OPENAI_API_KEY:'fixture-only'}));
  mkdirSync(join(root,'fifo-key'),{mode:0o700});mkdirSync(join(root,'good-key'),{mode:0o700});
  // Actual existing key is replaced by a FIFO, not a mocked fs error.
  loadManagedExecutionIdentityKey(join(root,'fifo-key'));rmSync(join(root,'fifo-key','execution-identity.key'));
  execFileSync('/usr/bin/mkfifo',[join(root,'fifo-key','execution-identity.key')]);execFileSync('/usr/bin/mkfifo',[join(root,'fifo-exe')]);
  for(const kind of ['key','exe']){
   const run=spawnSync(process.execPath,[...process.execArgv,fileURLToPath(import.meta.url),repo,'child',root,kind],{encoding:'utf8',timeout:3000});
   assert.equal(run.error,undefined,'FIFO must reject before timeout');assert.equal(run.signal,null);assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS bounded FIFO/);
  }
  console.log('PASS read-only missing has zero writes; replaced key FIFO and executable FIFO reject without blocking');
 }finally{rmSync(root,{recursive:true,force:true});}
}
