import {defaultHostRunRunner} from '../dist/core/host-run.js';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'proof-resource-release-')),failures=[],pids=[];
const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore',detached:true});
const run=(argv,cwd=root,extra={})=>defaultHostRunRunner({command:process.execPath,argv,cwd,env:process.env,timeoutMs:6000,...extra});
try{
 for(let i=0;i<3;i++){
  const a=mkdtempSync(join(root,'owner-')),b=mkdtempSync(join(root,'consumer-')),ready=join(root,'ready-'+i),done=join(root,'done-'+i),child=join(root,'listener-'+i+'.cjs'),owner=join(root,'owner-'+i+'.cjs'),consumer=join(root,'consumer-'+i+'.cjs');
  writeFileSync(child,`const fs=require('node:fs'),net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({port:server.address().port,pid:process.pid}));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(done)},'natural completion');server.close(()=>process.exit(0));},1800);});`);
  writeFileSync(owner,`const fs=require('node:fs');require('node:child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'ignore'}).unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);console.log(JSON.stringify({type:'result',result:'owner-complete'}));process.exit(0);}},5);`);
  writeFileSync(consumer,`const fs=require('node:fs'),net=require('node:net');const port=JSON.parse(fs.readFileSync(${JSON.stringify(ready)})).port,start=Date.now();function attempt(){const s=net.createServer();s.once('error',e=>{if(e.code!=='EADDRINUSE')throw e;setTimeout(attempt,20);});s.listen(port,'127.0.0.1',()=>{console.log(JSON.stringify({type:'result',result:'consumer-complete',waitMs:Date.now()-start}));s.close();});}attempt();`);
  const start=performance.now();const first=await run([owner],a,{retainUsageLine:()=>true});const firstMs=performance.now()-start;const identity=JSON.parse(readFileSync(ready));pids.push(identity.pid);
  const secondStart=performance.now(),second=await run([consumer],b,{retainUsageLine:()=>true});const secondMs=performance.now()-secondStart;const secondResult=JSON.parse(second.stdout.trim());
  const row={case:i,firstMs,secondMs,totalMs:performance.now()-start,waitMs:secondResult.waitMs,firstExit:first.exitCode,secondExit:second.exitCode,firstResult:JSON.parse(first.stdout.trim()).result,secondResult:secondResult.result,backgroundCompleted:existsSync(done)};console.log('RESOURCE_FLOW_RESULT '+JSON.stringify(row));
  try{assert.equal(first.exitCode,0);assert.equal(second.exitCode,0);assert.equal(row.firstResult,'owner-complete');assert.equal(row.secondResult,'consumer-complete');assert.equal(row.backgroundCompleted,false,'BACKGROUND_RESOURCE_RED: closed-pipe descendant outlived completed host');assert.ok(row.waitMs<500,'RESOURCE_WAIT_RED: next invocation waited for residual resource');assert.equal(process.kill(sentinel.pid,0),true);}catch(e){failures.push(e.message);}
 }
 // Output must arrive before the anchor is killed at normal completion.
 let stdout='',stderr='';const n=2*1024*1024;const bulk=await run(['-e',`process.stdout.write('x'.repeat(${n}));process.stderr.write('y'.repeat(${n}));process.exitCode=7`],root,{onChunk:c=>{if(c.stream==='stdout')stdout+=c.text;else stderr+=c.text;}});
 assert.equal(bulk.exitCode,7);assert.equal(stdout,'x'.repeat(n));assert.equal(stderr,'y'.repeat(n));console.log('PASS exact2MiB stdout and2MiB stderr before normal cleanup '+createHash('sha256').update(stdout+stderr).digest('hex'));
 const samples=[];for(let i=0;i<7;i++){const t=performance.now();const r=await run(['-e','console.log(JSON.stringify({type:"result",result:"ok"}))']);assert.equal(r.exitCode,0);samples.push(performance.now()-t);}console.log('NORMAL_COST_RESULT '+JSON.stringify(samples));
 const oldPath=process.env.PATH,ps=join(root,'ps');writeFileSync(ps,'#!/bin/sh\nexit 1\n');chmodSync(ps,0o700);process.env.PATH=root;
 try{const result=await run(['-e','process.exit(0)']);console.log('UNVERIFIED_CLEANUP_RESULT '+JSON.stringify(result));try{assert.notEqual(result.exitCode,0,'CLEANUP_UNVERIFIED_RED: unverified group cleanup cannot return success');assert.equal(result.terminalReason,'child_error');assert.match(result.stderr,/HOST_GROUP_CLEANUP_UNVERIFIED/);}catch(e){failures.push(e.message);}}finally{if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;}
 assert.deepEqual(failures,[],'BACKGROUND_RESOURCE_RED');console.log('HOST_RESOURCE_RELEASE_GREEN');
}finally{
 for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{}
 const closed=new Promise(r=>sentinel.once('close',r));sentinel.kill('SIGKILL');await closed;rmSync(root,{recursive:true,force:true});
}
