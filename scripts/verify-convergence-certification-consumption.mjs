#!/usr/bin/env node
import { nativeReviewFixtureBrokers, runBrokeredNativeReviewCli } from "../packages/main/dist/tasks/native-review-fixture.js";
import { readConvergenceProgress } from "../packages/main/dist/core/convergence-progress-journal.js";
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from "../packages/main/dist/core/store.js";
import { resetConfigCache } from "../packages/main/dist/core/config.js";
import { finalizedUnconsumedReviewInventory, signReviewInventoryEpoch, signReviewInventoryReceipt } from "../packages/main/dist/core/review-inventory-epoch.js";
import { createReviewInventoryHandlers } from "../packages/main/dist/handlers/review-inventory.js";
import { readOwnerLease, releaseOwnerLease } from "../packages/main/dist/core/story-owner-lease.js";
import { adapterSessionEnv, adapterSessionId } from "../packages/main/dist/tasks/adapter-session-env.js";
import { getSessionId } from "../packages/main/dist/core/owner-session.js";
const storyId = 'B-inventory-handler';
const reviewRound = '2020-01-01T00:00:00.000Z';
const cliPath = fileURLToPath(new URL('../../../../bin/proof-or-stop.js', new URL("../packages/main/dist/tasks/review-inventory-handler-smoke.js", import.meta.url)));
const repositoryRoot = fileURLToPath(new URL('../../../../', new URL("../packages/main/dist/tasks/review-inventory-handler-smoke.js", import.meta.url)));
const isolatedFixtureRoots = new Set();
function releaseCompletedFixtureOwner(root, expectedSessionId) {
    assert.ok(isolatedFixtureRoots.has(root), 'lease handoffs are isolated test fixtures only');
    const storyDir = new StoryStore(root).storyDirPath(storyId);
    const lease = readOwnerLease(storyDir);
    if (lease?.sessionId === expectedSessionId) {
        assert.equal(releaseOwnerLease(storyDir), true, 'completed matching fixture owner releases its lease');
        assert.equal(readOwnerLease(storyDir), null);
    }
}
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function cli(root, command, payload, env = {}) {
    const actor = env.PROOF_OR_STOP_AGENT ?? 'main';
    const task = env.PROOF_OR_STOP_SESSION_ID ?? 'review-inventory-owner';
    try {
        return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(payload)], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ...env,
                PROOF_OR_STOP_AGENT: actor,
                ...adapterSessionEnv(task, actor),
            },
        }).trim();
    }
    finally {
        // The child has completed. Release only its own verified fixture lease.
        releaseCompletedFixtureOwner(root, adapterSessionId(root, task, actor));
    }
}
function setup(author = { name: 'proof-or-stop-implementer', email: 'proof-or-stop-implementer@noreply.local' }, fullEnvelope = false) {
    const root = mkdtempSync(join(tmpdir(), 'review-inventory-handler-'));
    isolatedFixtureRoots.add(root);
    mkdirSync(join(root, 'packages/main/src'), { recursive: true });
    mkdirSync(join(root, 'packages/main/tests'), { recursive: true });
    mkdirSync(join(root, 'docs/requirements/decisions'), { recursive: true });
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
        ...(fullEnvelope ? { promptEnvelope: { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { 'proof-or-stop-review-topology-critic': 'full-envelope' } } } : {}),
        nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
 validate:{commands:[{label:"native-fast",command:process.execPath,args:["--version"],focus:["fast"],timeoutMs:15000}]},
        scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    }));
    writeFileSync(join(root, 'packages/main/src/subject.ts'), 'export const subject = 1;\n');
    writeFileSync(join(root, 'packages/main/src/consumer-a.ts'), "export { subject } from './subject.js';\n");
    writeFileSync(join(root, 'packages/main/src/consumer-b.ts'), "export { subject } from './consumer-a.js';\n");
    writeFileSync(join(root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 1;\n');
    writeFileSync(join(root, 'docs/requirements/decisions/inventory.md'), '# Review inventory\n');
    writeFileSync(join(root, 'docs/requirements/decisions/inventory-secondary.md'), '# Review inventory supplementary\n');
    for (const name of ['almanac', 'beacon', 'compass', 'dossier', 'ledger', 'notebook']) {
        writeFileSync(join(root, `docs/requirements/decisions/${name}.md`), `# ${name}\nUnrelated fixture material.\n`);
    }
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['config', 'user.name', author.name]);
    git(root, ['config', 'user.email', author.email]);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'initial']);
    resetConfigCache();
    const store = new StoryStore(root);
    const story = {
        storyId, name: 'inventory-handler-smoke', title: 'Inventory handler smoke',
        description: 'Exercise real review inventory handler persistence and fail-closed paths.',
        type: 'chore', phase: 'REVIEW', priority: 'high', createdAt: reviewRound,
        startedAt: reviewRound, endedAt: null, currentReviewRound: reviewRound,
        events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
    };
    store.writeStory(storyId, story);
    // Main added a DEV-door preflight ack (B-a7c5). Write it here so later
    // story_advance DEV assertions observe inventory/cutoff behavior, not
    // missing_dev_memory_preflight_ack.
    store.writeDevMemoryPreflightAck(storyId, {
        schemaVersion: 'proof-or-stop.dev_memory_preflight_ack.v1',
        storyId,
        packDigest: 'review-inventory-handler-smoke-synthetic-digest',
        topHitIds: [],
        acknowledgedAt: reviewRound,
        acknowledgedBy: 'review-inventory-handler-smoke',
    });
    store.writeChecklist(storyId, { items: [
            { id: 'CHK-001', title: 'Synthetic handler coverage', context: 'real handler smoke', status: 'done', files: [
                    'packages/main/src/subject.ts',
                    'packages/main/src/consumer-a.ts',
                    'packages/main/src/consumer-b.ts',
                    'packages/main/src/opaque.ts',
                    'packages/main/tests/isolated.test.ts',
                ] },
        ] });
    const handlers = createReviewInventoryHandlers({ root, scanRoot: join(root, 'packages/main'), store });
    return { root, store, handlers: new Proxy(handlers, {
            get(target, key, receiver) {
                const handler = Reflect.get(target, key, receiver);
                if (typeof handler !== 'function')
                    return handler;
                return (...args) => {
                    try {
                        return Reflect.apply(handler, target, args);
                    }
                    finally {
                        releaseCompletedFixtureOwner(root, getSessionId());
                    }
                };
            },
        }) };
}
// B-29bc: the same production CLI fixture supplies complete signed required
// lanes before critic admission. Host names below describe disposable fixtures,
// not independent-host assurance. Existing topology assertions remain below.

const {runIsolatedFindingFixture}=await import('../packages/main/dist/tasks/isolated-finding-fixture.js');
if(await runIsolatedFindingFixture(import.meta.url)) process.exit(0);
const fixture=setup({name:'Harmonynet',email:'26995688+Harmonynet@users.noreply.github.com'});
console.log('SATURATED_FIXTURE_ROOT '+fixture.root);
try {
const env=(agent,session)=>({PROOF_OR_STOP_AGENT:agent,PROOF_OR_STOP_SESSION_ID:session});
fixture.store.writeChecklist(storyId,{items:[]});
cli(fixture.root,'review_inventory_begin',{storyId},env('main','saturation-owner'));
const epoch=fixture.store.readReviewInventoryEpochs(storyId).epochs.at(-1);
const readManifest={filesReadFully:['packages/main/src/subject.ts'],filesTriagedByName:[],scanEscalationReason:null};
const readEvents=[{path:'packages/main/src/subject.ts',mode:'full',action:'Read',tokenCount:null}];
for(const lane of epoch.requiredLanes){
 const e=env(lane,'saturation-'+lane);cli(fixture.root,'dispatch',{storyId,agentType:lane},e);
 const out=cli(fixture.root,'review_run_start',{storyId,agent:lane},e);const reviewRunId=out.match(/Review run (\S+) started/)?.[1];assert(reviewRunId,out);
 await runBrokeredNativeReviewCli({root:fixture.root,store:fixture.store,storyId,agent:lane,reviewRunId,command:'review_pass_set',payload:{storyId,agent:lane,reviewRunId,note:'Disposable independent required lane inspected the exact current subject with no findings.',readManifest,readEvents}});
 console.log('SATURATION_LANE '+lane);
}
const critic='proof-or-stop-review-topology-critic',ce=env(critic,'saturation-critic');const purpose={reviewPurpose:'inventory-completeness',inventoryEpochId:epoch.epochId};
cli(fixture.root,'dispatch',{storyId,agentType:critic,...purpose},ce);
const co=cli(fixture.root,'review_run_start',{storyId,agent:critic,...purpose},ce);const cr=co.match(/Review run (\S+) started/)?.[1];assert(cr,co);
await runBrokeredNativeReviewCli({root:fixture.root,store:fixture.store,storyId,agent:critic,reviewRunId:cr,command:'review_pass_set',payload:{storyId,agent:critic,reviewRunId:cr,note:'Disposable independent completeness critic inspected all required lanes and exact empty finding set.',readManifest,readEvents}});
console.log(cli(fixture.root,'review_inventory_critic_set',{storyId,epochId:epoch.epochId,reviewRunId:cr,agent:critic,findingDispositions:[]},ce));
console.log(cli(fixture.root,'review_inventory_finalize',{storyId},env('main','saturation-owner')));
console.log('SATURATION_FINALIZED '+JSON.stringify(fixture.store.readReviewInventoryEpochs(storyId)));
const {createCertificationWindowHandlers}=await import("../packages/main/dist/handlers/certification-window.js");
const {isSaturatedReviewInventoryForPrecert,loadReviewInventoryAdmitApis}=await import("../packages/main/dist/core/certification-window.js");
assert(isSaturatedReviewInventoryForPrecert(loadReviewInventoryAdmitApis(),finalizedUnconsumedReviewInventory(fixture.store,storyId),storyId));
console.log('SATURATION_REAL_PAIR PASS');


const caseEnv=env('main','saturation-owner');
const fast=JSON.parse(cli(fixture.root,'validate',{storyId,focus:'fast',json:true},caseEnv));
assert.equal(fast.status,'pass');assert(fast.precertCheapCheckReceipt);
console.log('CONVERGENCE_CONSUMPTION_FAST_SETUP PASS');
const baseline=fixture.store.readReviewInventoryEpochs(storyId);
const before=readConvergenceProgress(fixture.store,storyId,fixture.root);
assert.ok(before.completedEpochBindings.some(row=>row.epochId===epoch.epochId));
for (const kind of ['signature','material','receipt']) {
 const changed=structuredClone(baseline);
 if(kind==='signature') changed.receipts[0]._hash='invalid';
 if(kind==='material') {
  changed.epochs[0].cutoff.materialHash='f'.repeat(64);changed.receipts[0].cutoff.materialHash='f'.repeat(64);
 }
 if(kind==='receipt') changed.receipts[0].coverageDigest='f'.repeat(64);
 if(kind!=='signature') {
  const {_hash:eh,...e}=changed.epochs[0];changed.epochs[0]={...e,_hash:signReviewInventoryEpoch(e)};
  const {_hash:rh,...r}=changed.receipts[0];changed.receipts[0]={...r,_hash:signReviewInventoryReceipt(r)};
 }
 fixture.store.writeReviewInventoryEpochs(storyId,changed);
 assert.throws(()=>readConvergenceProgress(fixture.store,storyId,fixture.root),/Invalid completed|history changed/);
 fixture.store.writeReviewInventoryEpochs(storyId,baseline);
}
assert.deepEqual(readConvergenceProgress(fixture.store,storyId,fixture.root),before);
console.log('CONVERGENCE_CONSUMPTION_TAMPER_CONTROLS PASS');
const admitted=cli(fixture.root,'certification_window_begin',{storyId},caseEnv);
assert.match(admitted,/State: ADMITTED/);
const consumed=fixture.store.readReviewInventoryEpochs(storyId);
assert.ok(consumed.epochs[0].consumedByCertificationWindowId);
assert.equal(consumed.epochs[0].consumedByCertificationWindowId,consumed.receipts[0].consumedByCertificationWindowId);
assert.equal(consumed.epochs[0].consumedAt,consumed.receipts[0].consumedAt);
console.log('CONVERGENCE_CONSUMPTION_NATIVE_ADMISSION PASS');
let completed;
assert.doesNotThrow(()=>{completed=readConvergenceProgress(fixture.store,storyId,fixture.root);}, 'CONVERGENCE_CERTIFICATION_CONSUMPTION: legitimate admission must preserve completed history');
assert.deepEqual(completed.completedEpochBindings,before.completedEpochBindings);
const { assessConvergenceProgressGate }=await import('../packages/main/dist/core/convergence-progress-gate.js');
const progress=assessConvergenceProgressGate(fixture.store,storyId,fixture.root);
assert.equal(progress.blocked,false,JSON.stringify(progress));
console.log('CONVERGENCE_CONSUMPTION_SIGNED_HISTORY_AND_GATE PASS');
git(fixture.root,['add','--',`.proof-or-stop/story/actives/${storyId}/process-events.jsonl`]);
git(fixture.root,['commit','-m','record native admission process events']);
const routine=JSON.parse(cli(fixture.root,'validate',{storyId,json:true},caseEnv));assert.equal(routine.status,'pass');
console.log('CONVERGENCE_CONSUMPTION_ROUTINE_SETUP PASS');
let output='',error='';try{output=cli(fixture.root,'story_advance',{storyId,phase:'TEST'},caseEnv);}catch(e){error=String(e);}
console.log('CONVERGENCE_CONSUMPTION_TRANSITION '+JSON.stringify({output,error}));
assert.doesNotMatch(error,/Convergence completed epoch history changed|Convergence progress unavailable/);
if(error) {
 assert.match(error,/native invocation attestation is missing, stale, replayed, or does not match its signed dispatch/);
 assert.equal(new StoryStore(fixture.root).readStory(storyId).phase,'REVIEW');
 console.log('DOWNSTREAM_NATIVE_CRITIC_BLOCKER remains outside the completed-history Lab');
} else assert.equal(new StoryStore(fixture.root).readStory(storyId).phase,'TEST');
assert.deepEqual(readConvergenceProgress(fixture.store,storyId,fixture.root).completedEpochBindings,before.completedEpochBindings);
console.log('CONVERGENCE_CERTIFICATION_CONSUMPTION GREEN');

} finally { rmSync(fixture.root,{recursive:true,force:true}); }
