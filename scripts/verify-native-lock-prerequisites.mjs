import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createNativeLockTestRuntime} from './native-lock-test-runtime.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
let active;
let stopping=false;
let stopCode;
let escalation;
let reapDeadline;
function signalChild(signal){if(!active?.pid)return;try{if(process.platform==='win32')active.kill(signal);else process.kill(-active.pid,signal);}catch(error){if(error.code!=='ESRCH')console.error('NATIVE_DRIVER_SIGNAL_WARNING '+String(error));}}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
 if(stopping)return;stopping=true;stopCode=signal==='SIGTERM'?143:130;process.exitCode=stopCode;signalChild(signal);
 escalation=setTimeout(()=>{
  signalChild('SIGKILL');
  reapDeadline=setTimeout(()=>{
   // Never remove the bootstrap beneath an unobserved live child.
   if(active)console.error('NATIVE_DRIVER_UNREAPED: retaining runtime '+fixtureRuntime.root);
   else {try{fixtureRuntime.dispose();}catch(error){console.error('NATIVE_DRIVER_CLEANUP_WARNING '+String(error));}}
   process.exit(stopCode);
  },2000);
 },5000);
});
// The official Lab harness owns the total budget. Individual native CLI calls
// remain bounded; no smaller synchronous step watchdog can orphan the smoke.
const fixtureRuntime=createNativeLockTestRuntime();
const signalContract=process.argv.includes('--signal-contract-child');
if(signalContract)console.log('NATIVE_DRIVER_RUNTIME '+fixtureRuntime.root);
const steps=signalContract?[[process.execPath,['-e',"console.log('NATIVE_DRIVER_CHILD '+process.pid);setInterval(()=>{},1000)"]]]:[
 ['npm',['--prefix','packages/main','run','build']],
 ['npm',['--prefix','packages/utils','run','build']],
 [process.execPath,['scripts/verify-native-driver-signals.mjs']],
 [process.execPath,['scripts/verify-native-lock-machine-isolation.mjs']],
 [process.execPath,['packages/main/dist/tasks/validate-execution-lock-smoke.js','--native-cleanup-contract-only']],
 [process.execPath,['packages/main/dist/tasks/validate-execution-lock-smoke.js','--derived-refusal-contract-only']],
 [process.execPath,['packages/main/dist/tasks/validate-execution-lock-smoke.js','--native-prerequisites-only']],
];
try {
for(const [command,args] of steps) {
 if(stopping)break;
 const started=performance.now();
 const result=await new Promise((resolve,reject)=>{
  active=spawn(command,args,{cwd:root,env:command===process.execPath?fixtureRuntime.env:process.env,stdio:'inherit',detached:process.platform!=='win32'});
  active.once('error',reject);active.once('close',(status,signal)=>{active=undefined;resolve({status,signal});});
 });
 console.log('NATIVE_LOCK_STEP_TIMING '+JSON.stringify({command,args,elapsedMs:performance.now()-started,...result}));
 if(stopping)break;
 assert.equal(result.signal,null,'native verification terminated by signal: '+result.signal);
 assert.equal(result.status,0,command+' native prerequisites verification failed');
}

} finally {clearTimeout(escalation);clearTimeout(reapDeadline);fixtureRuntime.dispose();}
