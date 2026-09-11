import {defaultHostRunRunner} from '../dist/core/host-run.js';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
if(process.platform==='win32') throw new Error('This POSIX process-group regression is not a Windows claim');
const root=mkdtempSync(join(tmpdir(),'proof-host-descendants-')),failures=[];
const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore',detached:true});
const waitExit=child=>new Promise(resolve=>child.once('close',resolve));
try {
 for(let i=0;i<3;i++) {
  const marker=join(root,`finished-${i}`),pidFile=join(root,`pid-${i}`),parent=join(root,`parent-${i}.cjs`),child=join(root,`child-${i}.cjs`);
  writeFileSync(child,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log('READY');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'completed after timeout'),2500);`);
  writeFileSync(parent,`require('node:child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:['ignore',1,2]});setInterval(()=>{},10000);`);
  let ready=false;const start=performance.now();
  const result=await defaultHostRunRunner({command:process.execPath,argv:[parent],cwd:root,env:process.env,timeoutMs:600,onChunk:chunk=>{if(chunk.text.includes('READY'))ready=true;}});
  const row={case:i,elapsedMs:performance.now()-start,ready,result,descendantCompleted:existsSync(marker)};console.log('RECOVERY_RESULT '+JSON.stringify(row));
  try {
   assert.equal(ready,true,'fixture must start before its deadline');assert.equal(result.exitCode,124);assert.equal(result.timedOut,true);
   assert.equal(row.descendantCompleted,false,'HOST_DESCENDANT_TIMEOUT_RED: descendant survived host timeout');
   assert.equal(process.kill(sentinel.pid,0),true,'unrelated process group remains alive');
  } catch(e){failures.push(e.message);}
  if(existsSync(pidFile))try{process.kill(Number(readFileSync(pidFile,'utf8')),'SIGKILL');}catch{}
 }
 const normal=await defaultHostRunRunner({command:process.execPath,argv:['-e','console.log(JSON.stringify({type:"result",result:"ok"}))'],cwd:root,env:process.env,timeoutMs:2000,retainUsageLine:()=>true});
 assert.equal(normal.exitCode,0);assert.equal(normal.timedOut,false);assert.match(normal.stdout,/"ok"/);console.log('PASS normal host result and unrelated process group preserved');
 const abort=new AbortController();let ready=false;
 const stopped=await defaultHostRunRunner({command:process.execPath,argv:['-e','console.log("READY");setInterval(()=>{},10000)'],cwd:root,env:process.env,signal:abort.signal,onChunk:()=>{ready=true;abort.abort();}});
 assert.equal(ready,true);assert.equal(stopped.terminalReason,'aborted');assert.notEqual(stopped.exitCode,0);console.log('PASS explicit cancellation preserves aborted result');
 assert.deepEqual(failures,[],'HOST_DESCENDANT_TIMEOUT_RED');console.log('HOST_DESCENDANTS_GREEN');
} finally {
 const closed=waitExit(sentinel);sentinel.kill('SIGKILL');await closed;rmSync(root,{recursive:true,force:true});
}
