import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {join} from 'node:path';import assert from 'node:assert/strict';
const root=mkdtempSync(join(os.tmpdir(),'supervised-utf8-'));const saved=os.userInfo;os.userInfo=(...a)=>({...saved(...a),homedir:root});syncBuiltinESMExports();
try {const {runSupervisedProviderProcess}=await import('../packages/main/dist/providers/supervised-process.js');const r=runSupervisedProviderProcess(process.execPath,['-e',"process.stdout.write(Buffer.from([0xe4]));setTimeout(()=>process.stdout.write(Buffer.from([0xb8,0xad])),60)"],{cwd:root,env:process.env,timeoutMs:1500});console.log(JSON.stringify(r));assert.equal(r.stdout,'中','preserve valid UTF-8 spanning stream chunks');assert.equal(r.replacementSafe,true);
const missing=runSupervisedProviderProcess('nonexistent-provider-lab-4281',[],{cwd:root,env:process.env,timeoutMs:1000});assert.equal(missing.error.code,'ENOENT');assert.equal(missing.replacementSafe,true);
const timed=runSupervisedProviderProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,env:process.env,timeoutMs:100});assert.equal(timed.signal,'SIGTERM');assert.equal(timed.replacementSafe,true);
const api=await import('../packages/main/dist/core/provider-process-admission.js');
const registry=await import('../packages/main/dist/core/provider-process-registry.js');
const partial=api.acquireProviderProcessAdmission({root,env:process.env,host:'codex',storyId:null,agentType:'partial-transfer'});assert.ok(partial.admitted);
registry.releaseProviderProcessSlot(partial.machineSlot.file,partial.machineSlot.token);
const refused=runSupervisedProviderProcess(process.execPath,['-e','process.stdout.write("must-not-spawn")'],{cwd:root,env:process.env,timeoutMs:1000,admission:partial});
assert.equal(refused.error.code,'EADMISSION');assert.equal(refused.stdout,'');assert.equal(refused.replacementSafe,true);
api.releaseProviderProcessAdmission(partial);assert.equal((await import('node:fs')).existsSync(partial.slot.file),false);
console.log('PASS supervised provider UTF8, missing binary, timeout and safe partial-transfer rollback');}finally{os.userInfo=saved;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
