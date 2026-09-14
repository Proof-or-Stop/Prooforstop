import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';

// The isolated Finding fixture observes its detached worker before registering it.
// A source hook makes that observation transiently unavailable (every attempt but
// the last) or permanently unavailable. Recovery must complete the workload with
// nothing left fenced; permanent unavailability must refuse the worker, and once
// the launcher has terminated it and its whole group is proven absent, the owned
// pending fence must be withdrawn so the live controller releases cleanly. Real
// controller, queue and fixture; no synthetic ticket, token or kernel observation.
const mode=process.argv[2];assert.ok(['retry','unavailable'].includes(mode),'unknown isolated observation mode');
const repo=process.cwd(),runtime=nestedSourceRuntime(repo),{base,lock,env,writeLoader}=runtime;
const isolation=pathToFileURL(join(repo,'packages/main/src/tasks/isolated-finding-fixture.ts')).href;
const anchor='const observed=observeWithBoundedRetry(()=>observeValidationReservationChild(workerPid!));';
const hook=mode==='retry'
 ?"const observed=observeWithBoundedRetry(()=>{globalThis.__isolatedObserve=(globalThis.__isolatedObserve??0)+1;if(globalThis.__isolatedObserve<delegationPolicy.observationRetries)throw new Error('CONTROLLED_OBSERVATION_UNAVAILABLE');return observeValidationReservationChild(workerPid!);});"
 :"const observed=observeWithBoundedRetry(()=>{globalThis.__isolatedObserve=(globalThis.__isolatedObserve??0)+1;throw new Error('CONTROLLED_OBSERVATION_UNAVAILABLE');});";
writeLoader(`function patch(url,source){if(url!==${JSON.stringify(isolation)})return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==2)throw Error('isolated observation anchor changed');return source.replace(anchor,${JSON.stringify(hook)});}`);
// The fixture admits only allowlisted entry basenames; this generated entry reuses one.
const entry=join(base,'finding-material-reattestation-smoke.js'),outcome=join(base,'worker-outcome');
writeFileSync(join(base,'package.json'),JSON.stringify({type:'module'}));
writeFileSync(entry,`import assert from 'node:assert/strict';import {writeFileSync,existsSync} from 'node:fs';
const {runIsolatedFindingFixture}=await import(${JSON.stringify(isolation)});const {withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});
const {VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY:policy}=await import(${JSON.stringify(lock.replace('validation-execution-lock.ts','runtime-fact-registry.ts'))});
// The worker wrapper records its outcome after this module finishes, so the worker branch returns instead of exiting.
if(process.argv.includes('--isolated-finding-fixture-worker')){writeFileSync(${JSON.stringify(outcome)},'worker ran');}
else{
let fixtureError;
await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'isolated observation control',deadlineAt:Date.now()+20000},async()=>{
 try{await runIsolatedFindingFixture(import.meta.url);}catch(error){fixtureError=error;}
});
if(${JSON.stringify(mode)}==='retry'){assert.equal(fixtureError,undefined,'transient observation failure must recover: '+String(fixtureError));assert.equal(globalThis.__isolatedObserve,policy.observationRetries,'recovery consumes every attempt but the last');assert.equal(existsSync(${JSON.stringify(outcome)}),true,'worker must have run after recovery');console.log('ISOLATED_OBSERVATION_RETRY_RECOVERED');}
else{assert.ok(fixtureError,'permanently unavailable observation must refuse the worker');assert.equal(globalThis.__isolatedObserve,policy.observationRetries,'refusal uses every attempt');assert.equal(existsSync(${JSON.stringify(outcome)}),false,'refused worker must not enter its workload');console.log('ISOLATED_OBSERVATION_UNAVAILABLE_WITHDRAWN');}
console.log('ISOLATED_OBSERVATION_CONTROL '+${JSON.stringify(mode)}+' PASS');
}`);
try{const child=spawnSync(process.execPath,[entry],{env,encoding:'utf8',timeout:40000,maxBuffer:128*1024});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');assert.equal(child.status,0,'ISOLATED_OBSERVATION_CONTROL '+mode);
 if(mode==='unavailable'){assert.doesNotMatch(child.stdout+child.stderr,/owned group cleanup unproven/,'withdrawn fence must let the live controller release cleanly');}}
finally{rmSync(base,{recursive:true,force:true});}
