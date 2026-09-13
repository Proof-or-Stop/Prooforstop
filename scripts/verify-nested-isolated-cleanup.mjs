import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
const repo=process.cwd(),{base,env,writeLoader}=nestedSourceRuntime(repo);
const entry=join(base,'finding-material-reattestation-smoke.js'),record=join(base,'orphan.pid');
const nonIsolated=process.argv.includes('--non-isolated'), primaryFailure=process.argv.includes('--primary-failure');
const signalAttempt=join(base,'unproven-group-signal');
const isolation=pathToFileURL(join(repo,'packages/main/src/tasks/isolated-finding-fixture.ts')).href;
if(nonIsolated)writeLoader(`function patch(url,source){if(url!==${JSON.stringify(isolation)})return source;const spawnAnchor='{detached:true, stdio:validationReservationChildStdio';const signalAnchor='process.kill(-workerIdentity.pgid,signal)';if(source.split(spawnAnchor).length!==2||source.split(signalAnchor).length!==2)throw Error('isolated observation anchors changed');return "import {writeFileSync as diagnosticWrite} from 'node:fs';\\n"+source.replace(spawnAnchor,'{detached:false, stdio:validationReservationChildStdio').replace(signalAnchor,${JSON.stringify("diagnosticWrite("+JSON.stringify(signalAttempt)+",'attempted')")});}`);
writeFileSync(join(base,'package.json'),JSON.stringify({type:'module'}));
writeFileSync(entry,`import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const {runIsolatedFindingFixture}=await import(${JSON.stringify(isolation)});if(!process.argv.includes('--isolated-finding-fixture-worker')){try{await runIsolatedFindingFixture(import.meta.url);console.log('UNEXPECTED_UNREAPED_FIXTURE_PASS');}catch(error){console.error(error.message);if(!/isolated Finding fixture cleanup unproven/.test(error.message))throw error;if(${primaryFailure}){assert.match(error.message,/isolated Finding fixture failed with exit 1/);assert.equal(error.cause?.message,'isolated Finding fixture failed with exit 1');}console.log('LOCAL_ISOLATED_CLEANUP_REFUSED');process.exitCode=1;}}else{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:false});await new Promise(r=>child.once('spawn',r));writeFileSync(${JSON.stringify(record)},String(child.pid));if(${primaryFailure})throw Error('ORIGINAL_WORKER_FAILURE');}`);
let child,orphan,identity,output='';
const startOf=pid=>{try{return execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000}).trim()||null;}catch{return null;}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 child=spawn(process.execPath,[entry],{env:{...env,TMPDIR:base},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('cleanup diagnostic transport timeout')),10000);child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
 console.log(output);
 if(nonIsolated){assert.equal(existsSync(signalAttempt),false,'unproven group was signaled');assert.equal(existsSync(record),false,'worker workload entered after invalid group observation');assert.match(output,/LOCAL_ISOLATED_CLEANUP_REFUSED/);assert.equal(result.code,1);console.log('NON_ISOLATED_GROUP_NEVER_SIGNALED PASS');}else{
 assert.ok(existsSync(record),'fixture orphan must be created');orphan=Number(readFileSync(record,'utf8'));assert.ok(Number.isSafeInteger(orphan)&&orphan>1);identity=startOf(orphan);assert.ok(identity,'orphan must still be observable to exercise refusal');
 assert.match(output,/LOCAL_ISOLATED_CLEANUP_REFUSED/,'ISOLATED_FIXTURE_MUST_OBSERVE_GROUP_ABSENCE');assert.equal(result.code,1);assert.equal(result.signal,null);assert.doesNotMatch(output,/UNEXPECTED_UNREAPED_FIXTURE_PASS/);
 console.log('ISOLATED_FIXTURE_GROUP_ABSENCE_REQUIRED PASS');}
}finally {
 if(!orphan&&existsSync(record)){orphan=Number(readFileSync(record,'utf8'));identity=startOf(orphan);}
 if(orphan&&identity&&startOf(orphan)===identity){try{process.kill(orphan,'SIGTERM');}catch{}}
 const until=Date.now()+2000;while(orphan&&identity&&startOf(orphan)===identity&&Date.now()<until)await wait(20);
 assert.ok(!orphan||!identity||startOf(orphan)!==identity,'own orphan cleanup unproven; private artifacts retained');
 if(child?.exitCode===null)child.kill('SIGTERM');rmSync(base,{recursive:true,force:true});
}
