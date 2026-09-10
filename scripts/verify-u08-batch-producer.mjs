import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {withSignedReviewerBatchFixture}=await import(pathToFileURL(path.join(repo,'scripts/lab/u08-batch-admission/subject-fixture.mjs')));
const base=fs.mkdtempSync(path.join(os.tmpdir(),'u08-native-producer-'));
const producer=path.join(repo,'packages/main/dist/core/reviewer-batch-producer.js');
if(!fs.existsSync(producer))throw new Error('U08_BATCH_PRODUCER_MODULE_MISSING');
execFileSync('cc',[path.join(repo,'scripts/lab/u08-batch-admission/provider-fixture.c'),'-o',path.join(base,'codex')]);
const api=await import(pathToFileURL(producer));
try {
await withSignedReviewerBatchFixture(repo,async({root,store,storyId,begin})=>{begin();const {deriveReviewerBatchSubject}=await import(pathToFileURL(path.join(repo,'packages/main/dist/core/reviewer-batch-subject.js')));const subject=deriveReviewerBatchSubject(store,root,{storyId});const assignments=subject.requiredLanes.map(lane=>({lane,kind:'managed',host:'codex'}));const auth=path.join(root,'auth');fs.mkdirSync(auth,{mode:0o700});fs.writeFileSync(path.join(auth,'auth.json'),JSON.stringify({OPENAI_API_KEY:'fixture-original-token'}));const log=path.join(root,'probes.log');const original={...process.env};Object.assign(process.env,{PATH:base+path.delimiter+process.env.PATH,CODEX_HOME:auth,U08_FIXTURE_MODE:'auth',U08_FIXTURE_PROBE_LOG:log});const request={root,store,storyId,epochId:subject.subject.binding.epochId,wave:subject.subject.binding.wave,assignments};try{const blocked=await api.admitReviewerBatch(request);assert.equal(blocked.state,'BLOCKED',JSON.stringify(blocked));assert.equal(blocked.observations[0].failureKind,'auth');assert.equal((await api.admitReviewerBatch(request)).state,'BLOCKED');let lines=fs.readFileSync(log,'utf8').trim().split('\n');assert.equal(lines.filter(s=>s==='probe').length,1);console.log('PASS actual native supervised auth failure BLOCKED; same identity one probe');process.env.U08_FIXTURE_MODE='ready';const admitted=await api.admitReviewerBatch(request);assert.equal(admitted.state,'ADMITTED',JSON.stringify(admitted));const effectiveBaseEnvironment={...process.env};const consumed=await api.consumeReviewerBatchAdmission({root,store,storyId,lane:assignments[0].lane,host:'codex',profile:'managed_reviewer',effectiveBaseEnvironment});assert.equal(consumed.binding.generation,admitted.generation);
// An actual native READY result above is the authority. Only the observation clock
// moves here; no synthetic READY artifact or caller-authored consumedAt is used.
const reservation={runId:'native-ready-launch',deadlineAt:Date.now()+180000};
api.reserveExecutionBatchLaunch({root,binding:consumed.binding,effectiveBaseEnvironment,...reservation});
api.reserveExecutionBatchLaunch({root,binding:consumed.binding,effectiveBaseEnvironment,...reservation});
const realClock=Date.now;
try {
 Date.now=()=>admitted.expiresAt+1;
 assert.throws(()=>api.verifyExecutionBatchBinding({root,binding:consumed.binding,effectiveBaseEnvironment}),/expired/,'unreserved launches must still obey batch TTL');
 api.verifyExecutionBatchBinding({root,binding:consumed.binding,effectiveBaseEnvironment,launchReservation:reservation});
 api.reserveExecutionBatchLaunch({root,binding:consumed.binding,effectiveBaseEnvironment,...reservation});
 assert.throws(()=>api.reserveExecutionBatchLaunch({root,binding:consumed.binding,effectiveBaseEnvironment,runId:'new-after-expiry',deadlineAt:reservation.deadlineAt}),/expired/,'expiry cannot issue a new reservation');
 assert.throws(()=>api.verifyExecutionBatchBinding({root,binding:consumed.binding,effectiveBaseEnvironment,launchReservation:{...reservation,deadlineAt:reservation.deadlineAt+1}}),/reservation/,'sealed deadline is exact');
 assert.throws(()=>api.verifyExecutionBatchBinding({root,binding:consumed.binding,effectiveBaseEnvironment,launchReservation:{...reservation,runId:'other-run'}}),/ENOENT|reservation/,'reservation is not transferable to another run');
 Date.now=()=>reservation.deadlineAt;
 assert.throws(()=>api.verifyExecutionBatchBinding({root,binding:consumed.binding,effectiveBaseEnvironment,launchReservation:reservation}),/expired/,'reservation cannot outlive the bounded run deadline');
} finally {Date.now=realClock;}
console.log('ACTUAL_READY_SIGNED_RESERVATION_TTL_DEADLINE_RUN_ID_PASS');
const binaryBytes=fs.readFileSync(path.join(base,'codex'));
const shadow=path.join(base,'private-launchers');fs.mkdirSync(shadow);fs.copyFileSync('/bin/echo',path.join(shadow,'codex'));
assert.throws(()=>api.verifyExecutionBatchBinding({root,binding:consumed.binding,effectiveBaseEnvironment,actualProviderCwd:root,actualProviderEnvironment:{...effectiveBaseEnvironment,PATH:shadow+path.delimiter+effectiveBaseEnvironment.PATH}}),/shadowed/,'private launcher PATH must not intercept admitted provider');
api.verifyExecutionBatchBinding({root,binding:consumed.binding,effectiveBaseEnvironment,actualProviderCwd:root,actualProviderEnvironment:effectiveBaseEnvironment});
fs.copyFileSync('/bin/echo',path.join(base,'codex'));assert.throws(()=>api.verifyExecutionBatchBinding({root,binding:consumed.binding,effectiveBaseEnvironment}),/runtime identity changed/,'U08_WORKER_MUST_REVERIFY_ADMITTED_EXECUTABLE');fs.writeFileSync(path.join(base,'codex'),binaryBytes);
console.log('WORKER_EXECUTABLE_REPLACEMENT_AND_PRIVATE_PATH_SHADOW_REFUSED');
lines=fs.readFileSync(log,'utf8').trim().split('\n');assert.equal(lines.filter(s=>s==='probe').length,2);const bindingPath=path.join(root,'binding.json');fs.writeFileSync(bindingPath,JSON.stringify(consumed.binding));fs.unlinkSync(path.join(auth,'auth.json'));const worker=path.join(root,'verify-seed.mjs');fs.writeFileSync(worker,`import fs from 'node:fs';import {verifyExecutionBatchBinding} from ${JSON.stringify(pathToFileURL(producer).href)};import {materializeManagedProviderState} from ${JSON.stringify(pathToFileURL(path.join(repo,'packages/main/dist/core/managed-review-provider-state.js')).href)};const root=process.argv[2],binding=JSON.parse(fs.readFileSync(process.argv[3]));const result=verifyExecutionBatchBinding({root,binding});const cache=root+'/consumer-cache';fs.mkdirSync(cache,{mode:448});const state=materializeManagedProviderState(cache,result.providerState);if(JSON.parse(fs.readFileSync(state.directory+'/auth.json')).OPENAI_API_KEY!=='fixture-refreshed-token')throw Error('seed not refreshed');console.log('CROSS_PROCESS_REFRESHED_SEED_PASS');`);const out=execFileSync(process.execPath,[worker,root,bindingPath],{cwd:root,env:effectiveBaseEnvironment,encoding:'utf8'});assert.match(out,/CROSS_PROCESS_REFRESHED_SEED_PASS/);assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').filter(s=>s==='probe').length,2);console.log('PASS refreshed admitted seed loads in another process after original auth removal');console.log('U08_BATCH_PRODUCER_NATIVE_PASS');}finally{for(const name of Object.keys(process.env))if(!(name in original))delete process.env[name];Object.assign(process.env,original);}});

} finally { fs.rmSync(base,{recursive:true,force:true}); }
