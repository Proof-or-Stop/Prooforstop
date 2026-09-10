import assert from 'node:assert/strict';import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync,rmSync} from 'node:fs';import {join} from 'node:path';
const repo=process.argv[2]??process.cwd(),root=mkdtempSync(join(os.tmpdir(),'supervisor-boundary-')),home=join(root,'home');mkdirSync(home);const saved=os.userInfo;os.userInfo=(...a)=>({...saved(...a),homedir:home});syncBuiltinESMExports();
const {runBoundedCodexProvider}=await import(repo+'/packages/main/dist/providers/codex-cli.js');const api=await import(repo+'/packages/main/dist/core/provider-process-admission.js');const bin=join(root,'bin');mkdirSync(bin);const shim=join(bin,'codex');const {PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT:cap}=await import(repo+'/packages/main/dist/core/provider-process-registry.js');const held=[];let pgid;
const env={...process.env,PATH:bin+':'+process.env.PATH};const request={provider:'codex',argv:['exec'],cwd:root,timeoutMs:800,maxAttempts:3,env};
const install=body=>{writeFileSync(shim,'#!'+process.execPath+'\n'+body);chmodSync(shim,0o755);};
try{
 const count=join(root,'count');install(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(count)},'x');setInterval(()=>{},1000);`);
 const timed=runBoundedCodexProvider(request);console.log('TIMEOUT',JSON.stringify(timed));assert.equal(timed.attempts,3);assert.equal(timed.replacementSafe,true);assert.equal(readFileSync(count,'utf8'),'xxx');
 // Successful returns and timeout retries must release both registries.
 for(let i=0;i<cap;i++){const a=api.acquireProviderProcessAdmission({root,env,host:'codex',storyId:null,agentType:'release-check'});assert.ok(a.admitted);held.push(a);}held.splice(0).forEach(a=>api.releaseProviderProcessAdmission(a));
 install(`const fs=require('fs');try{fs.writeSync(3,'forged control');process.exitCode=7;}catch{process.stdout.write('fd3-not-inherited');}`);
 const control=runBoundedCodexProvider({...request,timeoutMs:1000});assert.equal(control.exitCode,0);assert.equal(control.replacementSafe,true);console.log('PASS timeout retry and dual release; provider cannot write bridge fd3');
 const identity=join(root,'identity'),runs=join(root,'runs');
 install(`const fs=require('fs'),cp=require('child_process');fs.appendFileSync(${JSON.stringify(runs)},'x');fs.writeFileSync(${JSON.stringify(identity)},cp.execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim());process.stdout.destroy();process.stderr.destroy();process.kill(process.ppid,'SIGKILL');setInterval(()=>{},1000);`);
 const retained=api.acquireProviderProcessAdmission({root,env,host:'codex',storyId:null,agentType:'retained-handle'});assert.ok(retained.admitted);
 const absent=runBoundedCodexProvider({...request,timeoutMs:1000,admission:retained});pgid=Number(readFileSync(identity,'utf8'));console.log('NO_CONTROL',JSON.stringify(absent));assert.equal(absent.replacementSafe,false);assert.equal(absent.timedOut,false,'external bridge SIGKILL is not a deadline');assert.equal(absent.attempts,1);assert.equal(readFileSync(runs,'utf8'),'x');
 const reused=runBoundedCodexProvider({...request,admission:retained});assert.equal(reused.replacementSafe,false);assert.equal(readFileSync(runs,'utf8'),'x','unsafe handle cannot launch another group');
 process.kill(-pgid,0);
 for(let i=0;i<cap-1;i++){const a=api.acquireProviderProcessAdmission({root,env,host:'codex',storyId:null,agentType:'retention-check'});assert.ok(a.admitted);held.push(a);}
 const refused=api.acquireProviderProcessAdmission({root,env,host:'codex',storyId:null,agentType:'must-refuse'});assert.equal(refused.admitted,false);console.log('PASS missing control prevents retry and retains live group machine slot');
}finally{if(pgid){try{process.kill(-pgid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')console.error('cleanup',e.code);}}held.forEach(a=>api.releaseProviderProcessAdmission(a));os.userInfo=saved;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
