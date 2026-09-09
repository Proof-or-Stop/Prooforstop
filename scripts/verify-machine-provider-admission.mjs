import assert from 'node:assert/strict';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const root=mkdtempSync(join(os.tmpdir(),'machine-provider-admission-'));
// Isolate the OS-user runtime namespace in this test process; production has no
// environment switch or caller path for bypassing its canonical machine pool.
const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:join(root,'home')});syncBuiltinESMExports();
const {acquireProviderProcessAdmission,releaseProviderProcessAdmission}=await import('../packages/main/dist/core/provider-process-admission.js');
const {PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT}=await import('../packages/main/dist/core/provider-process-registry.js');
const admissions=[];
try{
 for(let i=0;i<=PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT;i++){
  const project=join(root,`project-${i}`);mkdirSync(project);
  admissions.push(acquireProviderProcessAdmission({root:project,env:{...process.env,PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT:'100'},host:'codex',storyId:null,agentType:'machine-capacity-witness'}));
 }
 assert.ok(admissions.slice(0,-1).every(a=>a.admitted),'positive control: available machine slots admit providers');
 assert.equal(admissions.at(-1).admitted,false,'U08 provider admission must enforce machine capacity across project roots');
 console.log('PASS U08 machine provider admission cannot be raised by project-local capacity');
}finally{for(const a of admissions)releaseProviderProcessAdmission(a);os.userInfo=original;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
