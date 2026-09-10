import assert from 'node:assert/strict';
import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';import {join} from 'node:path';
const repo=process.argv[2]??process.cwd(),base=mkdtempSync(join(os.tmpdir(),'machine-provider-orphan-'));
const home=join(base,'home');mkdirSync(home);const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:home});syncBuiltinESMExports();
const api=await import(repo+'/packages/main/dist/core/provider-process-admission.js');
const {PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT}=await import(repo+'/packages/main/dist/core/provider-process-registry.js');
const held=[];let providerPid,worker,providerGone=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stop=join(base,'stop'),identityFile=join(base,'identity.json');
const request=root=>({root,env:process.env,host:'codex',storyId:null,agentType:'orphan-probe'});
function root(name){const r=join(base,name);mkdirSync(r);execFileSync('git',['init','-q',r]);return r;}
try {
 for(let i=0;i<PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT-1;i++){const a=api.acquireProviderProcessAdmission(request(root('held'+i)));assert.ok(a.admitted);held.push(a);}
 const workerRoot=root('worker'),contenderRoot=root('contender');
 const providerFile=join(base,'provider.cjs');writeFileSync(providerFile,`const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)})){clearInterval(t);process.exit(0);}},25);`);
 const workerFile=join(base,'worker.mjs');writeFileSync(workerFile,`
import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import {spawn,execFileSync} from 'node:child_process';import {writeFileSync} from 'node:fs';
const original=os.userInfo;os.userInfo=(...a)=>({...original(...a),homedir:${JSON.stringify(home)}});syncBuiltinESMExports();
const api=await import(${JSON.stringify(repo+'/packages/main/dist/core/provider-process-admission.js')});
const admission=api.acquireProviderProcessAdmission({...${JSON.stringify({...request(workerRoot),env:{}})},env:process.env});if(!admission.admitted)throw Error('last available slot refused');
const p=spawn(process.execPath,[${JSON.stringify(providerFile)}],{detached:true,stdio:'ignore'});p.unref();
const pid=p.pid,pgid=Number(execFileSync('ps',['-o','pgid=','-p',String(pid)],{encoding:'utf8'}).trim()),startFingerprint=execFileSync('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8'}).trim();
const identity={pid,pgid,startFingerprint,spawnedAt:new Date().toISOString(),processGroupIsolated:pgid===pid};
writeFileSync(${JSON.stringify(identityFile)},JSON.stringify(identity));
if(!api.transferProviderProcessAdmissionToProvider(admission,identity))throw Error('transfer failed');
console.log('TRANSFERRED');
`);
 worker=spawn(process.execPath,[workerFile],{stdio:['ignore','pipe','pipe']});let out='';worker.stdout.on('data',x=>out+=x);worker.stderr.on('data',x=>out+=x);
 const code=await new Promise(r=>worker.once('close',r));assert.equal(code,0,out);assert.match(out,/TRANSFERRED/);
 const identity=JSON.parse(readFileSync(identityFile,'utf8'));providerPid=identity.pid;assert.equal(identity.pgid,providerPid);process.kill(-providerPid,0);
 const denied=api.acquireProviderProcessAdmission(request(contenderRoot));assert.equal(denied.admitted,false);assert.equal(denied.capacityScope,'machine');
 console.log('PASS worker exited; live actual provider PGID retains machine slot');
 writeFileSync(stop,'exit');let gone=false;for(let i=0;i<200;i++){try{process.kill(-providerPid,0);}catch(e){if(e.code==='ESRCH'){gone=true;break;}if(e.code!=='EPERM')throw e; const rows=execFileSync('ps',['-axo','pgid='],{encoding:'utf8'}).trim().split(/\s+/);if(!rows.includes(String(providerPid))){gone=true;break;}}await sleep(25);}assert.ok(gone,'provider group naturally exited');providerGone=true;providerPid=undefined;
 const after=api.acquireProviderProcessAdmission(request(contenderRoot));held.push(after);assert.ok(after.admitted,'machine slot reclaimed after actual group exit');console.log('PASS natural group exit releases machine capacity for another repo');
} finally {
 if(!providerPid&&!providerGone&&existsSync(identityFile))providerPid=JSON.parse(readFileSync(identityFile,'utf8')).pid;
 if(providerPid){try{process.kill(-providerPid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')console.error('CLEANUP_SIGNAL',e.code);}}
 if(worker?.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');
 held.forEach(a=>api.releaseProviderProcessAdmission(a));os.userInfo=original;syncBuiltinESMExports();rmSync(base,{recursive:true,force:true});
}
