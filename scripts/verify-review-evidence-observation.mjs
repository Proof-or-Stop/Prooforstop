#!/usr/bin/env node
// Reproduce repeated live Git probes in one authenticated multi-lane review read.
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { collectReviewerEvidenceState } from '../packages/main/dist/core/review-run.js';
import { nativeReviewFixtureBrokers, runBrokeredNativeReviewCli } from '../packages/main/dist/tasks/native-review-fixture.js';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { resetConfigCache } from '../packages/main/dist/core/config.js';
import { readOwnerLease, releaseOwnerLease } from '../packages/main/dist/core/story-owner-lease.js';
import { adapterSessionEnv, adapterSessionId } from '../packages/main/dist/tasks/adapter-session-env.js';
import { currentGitHead } from '../packages/main/dist/core/evidence-freshness.js';
import { assertGitObservationInactive } from '../packages/main/dist/core/git-tree-observation.js';
const storyId = 'B-review-observation';
const reviewRound = '2020-01-01T00:00:00.000Z';
const cliPath = fileURLToPath(new URL('../bin/proof-or-stop.js', import.meta.url));
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
    return { root, store };
}
const fixture=setup({name:'Review observation fixture',email:'fixture@example.test'});
try {
console.log('SATURATED_FIXTURE_ROOT '+fixture.root);
const env=(agent,session)=>({PROOF_OR_STOP_AGENT:agent,PROOF_OR_STOP_SESSION_ID:session});
fixture.store.writeChecklist(storyId,{items:[]});
git(fixture.root,['add','--',`.proof-or-stop/story/actives/${storyId}/index.json`,`.proof-or-stop/story/actives/${storyId}/checklist.json`]);
git(fixture.root,['commit','-m','record initial native fixture metadata']);
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

const required = [...epoch.requiredLanes];
function collectMeasured() {
 const calls = new Map(), raw = cp.execFileSync;
 cp.execFileSync = function(command, args, options) {
  if (command === 'git' && options?.cwd === fixture.root) {
   const key = JSON.stringify(args); calls.set(key, (calls.get(key) ?? 0) + 1);
  }
  return raw.apply(this, arguments);
 };
 syncBuiltinESMExports();
 const started = performance.now();
 try { return { state: collectReviewerEvidenceState(fixture.store, storyId, fixture.root), calls, seconds: (performance.now()-started)/1000 }; }
 finally { cp.execFileSync = raw; syncBuiltinESMExports(); }
}
const first = collectMeasured();
assert.deepEqual(first.state.invalid, [], 'native multi-lane control must be valid before measuring');
for (const lane of required) assert(first.state.valid.some(row=>row.agent===lane), 'every real required lane remains valid');
const hot = [...first.calls].filter(([key]) => /rev-parse|worktree|ls-tree/.test(key));
assert(hot.length > 0, 'measure actual Git subprocesses, never a synthetic probe');
const repeated = hot.filter(([,count])=>count>1);
console.log('REVIEW_OBSERVATION_PROBES '+JSON.stringify({seconds:first.seconds,hot,repeated}));
assert.deepEqual(repeated, [], 'REVIEW_OBSERVATION_DUPLICATE_GIT: one synchronous multi-lane collection must share identical live Git reads');
const second = collectMeasured();
assert.deepEqual(second.state, first.state, 'repeat read retains every authority and freshness result');
assert(second.calls.size>0, 'a subsequent collection must execute fresh Git reads');
writeFileSync(join(fixture.root,'packages/main/src/subject.ts'),'export const subject = 2;\n');
git(fixture.root,['add','packages/main/src/subject.ts']);
git(fixture.root,['commit','-m','change actual reviewed material']);
const changed = collectMeasured();
for (const lane of required) assert(!changed.state.valid.some(row=>row.agent===lane), 'committed material drift must reject the previous real pass: '+lane);
assert(changed.state.invalid.length>=required.length, 'changed material cannot reuse a prior result');
const readScope = fixture.store.readScopeContract;
fixture.store.readScopeContract = () => { throw new Error('owned observation failure witness'); };
assert.throws(()=>collectReviewerEvidenceState(fixture.store,storyId,fixture.root),/owned observation failure witness/);
fixture.store.readScopeContract = readScope;
assert.equal(assertGitObservationInactive('after failed reviewer collection'),true);
assert.equal(currentGitHead(fixture.root),git(fixture.root,['rev-parse','HEAD']));
console.log('REVIEW_OBSERVATION_FRESHNESS_AND_FAILURE PASS');
console.log('REVIEW_OBSERVATION PASS');
} finally { rmSync(fixture.root,{recursive:true,force:true}); }
