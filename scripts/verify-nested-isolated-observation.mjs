import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';

// The isolated Finding fixture observes its detached worker before its launcher registers it.
// A source hook makes that observation transiently unavailable (every attempt but
// the last) or permanently unavailable. Recovery must complete the workload with
// nothing left fenced; permanent unavailability must refuse the worker, and once
// the launcher has terminated it and its whole group is proven absent, the fence the
// launcher owns must be withdrawn so the live controller releases cleanly. The
// worker-spawn-failure mode fails the launcher's own spawn call: no worker exists, the
// launcher withdraws the fence it marked, and the machine ticket must still release.
// Real controller, queue and fixture; no synthetic ticket, token or kernel observation.
const mode=process.argv[2];assert.ok(['retry','unavailable','unavailable-no-token','worker-spawn-failure'].includes(mode),'unknown isolated observation mode');
const repo=process.cwd(),runtime=nestedSourceRuntime(repo),{base,lock,env,writeLoader}=runtime;
const isolation=pathToFileURL(join(repo,'packages/main/src/tasks/isolated-finding-fixture.ts')).href;
// The spawn-failure mode replaces the executable of the launcher's worker spawn call inside the
// fixture's launcher template; every other mode hooks the parent's worker observation.
const spawnAnchor="spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(code)}, String(process.pid)]";
const spawnHook="spawn('/definitely-absent-isolated-worker-executable', ['--input-type=module', '--eval', ${JSON.stringify(code)}, String(process.pid)]";
const anchor=mode==='worker-spawn-failure'?spawnAnchor:'observed=observeWithBoundedRetry(()=>observeValidationReservationChild(workerPid!));';
const hook=mode==='worker-spawn-failure'?spawnHook:mode==='retry'
 ?"observed=observeWithBoundedRetry(()=>{globalThis.__isolatedObserve=(globalThis.__isolatedObserve??0)+1;if(globalThis.__isolatedObserve<delegationPolicy.observationRetries)throw new Error('CONTROLLED_OBSERVATION_UNAVAILABLE');return observeValidationReservationChild(workerPid!);});"
 :"observed=observeWithBoundedRetry(()=>{globalThis.__isolatedObserve=(globalThis.__isolatedObserve??0)+1;throw new Error('CONTROLLED_OBSERVATION_UNAVAILABLE');});";
writeLoader(`function patch(url,source){if(url!==${JSON.stringify(isolation)})return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==2)throw Error('isolated observation anchor changed');return source.replace(anchor,${JSON.stringify(hook)});}`);
// The fixture admits only allowlisted entry basenames; this generated entry reuses one.
const entry=join(base,'finding-material-reattestation-smoke.js'),outcome=join(base,'worker-outcome');
writeFileSync(join(base,'package.json'),JSON.stringify({type:'module'}));
writeFileSync(entry,`import assert from 'node:assert/strict';import {writeFileSync,existsSync,readdirSync} from 'node:fs';import {join} from 'node:path';
const {runIsolatedFindingFixture}=await import(${JSON.stringify(isolation)});const {withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});
const {VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY:policy}=await import(${JSON.stringify(lock.replace('validation-execution-lock.ts','runtime-fact-registry.ts'))});
// The worker wrapper records its outcome after this module finishes, so the worker branch returns instead of exiting.
if(process.argv.includes('--isolated-finding-fixture-worker')){writeFileSync(${JSON.stringify(outcome)},'worker ran');}
else{
let fixtureError;
if(${JSON.stringify(mode)}==='unavailable-no-token'){
 // No reservation is borrowed, so the fixture must degrade: the worker runs and cleanup stays best-effort.
 try{await runIsolatedFindingFixture(import.meta.url);}catch(error){fixtureError=error;}
 assert.equal(fixtureError,undefined,'unobservable worker without a borrowed reservation must degrade: '+String(fixtureError));assert.equal(globalThis.__isolatedObserve,policy.observationRetries,'degradation still uses every attempt');assert.equal(existsSync(${JSON.stringify(outcome)}),true,'worker must run when no reservation is borrowed');console.log('ISOLATED_OBSERVATION_UNAVAILABLE_NO_TOKEN_DEGRADED');
}else if(${JSON.stringify(mode)}==='worker-spawn-failure'){
 // The launcher's spawn call fails, so no worker ever exists: the launcher withdraws the fence it
 // marked and the live controller releases its ticket cleanly instead of wedging the pool.
 const tickets=()=>{const pool=join(${JSON.stringify(base)},'home','.proof-or-stop','locks','machine-fixed-port-capacity');return existsSync(pool)?readdirSync(pool).filter(name=>name.endsWith('.ticket')):[];};
 let release;
 try{await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'isolated worker spawn failure control',deadlineAt:Date.now()+20000},async()=>{
  try{await runIsolatedFindingFixture(import.meta.url);}catch(error){fixtureError=error;}
 });}catch(error){release=error;}
 assert.equal(release,undefined,'a failed worker spawn must leave no fence behind: '+String(release));
 assert.ok(fixtureError,'a failed worker spawn must fail the fixture');
 assert.match(String(fixtureError.message),/isolated fixture worker spawn failed/,'the fixture must name the failed spawn: '+String(fixtureError.message));
 assert.doesNotMatch(String(fixtureError.message),/cleanup unproven/,'no worker was spawned, so cleanup is proven: '+String(fixtureError.message));
 assert.equal(existsSync(${JSON.stringify(outcome)}),false,'no worker may enter its workload');
 assert.equal(tickets().length,0,'released ticket must be gone');
 console.log('ISOLATED_OBSERVATION_WORKER_SPAWN_FAILURE_RELEASED');
}else{
await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'isolated observation control',deadlineAt:Date.now()+20000},async()=>{
 try{await runIsolatedFindingFixture(import.meta.url);}catch(error){fixtureError=error;}
});
}
if(['unavailable-no-token','worker-spawn-failure'].includes(${JSON.stringify(mode)})){}
else if(${JSON.stringify(mode)}==='retry'){assert.equal(fixtureError,undefined,'transient observation failure must recover: '+String(fixtureError));assert.equal(globalThis.__isolatedObserve,policy.observationRetries,'recovery consumes every attempt but the last');assert.equal(existsSync(${JSON.stringify(outcome)}),true,'worker must have run after recovery');console.log('ISOLATED_OBSERVATION_RETRY_RECOVERED');}
else{assert.ok(fixtureError,'permanently unavailable observation must refuse the worker');assert.equal(globalThis.__isolatedObserve,policy.observationRetries,'refusal uses every attempt');assert.equal(existsSync(${JSON.stringify(outcome)}),false,'refused worker must not enter its workload');console.log('ISOLATED_OBSERVATION_UNAVAILABLE_WITHDRAWN');}
console.log('ISOLATED_OBSERVATION_CONTROL '+${JSON.stringify(mode)}+' PASS');
}`);
try{const child=spawnSync(process.execPath,[entry],{env,encoding:'utf8',timeout:40000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'ISOLATED_OBSERVATION_CONTROL '+mode);
 if(mode.startsWith('unavailable')||mode==='worker-spawn-failure'){assert.doesNotMatch(child.stdout+child.stderr,/cleanup unproven/,'no cleanup must stay unproven: '+mode);}
 if(mode==='worker-spawn-failure'){assert.match(child.stdout+child.stderr,/definitely-absent-isolated-worker-executable/,'the launcher must report the failed spawn call');}}
finally{rmSync(base,{recursive:true,force:true});}
