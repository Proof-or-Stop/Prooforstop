import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NATIVE_FIXTURE_CLI_TIMEOUT_MS} from '../packages/main/dist/tasks/native-lock-fixture.js';
import {createNativeLockTestRuntime} from './native-lock-test-runtime.mjs';
import {observeFixtureCoordination, assertFixtureCoordinationRemoved, assertObservedCoordinationAliases} from './fixture-coordination-observation.mjs';

const root=mkdtempSync(join(tmpdir(),'native-machine-isolation-control-'));
const release=join(root,'release');
const bootstrap=join(root,'outer-home.mjs');
const core=new URL('../packages/main/dist/core/validation-execution-lock.js',import.meta.url).href;
writeFileSync(bootstrap,`import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(join(root,'outer-home'))}});syncBuiltinESMExports();`);
const outerEnv={...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS??'','--import='+JSON.stringify(bootstrap)].join(' ').trim()};
const isolated=createNativeLockTestRuntime(outerEnv);
let holder,holderClosed=false,holderError,holderExit,holderOutput='';
let primaryFailed=false;
let observedTargets=[];
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
 const cliPath=fileURLToPath(new URL('../bin/proof-or-stop.js',import.meta.url));
 const fixtureModule=new URL('../packages/main/dist/tasks/native-lock-fixture.js',import.meta.url).href;
 const observation=join(isolated.root,'actual-cli-namespace.json');
 const observer=join(isolated.root,'observe-cli.mjs');
 writeFileSync(observer,`import {writeFileSync} from 'node:fs';import {userInfo} from 'node:os';if(process.argv[1]===${JSON.stringify(cliPath)})writeFileSync(${JSON.stringify(observation)},JSON.stringify({pid:process.pid,cli:process.argv[1],home:userInfo().homedir}));`);
 const cliEnvironment={...isolated.env,NODE_OPTIONS:isolated.env.NODE_OPTIONS+' --import='+JSON.stringify(observer)};
 const cliProgram=`import {realpathSync} from 'node:fs';const f=await import(${JSON.stringify(fixtureModule)});const c=await import(${JSON.stringify(core)});const root=f.allocateNativeLockRoot();try{await c.withWorkspaceValidationCapacity({root,workspaceRoot:root,command:'actual native fixture alias proof',deadlineAt:Date.now()+5000},()=>console.log('COORDINATION_ALIAS_TARGET '+JSON.stringify(realpathSync(c.validationCapacityLockPath(root)))));console.log('NATIVE_CLI_PARENT_PID '+process.pid);console.log(f.lockFixtureCli(root,'B-namespace-proof','--version',{}));}finally{f.releaseNativeLockRoot(root);}`;
 const cliStarted=performance.now();
 const cliOutput=execFileSync(process.execPath,['--input-type=module','-e',cliProgram],{env:cliEnvironment,encoding:'utf8',timeout:NATIVE_FIXTURE_CLI_TIMEOUT_MS+10000,stdio:['ignore','pipe','pipe']});
 assert.match(cliOutput,/Proof-or-Stop \d+\.\d+\.\d+/);
 observedTargets=observeFixtureCoordination(isolated,1);
 assertObservedCoordinationAliases(cliOutput,observedTargets,1);
 const observed=JSON.parse(readFileSync(observation,'utf8'));
 assert.equal(observed.cli,cliPath);assert.equal(observed.home,join(isolated.root,'home'));
 const parentPid=Number(cliOutput.match(/NATIVE_CLI_PARENT_PID (\d+)/)?.[1]);assert(parentPid>0&&observed.pid>0);assert.notEqual(observed.pid,parentPid,'the observation must come from the actual CLI descendant');
 assert(!holderClosed,'actual CLI environment proof runs while the outer queue remains held');
 console.log('NATIVE_LOCK_CLI_NAMESPACE_TIMING '+JSON.stringify({elapsedMs:performance.now()-cliStarted,parentPid,cliPid:observed.pid}));
 console.log('NATIVE_MACHINE_ISOLATION_PASS: same-pool exclusion and independent-pool progress');
} catch(error){primaryFailed=true;throw error;} finally {
 try {
 writeFileSync(release,'release');
 const deadline=Date.now()+3000;
 while(holder&&!holderClosed&&!holderError&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 if(holder&&!holderClosed&&!holderError){holder.kill('SIGKILL');const killDeadline=Date.now()+1000;while(!holderClosed&&Date.now()<killDeadline)await new Promise(r=>setTimeout(r,10));}
 if(holder&&!holderClosed&&!holderError)throw new Error('isolation holder cleanup did not observe close; retain runtime');
 isolated.dispose();assertFixtureCoordinationRemoved(isolated,observedTargets);rmSync(root,{recursive:true,force:true});
 if(holderClosed)assert.deepEqual(holderExit,{code:0,signal:null},'outer queue holder must release and close successfully');
 } catch(error){if(!primaryFailed)throw error;console.error('NATIVE_MACHINE_ISOLATION_CLEANUP_WARNING '+String(error));}
 finally {console.log('NATIVE_MACHINE_ISOLATION_TOTAL '+JSON.stringify({elapsedMs:performance.now()-started}));}
}
