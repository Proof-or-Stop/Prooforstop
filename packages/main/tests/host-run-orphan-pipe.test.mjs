import {defaultHostRunRunner} from '../dist/core/host-run.js';
import {mkdtempSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'proof-orphan-pipe-')),failures=[];
const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore',detached:true});
try {
 for(let i=0;i<3;i++){
  const marker=join(root,'finished-'+i),pidFile=join(root,'pid-'+i),parent=join(root,'parent-'+i+'.cjs'),descendant=join(root,'descendant-'+i+'.cjs');
  writeFileSync(descendant,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log('DESCENDANT_READY');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'survived'),2500);`);
  writeFileSync(parent,`require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:['ignore',1,2]}).unref();process.exit(0);`);
  let ready=false;const start=performance.now();const result=await defaultHostRunRunner({command:process.execPath,argv:[parent],cwd:root,env:process.env,timeoutMs:600,onChunk:c=>{if(c.text.includes('DESCENDANT_READY'))ready=true;}});
  const row={case:i,elapsedMs:performance.now()-start,ready,descendantCompleted:existsSync(marker),result};console.log('ORPHAN_RESULT '+JSON.stringify(row));
  try{assert.equal(ready,true);assert.equal(result.exitCode,124);assert.equal(row.descendantCompleted,false,'ORPHAN_PIPE_RED: parent exited but descendant survived deadline');assert.equal(process.kill(sentinel.pid,0),true);}catch(e){failures.push(e.message);}
  if(existsSync(pidFile))try{process.kill(Number(readFileSync(pidFile,'utf8')),'SIGKILL');}catch{}
 }
 const missing=await defaultHostRunRunner({command:join(root,'missing-executable'),argv:[],cwd:root,env:process.env,timeoutMs:2000});assert.equal(missing.terminalReason,'spawn_error');assert.equal(missing.failureKind,'missing_executable');assert.equal(missing.exitCode,1);console.log('PASS missing executable classification');
 const samples=[];
 for(let i=0;i<7;i++){
  let output='';const start=performance.now();const normal=await defaultHostRunRunner({command:process.execPath,argv:['-e','console.log(process.argv[1]);console.error(process.cwd());process.exit(7)','argument with spaces'],cwd:root,env:process.env,timeoutMs:2000,onChunk:c=>{output+=c.text;}});
  samples.push(performance.now()-start);assert.equal(normal.exitCode,7);assert.match(output,/argument with spaces/);assert.ok(output.includes(root));
 }
 console.log('NORMAL_OVERHEAD_RESULT '+JSON.stringify(samples));console.log('PASS argv cwd stdout stderr and nonzero status preserved');
 assert.deepEqual(failures,[],'ORPHAN_PIPE_RED');console.log('HOST_ORPHAN_PIPE_GREEN');
}finally{const closed=new Promise(r=>sentinel.once('close',r));sentinel.kill('SIGKILL');await closed;rmSync(root,{recursive:true,force:true});}
