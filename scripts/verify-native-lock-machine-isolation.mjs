import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeLockTestRuntime} from './native-lock-test-runtime.mjs';

const root=mkdtempSync(join(tmpdir(),'native-machine-isolation-control-'));
const release=join(root,'release');
const bootstrap=join(root,'outer-home.mjs');
const core=new URL('../packages/main/dist/core/validation-execution-lock.js',import.meta.url).href;
writeFileSync(bootstrap,`import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(join(root,'outer-home'))}});syncBuiltinESMExports();`);
const outerEnv={...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS??'','--import='+JSON.stringify(bootstrap)].join(' ').trim()};
const isolated=createNativeLockTestRuntime(outerEnv);
let holder,holderClosed=false,holderError,holderExit,holderOutput='';
const started=performance.now();
const options={root,workspaceRoot:root,command:'native machine isolation control'};
try {
 holder=spawn(process.execPath,['--input-type=module','-e',`import {existsSync} from 'node:fs';const {withMachineValidationResources}=await import(${JSON.stringify(core)});await withMachineValidationResources(${JSON.stringify(options)},async()=>{console.log('HOLDER_READY');while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));});`],{env:outerEnv,stdio:['ignore','pipe','pipe']});
 holder.stdout.on('data',x=>{holderOutput+=x;});holder.stderr.on('data',x=>{holderOutput+=x;});
 holder.once('close',(code,signal)=>{holderClosed=true;holderExit={code,signal};});holder.once('error',e=>{holderError=e;});
 const deadline=Date.now()+5000;
 while(!holderOutput.includes('HOLDER_READY')) {
  if(holderError)throw holderError;
  assert(!holderClosed&&Date.now()<deadline,'outer control holder must become ready: '+holderOutput);
  await new Promise(r=>setTimeout(r,10));
 }
 const probe=`const {withMachineValidationResources}=await import(${JSON.stringify(core)});try{await withMachineValidationResources({...${JSON.stringify(options)},resources:[{class:'fixed-path',key:${JSON.stringify(root)},access:'exclusive'}],deadlineAt:Date.now()+500},()=>console.log('NATIVE_MACHINE_ADMITTED'));}catch(e){console.error('NATIVE_MACHINE_QUEUE_BLOCKED '+String(e));process.exitCode=2;}`;
 const run=(env)=>{
  const start=performance.now();
  try{return {status:0,signal:null,output:execFileSync(process.execPath,['--input-type=module','-e',probe],{env,encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}),elapsedMs:performance.now()-start};}
  catch(e){if(e.code==='ETIMEDOUT')throw new Error('isolation probe transport timeout');return {status:e.status,signal:e.signal,output:String(e.stdout)+String(e.stderr),elapsedMs:performance.now()-start};}
 };
 const shared=run(outerEnv);
 assert.equal(shared.signal,null);assert.equal(shared.status,2,shared.output);
 assert.match(shared.output,/NATIVE_MACHINE_QUEUE_BLOCKED.*workspace validation capacity wait deadline exceeded/);
 assert.doesNotMatch(shared.output,/NATIVE_MACHINE_ADMITTED/);
 const separate=run(isolated.env);
 console.log('NATIVE_MACHINE_ISOLATION_TIMING '+JSON.stringify({shared,separate}));
 assert.equal(separate.signal,null);assert.equal(separate.status,0,'isolated native fixture must not wait on an unrelated machine queue: '+separate.output);
 assert.match(separate.output,/NATIVE_MACHINE_ADMITTED/);
 assert(!holderClosed,'independent fixture succeeds while the outer holder is still active');
 console.log('NATIVE_MACHINE_ISOLATION_PASS: same-pool exclusion and independent-pool progress');
} finally {
 writeFileSync(release,'release');
 const deadline=Date.now()+3000;
 while(holder&&!holderClosed&&!holderError&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 if(holder&&!holderClosed&&!holderError){holder.kill('SIGKILL');const killDeadline=Date.now()+1000;while(!holderClosed&&Date.now()<killDeadline)await new Promise(r=>setTimeout(r,10));}
 if(holder&&!holderClosed&&!holderError)throw new Error('isolation holder cleanup did not observe close; retain runtime');
 isolated.dispose();rmSync(root,{recursive:true,force:true});
 if(holderClosed)assert.deepEqual(holderExit,{code:0,signal:null},'outer queue holder must release and close successfully');
 console.log('NATIVE_MACHINE_ISOLATION_TOTAL '+JSON.stringify({elapsedMs:performance.now()-started}));
}
