import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const driver=fileURLToPath(new URL('./verify-native-lock-prerequisites.mjs',import.meta.url));
const scratch=mkdtempSync(join(tmpdir(),'native-driver-signal-proof-'));
try {
 const preload=join(scratch,'deny-first-signal.mjs');
 writeFileSync(preload,"const kill=process.kill;let denied=false;process.kill=function(pid,signal){if(pid<0&&signal==='SIGTERM'&&!denied){denied=true;throw Object.assign(new Error('controlled signal denial'),{code:'EPERM'});}return kill.call(this,pid,signal);};");
 for(const [signal,deny] of [['SIGTERM',false],['SIGINT',false],['SIGTERM',true]]) {
  const started=performance.now();let output='',sent=false;
  const child=spawn(process.execPath,[...(deny?['--import',preload]:[]),driver,'--signal-contract-child'],{stdio:['ignore','pipe','pipe']});
  let timedOut=false;
  const timer=setTimeout(()=>{
   timedOut=true;child.kill('SIGKILL');
   const pid=Number(output.match(/NATIVE_DRIVER_CHILD (\d+)/)?.[1]);
   if(pid)try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')console.error(String(error));}
  },15000);
  const collect=chunk=>{output+=chunk.toString();if(!sent&&/NATIVE_DRIVER_CHILD \d+/.test(output)){sent=true;child.kill(signal);}};
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  child.once('exit',code=>{
   if(code===(signal==='SIGTERM'?143:130))return;
   const pid=Number(output.match(/NATIVE_DRIVER_CHILD (\d+)/)?.[1]);
   if(pid)try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')console.error(String(error));}
  });
  let result;
  try {
  try {result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});}
  finally {clearTimeout(timer);}
  assert.equal(timedOut,false,'signal witness transport deadline: '+output);assert.equal(result.signal,null,output);assert.equal(result.code,signal==='SIGTERM'?143:130,output);
  const root=output.match(/NATIVE_DRIVER_RUNTIME (.+)/)?.[1];assert(root,output);assert.equal(existsSync(root),false,'reaped driver must dispose its runtime');
  const pid=Number(output.match(/NATIVE_DRIVER_CHILD (\d+)/)?.[1]);assert(pid>0,output);
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH','driver must observe child exit before deleting runtime');
  if(deny)assert.match(output,/NATIVE_DRIVER_SIGNAL_WARNING/);
  console.log('NATIVE_DRIVER_SIGNAL_TIMING '+JSON.stringify({requestedSignal:signal,deny,elapsedMs:performance.now()-started,...result}));
  } finally {
   // Also clean the controlled old-code failure witness; do not orphan its child.
   const pid=Number(output.match(/NATIVE_DRIVER_CHILD (\d+)/)?.[1]);
   let gone=!pid;
   if(pid){try{process.kill(pid,'SIGKILL');}catch(error){if(error.code==='ESRCH')gone=true;else throw error;}}
   for(let i=0;!gone&&i<100;i++){await new Promise(resolve=>setTimeout(resolve,10));try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')gone=true;else throw error;}}
   const root=output.match(/NATIVE_DRIVER_RUNTIME (.+)/)?.[1];
   if(gone&&root)rmSync(root,{recursive:true,force:true});
  }
 }
 console.log('NATIVE_DRIVER_SIGNALS_PASS real TERM INT and denied-signal escalation cleanup');
} finally {rmSync(scratch,{recursive:true,force:true});}
