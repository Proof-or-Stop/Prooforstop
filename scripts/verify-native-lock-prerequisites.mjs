import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('..',import.meta.url));
let active;
let stopping=false;
function signalChild(signal){if(!active?.pid)return;try{if(process.platform==='win32')active.kill(signal);else process.kill(-active.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
 if(stopping)return;stopping=true;signalChild(signal);
 setTimeout(()=>{signalChild('SIGKILL');process.exit(signal==='SIGTERM'?143:130);},5000);
});
// The official Lab harness owns the total budget. Individual native CLI calls
// remain bounded; no smaller synchronous step watchdog can orphan the smoke.
for(const [command,args] of [
 ['npm',['--prefix','packages/main','run','build']],
 ['npm',['--prefix','packages/utils','run','build']],
 [process.execPath,['packages/main/dist/tasks/validate-execution-lock-smoke.js','--native-cleanup-contract-only']],
 [process.execPath,['packages/main/dist/tasks/validate-execution-lock-smoke.js','--derived-refusal-contract-only']],
 [process.execPath,['packages/main/dist/tasks/validate-execution-lock-smoke.js','--native-prerequisites-only']],
]) {
 const started=performance.now();
 const result=await new Promise((resolve,reject)=>{
  active=spawn(command,args,{cwd:root,stdio:'inherit',detached:process.platform!=='win32'});
  active.once('error',reject);active.once('close',(status,signal)=>{active=undefined;resolve({status,signal});});
 });
 console.log('NATIVE_LOCK_STEP_TIMING '+JSON.stringify({command,args,elapsedMs:performance.now()-started,...result}));
 assert.equal(result.signal,null,'native verification terminated by signal: '+result.signal);
 assert.equal(result.status,0,command+' native prerequisites verification failed');
}
