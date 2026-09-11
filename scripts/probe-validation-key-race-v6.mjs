import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,readdirSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {signValidationArtifact,verifyValidationArtifact,validationArtifactSigningPublicKey} from '../packages/main/dist/core/validation-artifact-signing.js';
const root=mkdtempSync(join(tmpdir(),'pos-key-race-v6-')),repo=join(root,'repo'),keyName='proof-story-aware-validation-artifact-v1.key';
const git=(cwd,args)=>execFileSync('git',args,{cwd,stdio:'pipe'});
try{
 mkdirSync(repo);git(repo,['init','-qb','main']);git(repo,['config','user.name','Lab']);git(repo,['config','user.email','lab@example.invalid']);writeFileSync(join(repo,'seed'),'seed');git(repo,['add','.']);git(repo,['commit','-qm','seed']);
 const trees=[join(root,'a'),join(root,'b')];trees.forEach((p,i)=>git(repo,['worktree','add','-qb','w'+i,p]));
 const ready=join(root,'ready');mkdirSync(ready);const worker=join(root,'worker.mjs');
 writeFileSync(worker,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';const original=fs.existsSync;let synced=false;fs.existsSync=p=>{const result=original(p);if(String(p).endsWith(${JSON.stringify(keyName)})&&!result&&!synced){synced=true;fs.writeFileSync(join(${JSON.stringify(ready)},String(process.pid)),'ready');const end=Date.now()+10000;while(fs.readdirSync(${JSON.stringify(ready)}).length<8){if(Date.now()>end)throw Error('KEY_BARRIER_DEADLINE');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}return result;};syncBuiltinESMExports();const {signValidationArtifact,verifyValidationArtifact,validationArtifactSigningPublicKey}=await import(${JSON.stringify(new URL('../packages/main/dist/core/validation-artifact-signing.js',import.meta.url).href)});const value={pid:process.pid};const signature=signValidationArtifact(value,process.cwd());console.log(JSON.stringify({ok:verifyValidationArtifact(value,signature,process.cwd()),publicKey:validationArtifactSigningPublicKey(process.cwd())}));`);
 const rows=await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{const cp=spawn(process.execPath,[worker],{cwd:trees[i%2],stdio:['ignore','pipe','pipe']});let stdout='',stderr='';cp.stdout.on('data',b=>stdout+=b);cp.stderr.on('data',b=>stderr+=b);cp.on('error',reject);cp.on('close',code=>resolve({code,stdout,stderr}));})));
 console.log(JSON.stringify({scenario:'eight cold signers after simultaneous absence observation',rows},null,2));
 assert(rows.every(r=>r.code===0),'ALL_COLD_VALIDATION_SIGNERS_MUST_SUCCEED');const facts=rows.map(r=>JSON.parse(r.stdout));assert(facts.every(r=>r.ok));assert.equal(new Set(facts.map(r=>r.publicKey)).size,1);
 const key=join(repo,'.git',keyName);assert.equal(statSync(key).mode&0o777,0o600);assert(!readdirSync(join(repo,'.git')).some(n=>n.startsWith(keyName+'.')),'No owned temporary key remains');
 writeFileSync(key,'malformed-existing-key');assert.throws(()=>signValidationArtifact({a:1},repo));assert.equal(readFileSync(key,'utf8'),'malformed-existing-key');assert.equal(verifyValidationArtifact({a:1},'ed25519:validation-artifact-v1:invalid',repo),false);
 const empty=join(root,'empty');mkdirSync(empty);git(empty,['init','-q']);assert.equal(validationArtifactSigningPublicKey(empty),undefined);assert.equal(existsSync(join(empty,'.git',keyName)),false);
 console.log('VALIDATION_KEY_RACE_V6_GREEN: 8 signers, one trusted public key; malformed key preserved; verification never creates authority');
}finally{rmSync(root,{recursive:true,force:true});}
