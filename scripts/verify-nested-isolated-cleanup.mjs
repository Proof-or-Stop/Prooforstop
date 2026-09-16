import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
const repo=process.cwd(),{base,env,writeLoader}=nestedSourceRuntime(repo);
const entry=join(base,'finding-material-reattestation-smoke.js'),record=join(base,'orphan.pid');
const nonIsolated=process.argv.includes('--non-isolated'), primaryFailure=process.argv.includes('--primary-failure'), unclearable=process.argv.includes('--unclearable');
const signalAttempt=join(base,'unproven-group-signal');
const isolation=pathToFileURL(join(repo,'packages/main/src/tasks/isolated-finding-fixture.ts')).href;
if(nonIsolated)writeLoader(`function patch(url,source){if(url!==${JSON.stringify(isolation)})return source;const spawnAnchor='{detached:true, stdio:validationReservationChildStdio';const signalAnchor='process.kill(-workerIdentity.pgid,signal)';if(source.split(spawnAnchor).length!==2||source.split(signalAnchor).length!==2)throw Error('isolated observation anchors changed');return "import {writeFileSync as diagnosticWrite} from 'node:fs';\\n"+source.replace(spawnAnchor,'{detached:false, stdio:validationReservationChildStdio').replace(signalAnchor,${JSON.stringify("diagnosticWrite("+JSON.stringify(signalAttempt)+",'attempted')")});}`);
// --unclearable stands in for a residual the kernel does not clear within the budget: the fixture's own group
// signals are recorded instead of delivered, so the refusal must still fire and the orphan must still be observable.
if(unclearable)writeLoader(`function patch(url,source){if(url!==${JSON.stringify(isolation)})return source;const signalAnchor='process.kill(-workerIdentity.pgid,signal)';if(source.split(signalAnchor).length!==2)throw Error('isolated signal anchor changed');return "import {appendFileSync as __recordSignal} from 'node:fs';"+source.replace(signalAnchor,"__recordSignal("+JSON.stringify(${JSON.stringify(signalAttempt)})+",signal+' ')");}`);
writeFileSync(join(base,'package.json'),JSON.stringify({type:'module'}));
writeFileSync(entry,`import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const {runIsolatedFindingFixture}=await import(${JSON.stringify(isolation)});if(!process.argv.includes('--isolated-finding-fixture-worker')){try{await runIsolatedFindingFixture(import.meta.url);console.log('ISOLATED_FIXTURE_PASSED_AFTER_GROUP_CLEARED');}catch(error){console.error(error.message);const refused=/isolated Finding fixture cleanup unproven/.test(error.message);if(${primaryFailure}){assert.match(error.message,/isolated Finding fixture failed with exit 1/);if(refused)assert.equal(error.cause?.message,'isolated Finding fixture failed with exit 1');}else if(!refused)throw error;console.log(refused?'LOCAL_ISOLATED_CLEANUP_REFUSED':'LOCAL_ISOLATED_PRIMARY_FAILURE_ONLY');process.exitCode=1;}}else{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:false});await new Promise(r=>child.once('spawn',r));writeFileSync(${JSON.stringify(record)},String(child.pid));if(${primaryFailure})throw Error('ORIGINAL_WORKER_FAILURE');}`);
let child,orphan,identity,output='';
const startOf=pid=>{try{return execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000}).trim()||null;}catch{return null;}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 child=spawn(process.execPath,[entry],{env:{...env,TMPDIR:base},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('cleanup diagnostic transport timeout')),10000);child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
 console.log(output);
 if(nonIsolated){assert.match(output,/isolated worker group identity unavailable/,'a worker observed outside its own group must be refused at observation');assert.equal(existsSync(signalAttempt),false,'no group signal may be attempted without an observed own-leader identity');assert.equal(existsSync(record),false,'worker workload entered after invalid group observation');assert.match(output,/LOCAL_ISOLATED_CLEANUP_REFUSED/);assert.equal(result.code,1);console.log('NON_ISOLATED_GROUP_NEVER_SIGNALED PASS');}else if(unclearable){
 assert.ok(existsSync(record),'fixture orphan must be created');orphan=Number(readFileSync(record,'utf8'));assert.ok(Number.isSafeInteger(orphan)&&orphan>1);identity=startOf(orphan);assert.ok(identity,'orphan must still be observable to exercise refusal');
 assert.ok(existsSync(signalAttempt),'the fixture must have attempted its own group signals');const attempts=readFileSync(signalAttempt,'utf8');assert.match(attempts,/SIGTERM/);assert.match(attempts,/SIGKILL/);
 assert.match(output,/LOCAL_ISOLATED_CLEANUP_REFUSED/,'ISOLATED_FIXTURE_MUST_OBSERVE_GROUP_ABSENCE');assert.equal(result.code,1);assert.equal(result.signal,null);assert.doesNotMatch(output,/ISOLATED_FIXTURE_PASSED_AFTER_GROUP_CLEARED/);
 console.log('ISOLATED_FIXTURE_GROUP_ABSENCE_REQUIRED PASS');
}else{
 assert.ok(existsSync(record),'fixture orphan must be created');orphan=Number(readFileSync(record,'utf8'));assert.ok(Number.isSafeInteger(orphan)&&orphan>1);identity=startOf(orphan);
 assert.equal(identity,null,'the lingering same-group orphan must be cleared by the fixture before it returns');assert.doesNotMatch(output,/cleanup unproven/,'a cleared group must not be reported as unproven');
 if(primaryFailure){assert.match(output,/LOCAL_ISOLATED_PRIMARY_FAILURE_ONLY/);assert.equal(result.code,1);}else{assert.match(output,/ISOLATED_FIXTURE_PASSED_AFTER_GROUP_CLEARED/);assert.equal(result.code,0);}
 console.log('ISOLATED_FIXTURE_GROUP_CLEARED PASS');}
}finally {
 if(!orphan&&existsSync(record)){orphan=Number(readFileSync(record,'utf8'));identity=startOf(orphan);}
 if(orphan&&identity&&startOf(orphan)===identity){try{process.kill(orphan,'SIGTERM');}catch{}}
 const until=Date.now()+2000;while(orphan&&identity&&startOf(orphan)===identity&&Date.now()<until)await wait(20);
 assert.ok(!orphan||!identity||startOf(orphan)!==identity,'own orphan cleanup unproven; private artifacts retained');
 if(child?.exitCode===null)child.kill('SIGTERM');rmSync(base,{recursive:true,force:true});
}
