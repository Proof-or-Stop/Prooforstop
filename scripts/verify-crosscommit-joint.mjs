#!/usr/bin/env node
// Bounded actual production CLI/receipt witness derived from as-of review regression.
import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const U09_REPO=resolve(process.env.U09_REPO || process.cwd());
const U09_TASK_URL=pathToFileURL(join(U09_REPO,'packages/main/dist/tasks/review-incremental-context-smoke.js')).href;
const U09_HELPER=new URL('./u09-joint-validation-portable.mjs',import.meta.url);
const load=p=>import(new URL('../'+p,U09_TASK_URL));
const {classifyIncrementalBindingReasons,reviewIncrementalContext}=await load('core/review-incremental-context.js');
const {promptRoleContract}=await load('core/prompt-role-contract-registry.js');
const {resetConfigCache}=await load('core/config.js');
const {signReviewPass}=await load('core/finding-verify.js');
const {verifyReviewRunPromptEnvelope}=await load('core/review-run.js');
const {classifyImpact}=await load('core/impact-classification-policy.js');
const {StoryStore}=await load('core/store.js');
const DIST_CLI_PATH=fileURLToPath(new URL('../cli.js',U09_TASK_URL));
const COMMIT_ENV=['-c','user.email=smoke@example.test','-c','user.name=Proof-or-Stop Smoke'];
const BASE_MS=Date.parse('2026-06-16T00:00:00.000Z');
function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

function write(root, path, content) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
}

function ts(n) {
    return new Date(BASE_MS + n * 60_000).toISOString();
}

function signedPass(storyId, id, agent, createdAt, reviewRound) {
    const note = `no blocker from ${agent}`;
    return {
        id,
        agent,
        note,
        createdAt,
        reviewRound,
        _hash: signReviewPass(storyId, id, agent, note, createdAt, reviewRound || ''),
    };
}

function reviewStory(storyId, rounds, currentReviewRound) {
    const events = [];
    for (let r = 1; r <= rounds; r++) {
        events.push({ phase: 'REVIEW', action: 'advance', timestamp: ts(r) });
    }
    return {
        storyId,
        name: 'synthetic-incremental-story',
        title: 'synthetic incremental story',
        type: 'feature',
        priority: 'high',
        phase: 'REVIEW',
        riskSignals: [],
        currentReviewRound,
        events,
    };
}
function runAsOfRunEligibilityRegression() {
    const root = mkdtempSync(join(tmpdir(), 'lattice-review-asof-run-'));
    const storyId = 'B-asof-run';
    const role = 'proof-or-stop-review-quality';
    const round = '2026-07-21T00:00:00.000Z';
    const runCli = (command, payload, actor) => {
        execFileSync(process.execPath, [
            DIST_CLI_PATH,
            '--root',
            root,
            command,
            JSON.stringify(payload),
        ], {
            cwd: root,
            env: {
                ...process.env,
                PROOF_OR_STOP_PROJECT_ROOT: root,
                PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex',
                PROOF_OR_STOP_AGENT: actor,
                PROOF_OR_STOP_SESSION_ID: `asof-${actor}`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    };
    const verifierOptions = (run) => ({
        roleSemanticDigest: promptRoleContract(role).semanticDigest,
        findingProjection: new StoryStore(root).readPromptEnvelopes(storyId).envelopes.find(row => row.envelopeId === run.envelopeId)?.findingProjection,
        excludedReviewRunId: run.reviewRunId,
        findingsCutoffAt: run.startedAt,
        passesCutoffAt: run.startedAt,
    });
    try {
        write(root, '.gitignore', '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n');
        write(root, 'proof-or-stop.config.json', JSON.stringify({
            scanRoot: '.',
            rootDir: 'src',
            testsDir: 'tests',
            fixturesDir: 'tests/fixtures',
            storyDir: '.proof-or-stop/story/actives',
            requirementsDir: 'docs/requirements',
            storyPrefix: 'B',
            flows: { defaults: {}, patterns: [] },
            promptEnvelope: {
                version: 'proof-or-stop.prompt-envelope-rollout.v1',
                roles: { [role]: 'full-envelope' },
            },
        }, null, 2) + '\n');
        write(root, 'src/feature.ts', 'export const feature = true;\n');
        write(root,'tests/fixtures/cases.json',JSON.stringify({cases:[{id:'one',intentRef:storyId+':CHK-001:happy:0',input:1,expected:1}]}));
        const fixtureConfig=JSON.parse(readFileSync(join(root,'proof-or-stop.config.json'),'utf8'));
        fixtureConfig.validate={dynamic:{mode:'enforce-low-risk'},commands:['build','affected','unaffected'].map(label=>({command:process.execPath,args:['-e',label==='affected'?"const a=require('node:assert/strict');const f=require('./tests/fixtures/cases.json');for(const c of f.cases)a.equal(c.input,c.expected);console.log('fixture-marker')":"console.log("+JSON.stringify(label+"-marker")+")",...(label==='affected'?['tests/fixtures/cases.json']:[])],label,assurance:'story-selectable',riskTier:'local',closurePolicy:'static-and-traced',fullBaselineReusePolicy:'not-applicable',declaredEnvironmentKeys:['PROOF_OR_STOP_RUNTIME_TRACE_FILE','FORCE_COLOR']}))};
        write(root,'proof-or-stop.config.json',JSON.stringify(fixtureConfig));
        write(root,'packages/main/src/core/validation-runtime-tracer.cjs',readFileSync(fileURLToPath(new URL('../core/validation-runtime-tracer.cjs',U09_TASK_URL)),'utf8'));
        write(root,'.gitignore',readFileSync(join(root,'.gitignore'),'utf8')+'\nu09-base-head.txt\n.proof-or-stop/runtime/\n');
        git(root, ['init']);
        git(root, ['checkout', '-B', 'main']);
        git(root, ['add', '.']);
        git(root, [...COMMIT_ENV, 'commit', '-m', 'seed as-of-run base']);
        git(root, ['checkout', '-b', `story/${storyId}`]);
        write(root, 'src/feature.ts', 'export const feature = true; // reviewed implementation\n');
        git(root,['add','src/feature.ts']);
        git(root,[...COMMIT_ENV,'commit','-m','implemented story material before prior review']);
        const store = new StoryStore(root);
        store.writeStory(storyId, {
            ...reviewStory(storyId, 1, round),
            title: 'As-of-run eligibility regression',
            description: 'Pin verifier eligibility to the signed ReviewRun headHash.',
            priority: 'high',
        });
        store.writeChecklist(storyId, {
            items: [{
                    id: 'CHK-001',
                    title: 'Pin eligibility to the signed run',
                    context: 'Later metadata-only commits must not rewrite a receipt-bound envelope.',
                    status: 'done',
                    startTime: null,
                    endTime: round,
                    files: { modify: ['src/feature.ts'], create: [], test: ['tests/fixtures/cases.json'] },
                    verificationIntent: {
                        happy: [{ id: 'CHK-001:happy:0', desc: 'As-of-run eligibility survives metadata-only commits.', type: 'logic', priority: 'must' }],
                        edge: [],
                        adversarial: [],
                    },
                }],
        });
        const originalItems=store.readChecklist(storyId).items;
        const concerns=['input parsing','unknown field rejection','empty case handling','case identity uniqueness','intent reference validation','expected value matching','numeric precision','error reporting','stable output ordering','fixture selection','deterministic replay','missing fixture failure'];
        store.writeChecklist(storyId,{items:[...originalItems,...concerns.map((concern,index)=>({...originalItems[0],id:'CHK-'+String(index+2).padStart(3,'0'),title:'Verify '+concern,context:'The fixture executor must preserve '+concern+' across full and affected command selection, with explicit deterministic assertions.',verificationIntent:{happy:[{desc:'Verify '+concern+' through the canonical fixture executor.',type:'logic',priority:'must'}],edge:[],adversarial:[]}}))]});
        git(root, ['add', '.proof-or-stop/story']);
        git(root, [...COMMIT_ENV, 'commit', '-m', 'seed as-of-run review metadata']);
        runCli('dispatch', { storyId, agentType: role }, 'main');
        runCli('review_run_start', { storyId, agent: role }, role);
        const runA = store.readReviewRuns(storyId).runs.at(-1);
        const passA = signedPass(storyId, `${runA.reviewRunId}:PASS`, role, ts(6), round);
        passA.reviewRunId = runA.reviewRunId;
        passA.envelopeId = runA.envelopeId;
        passA.writerSessionId = `${runA.reviewRunId}-session`;
        passA.sessionSource = 'smoke';
        passA._hash = signReviewPass(storyId, passA.id, passA.agent, passA.note, passA.createdAt, passA.reviewRound || '', runA.reviewRunId, undefined, undefined, undefined, { writerSessionId: passA.writerSessionId, sessionSource: passA.sessionSource }, runA.envelopeId);
        store.writeReviewPasses(storyId, { passes: [passA] });
        git(root, ['add', `.proof-or-stop/story/actives/${storyId}`]);
        git(root, [...COMMIT_ENV, 'commit', '-m', 'trusted prior pass A']);
        execFileSync(process.execPath,[fileURLToPath(U09_HELPER),root,'baseline'],{stdio:'inherit',env:{...process.env,U09_REPO}});
        write(root,'tests/fixtures/cases.json',JSON.stringify({cases:[{id:'one',intentRef:storyId+':CHK-001:happy:0',input:1,expected:2}]}));
        git(root, ['add', 'tests/fixtures/cases.json']);
        git(root, [...COMMIT_ENV, 'commit', '-m', 'eligible local boolean defect']);
        runCli('review_run_start', { storyId, agent: role }, role);
        const runB = store.readReviewRuns(storyId).runs.at(-1);
        const envelopeB = store.readPromptEnvelopes(storyId).envelopes.find(envelope => envelope.envelopeId === runB.envelopeId);
        const headH1 = runB.headHash;
        assert.equal(typeof headH1, 'string');
        assert.ok(headH1.length >= 7, 'signed run must bind a real headHash');
        console.log('U09_SELECTION',JSON.stringify({mode:envelopeB.contextMode,reason:envelopeB.selectionReason,reasons:envelopeB.eligibilityReasonCodes,freshness:envelopeB.freshnessClassification,context:reviewIncrementalContext(store,root,storyId,role,verifierOptions(runB))}));
        assert.equal(envelopeB.contextMode, 'incremental', 'production B must use the incremental envelope path');
        assert.deepEqual(verifyReviewRunPromptEnvelope(store, runB), { ok: true }, 'production verifier accepts B at H1 before later commits');
        const incrementalBody=store.readReviewPrompt(runB);
        runCli('review_run_start',{storyId,agent:role,reviewerEscalationReason:'Controlled comparison requests complete context for exactly the same local material change.'},role);
        const runFull=store.readReviewRuns(storyId).runs.at(-1);
        const fullEnvelope=store.readPromptEnvelopes(storyId).envelopes.find(x=>x.envelopeId===runFull.envelopeId);
        assert.equal(fullEnvelope.contextMode,'full');
        assert.equal(runFull.materialHash,runB.materialHash);
        assert.equal(runFull.storyFilesHash,runB.storyFilesHash);
        assert.deepEqual(verifyReviewRunPromptEnvelope(store,runFull),{ok:true});
        assert.ok(Buffer.byteLength(incrementalBody)<Buffer.byteLength(store.readReviewPrompt(runFull)),'eligible incremental rendering must save actual UTF-8 bytes');
        console.log('U09_BYTES',JSON.stringify({incrementalBytes:Buffer.byteLength(incrementalBody),fullBytes:Buffer.byteLength(store.readReviewPrompt(runFull)),incrementalMode:envelopeB.contextMode,fullMode:fullEnvelope.contextMode,sameMaterial:runFull.materialHash===runB.materialHash}));
        for (const [path, reason] of [['asset.bin','FULL_UNKNOWN_IMPACT'],['src/api/schema.proto','FULL_PUBLIC_CONTRACT'],['src/core/command-policy.ts','FULL_COMMAND_OR_GATE_POLICY']]) {
            const impact=classifyImpact({changedFiles:[path],declaredTestFiles:[],testIntentRefsByFile:{}});
            assert.equal(impact.eligible,false); assert.ok(impact.reasonCodes.includes(reason));
        }
        const scopeReasons=classifyIncrementalBindingReasons({priorEnvelopePresent:true,runtimeContractMatches:true,roleContractMatches:true,executionEnvironmentMatches:true,assemblerMatches:true,dispatchProtocolMatches:true,scopePolicyMatches:false,taskSemanticDigestMatches:true,freshnessClassification:'CURRENT_MATERIAL',pureFixtureDrift:false});
        assert.ok(scopeReasons.includes('FULL_SCOPE_OR_POLICY_CHANGED'));
        console.log('U09_ESCALATION_BOUNDARIES_PASS');
        // Persist only the actual reviewer records in this temporary fixture.
        // Validation requires a clean tree independently of prompt eligibility.
        git(root, ['add', '.proof-or-stop/story/actives/B-asof-run']);
        git(root, [...COMMIT_ENV, 'commit', '-m', 'persist actual comparison review records']);
        assert.deepEqual(verifyReviewRunPromptEnvelope(store, runB), {ok:true});
        assert.deepEqual(verifyReviewRunPromptEnvelope(store, runFull), {ok:true});
        execFileSync(process.execPath,[fileURLToPath(U09_HELPER),root,'compare'],{stdio:'inherit',env:{...process.env,U09_REPO}});
    }
    finally {
        resetConfigCache();
        rmSync(root, { recursive: true, force: true });
    }
}

runAsOfRunEligibilityRegression();
for (const script of ['verify-historical-receipt-provenance.mjs','verify-revert-receipt.mjs','verify-declared-environment-receipt.mjs','verify-replacement-receipt.mjs']) execFileSync(process.execPath,[fileURLToPath(new URL('./'+script,import.meta.url))],{stdio:'inherit',env:{...process.env,U09_REPO}});

execFileSync(process.execPath,['--import',fileURLToPath(new URL('./lab/u09-expose-core-proofs.mjs',import.meta.url)),fileURLToPath(new URL('./verify-validation-reuse-proof-boundaries.mjs',import.meta.url)),U09_REPO],{stdio:'inherit'});

execFileSync(process.execPath,[fileURLToPath(new URL('./verify-declared-environment-receipt.mjs',import.meta.url)),U09_REPO,'--overlay'],{stdio:'inherit',env:{...process.env,U09_REPO}});
