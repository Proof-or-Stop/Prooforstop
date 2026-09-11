#!/usr/bin/env node
import { nativeReviewFixtureBrokers, runBrokeredNativeReviewCli } from "../packages/main/dist/tasks/native-review-fixture.js";
import {collectReviewerEvidenceState,verifyCurrentReviewerDispatchBinding} from "../packages/main/dist/core/review-run.js";
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
for(const mode of ['wrong-subject','wrong-story-path','outside-review-artifact','clean']) {
const fixture=setup({name:'Harmonynet',email:'26995688+Harmonynet@users.noreply.github.com'});
const primaryRoot=fixture.root;const worktreePath=join(primaryRoot,'.worktrees',storyId);
fixture.store.writeStory(storyId,{...fixture.store.readStory(storyId),worktree:{path:worktreePath,branch:'story/'+storyId,createdAt:reviewRound}});
fixture.store.writeChecklist(storyId,{items:[]});
git(primaryRoot,['add','--',`.proof-or-stop/story/actives/${storyId}/index.json`,`.proof-or-stop/story/actives/${storyId}/checklist.json`]);
git(primaryRoot,['commit','-m','record initial native linked fixture']);
git(primaryRoot,['worktree','add','-b','story/'+storyId,worktreePath]);
fixture.root=worktreePath;fixture.store=new StoryStore(worktreePath);isolatedFixtureRoots.add(worktreePath);
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
const publication=git(fixture.root,['log','-1','--format=%s']);
assert.equal(publication,`proof-or-stop: record ${storyId} review epoch metadata`,'actual batch publisher must produce the canonical subject');
const cutoff=fixture.store.readReviewInventoryEpochs(storyId).receipts.at(-1).cutoff.headHash;
assert.notEqual(git(fixture.root,['rev-parse','HEAD']),cutoff,'actual publication must move beyond signed inventory cutoff');
if(mode!=='clean') {
 const relative=mode==='wrong-story-path'?'.proof-or-stop/story/actives/B-other/note.txt':mode==='outside-review-artifact'?`.proof-or-stop/story/actives/${storyId}/not-a-review-artifact.txt`:`.proof-or-stop/story/actives/${storyId}/process-events.jsonl`;
 mkdirSync(join(fixture.root,relative,'..'),{recursive:true});
 if(mode==='wrong-subject') {const {appendFileSync}=await import('node:fs');appendFileSync(join(fixture.root,relative),'\n');}
 else writeFileSync(join(fixture.root,relative),'unrelated path must not gain review continuity\n');
 git(fixture.root,['add','--',relative]);
 git(fixture.root,['commit','-m',mode==='wrong-subject'?'ordinary bookkeeping claim':`proof-or-stop: record ${storyId} review epoch metadata`]);
}
const cheap=JSON.parse(cli(fixture.root,'validate',{storyId,focus:'fast',json:true},env('main','saturation-owner')));assert.equal(cheap.status,'pass');
let output='',error='';try{output=cli(fixture.root,'certification_window_begin',{storyId},env('main','saturation-owner'));}catch(e){error=String(e);}
console.log('REVIEW_EPOCH_CONTINUITY_OBSERVATION '+JSON.stringify({mode,output,error}));
if(mode==='clean') {
 assert.equal(error,'','REVIEW_EPOCH_NATIVE_CONTINUITY_REQUIRED: actual canonical batch publication must admit without material drift');
 assert.match(output,/State: ADMITTED/);
 const data=fixture.store.readCertificationWindows(storyId);assert.equal(data.receipts.filter(r=>r.authority==='pre-cert').length,1);
 console.log('REVIEW_EPOCH_NATIVE_CONTINUITY GREEN');
} else {
 assert.match(error,/Inventory receipt is not on the current headHash lineage/,'negative must reach actual continuity verifier');
 assert.equal(fixture.store.readCertificationWindows(storyId).receipts.filter(r=>r.authority==='pre-cert').length,0);
 console.log('REVIEW_EPOCH_CONTINUITY_REFUSED '+mode);
}
} finally {rmSync(primaryRoot,{recursive:true,force:true});}
}
