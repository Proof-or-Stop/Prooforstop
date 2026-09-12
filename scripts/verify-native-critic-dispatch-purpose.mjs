#!/usr/bin/env node
import { nativeReviewFixtureBrokers, runBrokeredNativeReviewCli } from "../packages/main/dist/tasks/native-review-fixture.js";
import {collectReviewerEvidenceState,verifyCurrentReviewerDispatchBinding} from "../packages/main/dist/core/review-run.js";
import {verifyNativeReviewEvidenceBinding} from '../packages/main/dist/core/native-review-evidence.js';
import {evaluateReviewInventoryWave} from '../packages/main/dist/core/review-inventory-epoch.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
function setup(author = { name: 'proof-or-stop-implementer', email: 'proof-or-stop-implementer@noreply.local' }, fullEnvelope = false, historicalRegression = false) {
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
    writeFileSync(join(root, 'packages/main/src/subject.ts'), (historicalRegression ? '// Fixture contract: subject must equal zero.\n' : '') + 'export const subject = 1;\n');
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

const runs=fixture.store.readReviewRuns(storyId).runs;
const run=runs.find(row=>row.reviewRunId===cr);assert(run);
const passes=fixture.store.readReviewPasses(storyId);
const pass=passes.passes.find(row=>row.reviewRunId===cr);assert(pass?.nativeEvidenceBinding,'actual broker attestation must exist');
const args={store:fixture.store,storyId,lane:run.lane,reviewRound:run.reviewRound,projectRoot:fixture.root,reviewPurpose:run.reviewPurpose,inventoryBinding:run.inventoryBinding};
assert.equal(verifyCurrentReviewerDispatchBinding(args).ok,true,'actual signed inventory-purpose dispatch is valid');
assert.equal(verifyCurrentReviewerDispatchBinding({...args,reviewPurpose:'topology',inventoryBinding:undefined}).ok,false,'inventory evidence cannot substitute for topology');
assert.equal(verifyCurrentReviewerDispatchBinding({...args,inventoryBinding:{...run.inventoryBinding,epochId:'B-other:RI-999'}}).ok,false,'different inventory subject must be refused');
const changed=structuredClone(passes);changed.passes.find(row=>row.id===pass.id)._hash='tampered';
try {fixture.store.writeReviewPasses(storyId,changed);assert(collectReviewerEvidenceState(fixture.store,storyId,fixture.root).invalid.some(row=>row.evidenceId===pass.id),'tampered signed pass must be refused');}
finally {fixture.store.writeReviewPasses(storyId,passes);}
console.log('NATIVE_CRITIC_PURPOSE_NEGATIVE_CONTROLS PASS');
const actual=collectReviewerEvidenceState(fixture.store,storyId,fixture.root);
console.log('NATIVE_CRITIC_PURPOSE_OBSERVATION '+JSON.stringify({passId:pass.id,reviewRunId:run.reviewRunId,reviewPurpose:run.reviewPurpose,invalid:actual.invalid}));
assert.equal(actual.invalid.some(row=>row.evidenceId===pass.id),false,'NATIVE_CRITIC_DISPATCH_PURPOSE_REQUIRED: real inventory completeness attestation must remain valid at read-side gate');
assert(actual.valid.some(row=>row.id===pass.id),'actual native critic pass must be admitted');
assert.equal(actual.invalid.length,0,'required lanes remain valid');
console.log('NATIVE_CRITIC_DISPATCH_PURPOSE GREEN');
} finally {rmSync(fixture.root,{recursive:true,force:true});}

// A later real inventory wave must not retarget a signed earlier attestation.
const historical=setup({name:'Harmonynet',email:'26995688+Harmonynet@users.noreply.github.com'},false,true);
try {
 historical.store.writeChecklist(storyId,{items:[]});
 cli(historical.root,'review_inventory_begin',{storyId});
 const firstEpoch=historical.store.readReviewInventoryEpochs(storyId).epochs.at(-1);
 const manifest={filesReadFully:['packages/main/src/subject.ts'],filesTriagedByName:[],scanEscalationReason:null};
 const events=[{path:'packages/main/src/subject.ts',mode:'full',action:'Read',tokenCount:null}];
 const critics=[];let observedFinding;
 for(const wave of [1,2]){
  for(const [index,lane]of firstEpoch.requiredLanes.entries()){
   const actorEnv={PROOF_OR_STOP_AGENT:lane,PROOF_OR_STOP_SESSION_ID:`history-${wave}-${lane}`};
   cli(historical.root,'dispatch',{storyId,agentType:lane},actorEnv);
   const text=cli(historical.root,'review_run_start',{storyId,agent:lane},actorEnv);
   const reviewRunId=text.match(/Review run (\S+) started/)?.[1];assert(reviewRunId,text);
   const common={root:historical.root,store:historical.store,storyId,agent:lane,reviewRunId};
   if(wave===1&&index===0){
    const source=readFileSync(join(historical.root,'packages/main/src/subject.ts'),'utf8');
    assert(source.includes('subject must equal zero')&&source.includes('subject = 1'),'real fixture defect must be present before reporting');
    const text=await runBrokeredNativeReviewCli({...common,command:'finding_add',payload:{storyId,agent:lane,reviewRunId,
      desc:'The isolated source contract requires subject zero, but its implementation exports one; retain this genuine defect across the next inventory wave.',severity:'low',category:'edge',evidenceState:'verified',files:['packages/main/src/subject.ts'],readManifest:manifest,readEvents:events}});
    observedFinding=text.match(/(B-inventory-handler:F-\d+)/)?.[1];assert(observedFinding,text);
   }else await runBrokeredNativeReviewCli({...common,command:'review_pass_set',payload:{storyId,agent:lane,reviewRunId,note:'Read exact isolated source; no new family beyond the retained numeric export observation.',readManifest:manifest,readEvents:events}});
  }
  const lane='proof-or-stop-review-topology-critic',actorEnv={PROOF_OR_STOP_AGENT:lane,PROOF_OR_STOP_SESSION_ID:`history-${wave}-critic`};
  const purpose={reviewPurpose:'inventory-completeness',inventoryEpochId:firstEpoch.epochId};
  cli(historical.root,'dispatch',{storyId,agentType:lane,...purpose},actorEnv);
  const text=cli(historical.root,'review_run_start',{storyId,agent:lane,...purpose},actorEnv),reviewRunId=text.match(/Review run (\S+) started/)?.[1];assert(reviewRunId,text);
  await runBrokeredNativeReviewCli({root:historical.root,store:historical.store,storyId,agent:lane,reviewRunId,command:'review_pass_set',payload:{storyId,agent:lane,reviewRunId,note:'Independent critic retains exact existing source family and accounts for every current required lane.',readManifest:manifest,readEvents:events}});
  critics.push(historical.store.readReviewPasses(storyId).passes.find(p=>p.reviewRunId===reviewRunId));assert(critics.at(-1)?.nativeEvidenceBinding);
  const currentEpoch=historical.store.readReviewInventoryEpochs(storyId).epochs.at(-1);
  const evaluation=evaluateReviewInventoryWave({promptStore:historical.store,epoch:currentEpoch,runs:historical.store.readReviewRuns(storyId).runs,passes:historical.store.readReviewPasses(storyId).passes,findings:historical.store.readFindings(storyId).findings,findingDispositions:[]});
  const findingDispositions=evaluation.rawFindingIds.map(findingId=>({findingId,disposition:'verified_family',familyKey:'retained-numeric-export',reason:'Keep the actual source observation as one unchanged family.'}));
  cli(historical.root,'review_inventory_critic_set',{storyId,epochId:firstEpoch.epochId,agent:lane,reviewRunId,findingDispositions},actorEnv);
  cli(historical.root,wave===1?'review_inventory_wave_advance':'review_inventory_finalize',{storyId});
 }
 const runs=historical.store.readReviewRuns(storyId).runs;
 const [oldPass,newPass]=critics,[oldRun,newRun]=critics.map(p=>runs.find(r=>r.reviewRunId===p.reviewRunId));
 assert.equal(oldRun.inventoryBinding.wave,1);assert.equal(newRun.inventoryBinding.wave,2);
 const args={store:historical.store,storyId,lane:oldRun.lane,reviewRound:oldRun.reviewRound,projectRoot:historical.root,reviewPurpose:oldRun.reviewPurpose,inventoryBinding:oldRun.inventoryBinding};
 assert.equal(verifyCurrentReviewerDispatchBinding(args).ok,false,'unbound lookup deliberately stays current and must not accept old inventory subject');
 const exact=verifyCurrentReviewerDispatchBinding({...args,expectedDispatchBindingDigest:oldPass.nativeEvidenceBinding.dispatchBindingDigest});assert.equal(exact.ok,true,'exact signed old dispatch remains verifiable');
 assert.equal(verifyCurrentReviewerDispatchBinding({...args,expectedDispatchBindingDigest:'0'.repeat(64)}).ok,false,'unknown binding cannot fall back to latest');
 assert.equal(verifyCurrentReviewerDispatchBinding({...args,expectedDispatchBindingDigest:oldPass.nativeEvidenceBinding.dispatchBindingDigest,inventoryBinding:newRun.inventoryBinding}).ok,false,'exact digest cannot waive wrong inventory subject');
 const nativeArgs={binding:oldPass.nativeEvidenceBinding,projectRoot:historical.root,storyId,agent:oldRun.agent,lane:oldRun.lane,reviewRunId:oldRun.reviewRunId,dispatch:exact.binding,writerSessionId:oldPass.writerSessionId??oldPass.nativeEvidenceBinding.writerSessionId,sessionSource:oldPass.sessionSource??oldPass.nativeEvidenceBinding.sessionSource};
 assert.equal(verifyNativeReviewEvidenceBinding(nativeArgs),true);
 assert.equal(verifyNativeReviewEvidenceBinding({...nativeArgs,binding:{...nativeArgs.binding,invocationNonce:nativeArgs.binding.invocationNonce+'-tampered'}}),false,'nonce alteration remains refused');
 assert.equal(verifyNativeReviewEvidenceBinding({...nativeArgs,writerSessionId:nativeArgs.writerSessionId+'-tampered'}),false,'writer alteration remains refused');
 const current=verifyCurrentReviewerDispatchBinding({...args,inventoryBinding:newRun.inventoryBinding});assert(current.ok);
 assert.equal(verifyNativeReviewEvidenceBinding({...nativeArgs,dispatch:current.binding}),false,'old attestation cannot use current-wave dispatch');
 const state=collectReviewerEvidenceState(historical.store,storyId,historical.root);
 console.log('NATIVE_HISTORICAL_DISPATCH_OBSERVATION '+JSON.stringify({oldPass:oldPass.id,newPass:newPass.id,invalid:state.invalid}));
 assert(!state.invalid.some(x=>x.evidenceId===oldPass.id),'NATIVE_HISTORICAL_DISPATCH_REQUIRED: authentic wave-one critic must retain its exact signed dispatch');
 assert(state.valid.some(x=>x.id===oldPass.id));assert(state.valid.some(x=>x.id===newPass.id),'new wave critic remains valid');
 // This fixture deliberately retains its real observation. The separate latest-run
 // rule for open Findings must remain intact; this is not a claimed full TEST pass.
 assert(historical.store.readFindings(storyId).findings.some(f=>f.id===observedFinding&&f.status==='open'));
 console.log('NATIVE_HISTORICAL_DISPATCH GREEN');
}finally{rmSync(historical.root,{recursive:true,force:true});}
