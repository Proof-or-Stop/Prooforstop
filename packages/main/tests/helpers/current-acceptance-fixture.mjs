// Isolated fixture receipt plumbing. Embedded mutation records are fixture data.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../../dist/core/store.js';
import { resetConfigCache } from '../../dist/core/config.js';
import { PROCESS_FACT_REGISTRY } from '../../dist/core/process-fact-registry.js';
import { createProofStoryHandlers, } from '../../dist/handlers/proofstory.js';
import { PRE_REVIEW_LIVE_PROOF_COMMAND, } from '../../dist/core/pre-review-check.js';
import { signScopeCheck } from '../../dist/handlers/scope-check.js';
import { adapterSessionEnv } from '../../dist/tasks/adapter-session-env.js';
import { STATE_DIR_NAMES } from '../../dist/core/brand-paths.js';
import { sanitizedFixtureChildEnvironment } from '../../dist/tasks/fixture-environment.js';
import { nativeReviewFixtureAmbientHost, nativeReviewFixtureBrokers, nativeReviewFixtureHostEnvironment, } from '../../dist/tasks/native-review-fixture.js';
const packageRoot = fileURLToPath(new URL('../../dist/', import.meta.url));
const repositoryRoot = resolve(packageRoot, '..', '..', '..');
const proofOrStopBin = join(repositoryRoot, 'bin/proof-or-stop.js');
const storyId = 'B-current-acceptance-fixture';
const baseAt = '2026-07-22T00:00:00.000Z';
const consumerControlSource = "import { produceFact } from './producer.js'; export const consumeFact=()=>produceFact().fact; export const invokeConsumer=()=>consumeFact();\n";
function write(root, rel, content) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content, 'utf8');
}
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function cli(root, command, args, allowFail = false, agent = 'proof-or-stop-implementer', sessionTask = 'sess-pre-review-smoke', host = nativeReviewFixtureAmbientHost()) {
    try {
        return execFileSync(process.execPath, [proofOrStopBin, '--root', root, command, JSON.stringify(args)], {
            cwd: root,
            env: {
                ...sanitizedFixtureChildEnvironment(process.env),
                // The registered rollout producer marks its outer process as the
                // verifier. Nested fixture CLI calls must resolve their own adapter
                // actor from the explicit session envelope instead of inheriting that
                // non-dispatch actor marker.
                PROOF_OR_STOP_AGENT: agent,
                ...adapterSessionEnv(sessionTask, agent),
                ...nativeReviewFixtureHostEnvironment(agent, host, sessionTask),
            },
            encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
    }
    catch (error) {
        if (!allowFail)
            throw error;
        const failure = error;
        return `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
    }
}
const declaration = {
    schemaVersion: 'proofstory.verification_planned_path_declaration.v1',
    id: 'VPP-PRE', relation: 'producer_to_consumer',
    producer: { id: 'EP-P', role: 'producer', expectedArtifactKind: 'handler', expectedFileRef: 'packages/main/src/producer.ts', expectedSymbolOrFact: 'produceFact', fileDeclarationRef: 'CHK-001:files:create:0' },
    consumers: [{ id: 'EP-C', role: 'consumer', expectedArtifactKind: 'handler', expectedFileRef: 'packages/main/src/consumer.ts', expectedSymbolOrFact: 'consumeFact', fileDeclarationRef: 'CHK-001:files:create:1' }],
    outputFactRef: 'process-fact:pre_review_check',
};
const topology = {
    schemaVersion: 'proofstory.acceptance_topology.v1',
    producerRefs: [{ id: 'P', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-PRE:VPP-PRE', endpointRef: 'EP-P' } }],
    consumerRefs: [{ id: 'C', sourceRef: { refKind: 'planned', plannedPathDeclarationRef: 'INT-PRE:VPP-PRE', endpointRef: 'EP-C' }, producerRefs: ['P'] }],
    positiveAssertionRefs: [{ id: 'A', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-PRE' }, producerRefs: ['P'], consumerRefs: ['C'] }],
    mutationCaseRefs: [{ id: 'M', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-PRE' }, producerRefs: ['P'], consumerRefs: ['C'] }],
    transcriptAssertionRefs: [{ id: 'T', sourceRef: { refKind: 'existing', canonicalSourceRef: 'intent:INT-PRE' }, producerRefs: ['P'], consumerRefs: ['C'] }],
    commandRefs: [
        { refKind: 'existing', canonicalSourceRef: 'intent:INT-PRE' },
        { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis' },
        { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' },
        { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_topology_check' },
        { refKind: 'existing', canonicalSourceRef: 'process-fact:artifact:acceptance-basis.json' },
        { refKind: 'existing', canonicalSourceRef: 'process-fact:pre_review_check' },
        { refKind: 'existing', canonicalSourceRef: 'process-fact:pre_review_check_read' },
        { refKind: 'existing', canonicalSourceRef: 'process-fact:artifact:pre-review-check.json' },
        { refKind: 'existing', canonicalSourceRef: 'basis-path:path:static-call:packages/main/src/producer.ts#produceFact->consumer:packages/main/src/consumer.ts#produceFact' },
    ],
};
const fixtureProof = {
    schemaVersion: 'proofstory.pre_review_executable_proof.v1', storyId,
    producer: 'test-output-is-untrusted-until-canonical-runner-receipt', verifier: 'test-output-is-untrusted-until-pre-review-verifier', commandDigests: [`sha256:${'1'.repeat(64)}`],
    caseRecords: [
        ['A', 'positive', 'positive:A', 'production-baseline', 'fixture-positive', 'PASS', 'PASS', true, [['producer-evaluated', 0], ['consumer-verified', 1]], 'intent:INT-PRE'],
        ['M', 'mutation', 'mutation:M', 'mutation-kind:M', 'fixture-mutation', 'PR_PRODUCTION_PATH_UNPROVEN', 'PR_PRODUCTION_PATH_UNPROVEN', true, [['mutation-applied', 2], ['diagnostic-observed', 3], ['control-rerun', 4]], 'intent:INT-PRE'],
        ['T', 'transcript', 'transcript:T', 'event-log-relation', 'fixture-transcript', 'ORDERED', 'ORDERED', true, [['producer-evaluated', 5], ['consumer-verified', 6]], 'intent:INT-PRE'],
    ],
    provenance: { runnerPath: '', runnerDigest: '', targetPath: '', targetDigest: '', buildCommand: '' },
    bindingProofs: [{ bindingId: 'AC-PRE', positiveAssertionIds: ['A'], mutationProofs: [{ mutationId: 'M', expectedCode: 'PR_PRODUCTION_PATH_UNPROVEN', observedCode: 'PR_PRODUCTION_PATH_UNPROVEN', controlRestored: true }], transcriptProofs: [{ transcriptId: 'T', producerRefs: ['P'], consumerRefs: ['C'], producerSequence: 0, consumerSequence: 1 }] }],
};
function checklist() {
    return { items: [{ id: 'CHK-001', title: 'pre review', status: 'done', startTime: baseAt, endTime: baseAt,
                files: { modify: [], create: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], test: [] },
                verificationIntent: { happy: [{ id: 'INT-PRE', desc: 'real producer consumer', type: 'cli', priority: 'must', plannedPathDeclarations: [declaration] }], edge: [], adversarial: [] },
            }] };
}
function contract() {
    return { schemaVersion: 'proofstory.contract.v1', storyId, diagnosticOnly: true, hardeningLevel: 'high_assurance', triggerReasons: [],
        acceptanceBindings: [{ id: 'AC-PRE', checklistRefs: ['CHK-001'], verificationIntentRefs: ['INT-PRE'], milestoneIds: [], verificationTopology: topology }],
        diagnosticGaps: [], createdAt: baseAt, updatedAt: baseAt };
}
function scopeContract() {
    return { storyId, mode: 'local', allowedModify: [], allowedCreate: ['packages/main/src/producer.ts', 'packages/main/src/consumer.ts'], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [], createdAt: baseAt, updatedAt: baseAt };
}
function scopeCheck(root) {
    const cwd = process.cwd();
    process.chdir(root);
    try {
        return { storyId, checkedAt: baseAt, reviewRound: '', agentId: 'proof-or-stop-review-scope-plan', issues: [], features: [], summary: { total: 1, covered: 1, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 }, _hash: signScopeCheck(storyId, baseAt, 0, 1, '') };
    }
    finally {
        process.chdir(cwd);
    }
}
function writeRegistration(root) {
    write(root, 'packages/main/package.json', JSON.stringify({ scripts: { build: 'node build-proof.mjs' } }));
    write(root, 'packages/main/build-proof.mjs', "import{copyFileSync,mkdirSync}from'node:fs';mkdirSync('dist/tasks',{recursive:true});copyFileSync('src/tasks/proof-emitter.mjs','dist/tasks/proofstory-pre-review-check-smoke.js');\n");
    write(root, 'scripts/run-proofstory-pre-review-live-proof.mjs', "import{execFileSync}from'node:child_process';execFileSync('npm',['--prefix','packages/main','run','build'],{cwd:process.cwd(),env:process.env,stdio:['ignore','ignore','inherit']});execFileSync(process.execPath,['packages/main/dist/tasks/proofstory-pre-review-check-smoke.js','--live-proof'],{cwd:process.cwd(),env:process.env,stdio:'inherit'});\n");
    write(root, 'packages/main/src/cli/command-catalog.ts', [
        'export const MAIN_TOOLS=[',
        "  {name:'acceptance_basis'},",
        "  {name:'acceptance_basis_generate'},",
        "  {name:'acceptance_topology_check'},",
        "  {name:'pre_review_check'},",
        "  {name:'pre_review_check_read'},",
        '];',
        '',
    ].join('\n'));
    write(root, 'packages/main/src/registry.ts', [
        "import {createProofStoryHandlers} from './handlers/proofstory.js';",
        'const registry={registerBatch(_:unknown){}};',
        'const ctx={} as any;',
        'registry.registerBatch(createProofStoryHandlers(ctx));',
        '',
    ].join('\n'));
    write(root, 'packages/main/src/handlers/proofstory.ts', "export function createProofStoryHandlers(){return{acceptance_basis(){},acceptance_basis_generate(){},acceptance_topology_check(){},pre_review_check(){},pre_review_check_read(){}}}\n");
    write(root, 'packages/main/src/handlers/transition-orchestrator.ts', 'export function runPreReviewCheckGate(){}\n');
    write(root, 'packages/main/src/core/process-fact-registry.ts', "export const facts=['acceptance_basis','acceptance_basis_generate','pre_review_check','pre_review_check_read','artifact:pre-review-check.json'];\n");
    write(root, 'packages/main/src/core/acceptance-topology.ts', 'export const acceptanceTopology=true;\n');
    // Physical producer/consumer closure required by the current process registry.
    write(root, 'packages/main/src/core/scope-inventory-budget.ts', 'export const scopeInventoryBudget=true;\n');
    write(root, 'packages/main/src/core/story-scope-budget-legacy.ts', 'export const storyScopeBudgetLegacy=true;\n');
    write(root, 'packages/main/src/core/agent-dispatch-registry.ts', 'export const agentDispatch=true;\n');
    // The production process-fact closure now reaches the signed REVIEW
    // inventory through transition-orchestrator.  Keep the cohort repository a
    // faithful, sealed source graph: omitting these registered closure files
    // makes acceptance_basis_generate correctly return partial.
    write(root, 'packages/main/src/core/machine.ts', 'export const reviewInventoryGate=true;\n');
    write(root, 'packages/main/src/core/review-inventory-epoch.ts', 'export const reviewInventoryEpoch=true;\n');
    write(root, 'packages/main/src/core/pre-review-check.ts', 'export const preReviewCheck=true;\n');
    write(root, 'packages/main/src/core/pre-review-live-proof.ts', 'export const preReviewLiveProof=true;\n');
    write(root, 'packages/main/src/core/topology-critic-receipt.ts', 'export const topologyCritic=true;\n');
    write(root, 'packages/main/src/core/acceptance-rollout.ts', 'export const acceptanceRollout=true;\n');
    // Keep the synthetic registry workspace closed over the current shared
    // validation dependencies.  The PLAN control asserts snapshot completeness,
    // so declared registry source refs must exist even when this fixture does
    // not execute their production implementations.
    for (const path of [
        'packages/main/src/core/evidence-freshness.ts',
        'packages/main/src/core/material-path-policy.ts',
        'packages/main/src/core/shared-validation-execution.ts',
        'packages/main/src/core/story-aware-validation.ts',
        'packages/main/src/core/story-owner-lease.ts',
        'packages/main/src/core/validation-execution-lock.ts',
    ])
        write(root, path, 'export const fixtureDependency=true;\n');
    write(root, 'packages/main/src/handlers/review-inventory.ts', 'export const reviewInventoryHandlers=true;\n');
    write(root, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'export const acceptanceRolloutCohort=true;\n');
    write(root, 'scripts/verify-process-fact-contract.mjs', "export const facts=['pre_review_check','pre_review_check_read','artifact:pre-review-check.json'];\n");
    // Registry snapshot assembly visits all physical candidates before narrowing
    // this controlled synthetic graph. Empty modules add no executable edges and
    // never replace the explicit producer/consumer fixtures above.
    const registeredSources = new Set(PROCESS_FACT_REGISTRY.flatMap(entry => [
        ...(entry.producerSourceRefs ?? []), ...(entry.consumerSourceRefs ?? []),
    ]));
    for (const file of registeredSources) {
        if (!existsSync(join(root, file))) write(root, file, 'export {};\n');
    }
}
function writeLiveProofFixture(root, proof, recomputeRoot = true) {
    const digestUrl = new URL("../../dist/core/digest.js", import.meta.url).href;
    const proofUrl = new URL("../../dist/core/pre-review-live-proof.js", import.meta.url).href;
    write(root, 'packages/main/src/tasks/proof-emitter.mjs', [
        "import{readFileSync}from'node:fs';",
        "import{join}from'node:path';",
        `import{digestCanonicalJson}from${JSON.stringify(digestUrl)};`,
        `import{preReviewCaseAggregateDigest,encodePreReviewCaseRecords,decodePreReviewCaseRecords}from${JSON.stringify(proofUrl)};`,
        `const proof=${JSON.stringify(proof)};`,
        "const digest=v=>'sha256:'+digestCanonicalJson(v);",
        `const records=Array.isArray(proof.caseRecords)?proof.caseRecords:decodePreReviewCaseRecords(proof.caseRecords);${recomputeRoot ? 'proof.commandDigests=[preReviewCaseAggregateDigest(proof.storyId,records)];' : ''}proof.caseRecordsEncoding='gzip-base64';proof.caseRecords=encodePreReviewCaseRecords(records);`,
        "proof.provenance={runnerPath:'scripts/run-proofstory-pre-review-live-proof.mjs',runnerDigest:digest(readFileSync(join(process.cwd(),'scripts/run-proofstory-pre-review-live-proof.mjs'))),targetPath:'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js',targetDigest:digest(readFileSync(new URL(import.meta.url))),buildCommand:'npm --prefix packages/main run build'};",
        "console.log('PROOFSTORY_PRE_REVIEW_PROOF='+JSON.stringify(proof));",
        '',
    ].join('\n'));
}
function writeActiveLiveProofRunner(root) {
    writeLiveProofFixture(root, fixtureProof);
}
export async function withCurrentAcceptanceFixture(callback) {
const root = mkdtempSync(join(tmpdir(), 'proofstory-pre-review-'));
const originalCwd = process.cwd();
try {
    {
        // B-cc10: the CLI writes runtime/activity/locks under the CANONICAL state dir, so a
        // fixture ignoring only the deprecated spelling let `git add .` track
        // .proof-or-stop/activity.jsonl — which quorum_submit's assertCleanQuorumBaseline then
        // reported as 'M .proof-or-stop/activity.jsonl' and refused on.
        write(root, '.gitignore', STATE_DIR_NAMES.flatMap((dir) => [
            `${dir}/runtime/`,
            `${dir}/activity.jsonl`,
            `${dir}/locks/`,
        ]).join('\n') + '\n');
        write(root, 'proof-or-stop.config.json', JSON.stringify({
            scanRoot: 'packages/main',
            rootDir: 'src',
            storyDir: '.proof-or-stop/story/actives',
            requirementsDir: 'docs/requirements',
            proofStory: { acceptanceTopologyGateMode: 'observe' },
            // B-137a: brokered native-review evidence needs registered brokers.
            nativeReviewInvocation: {
                brokers: nativeReviewFixtureBrokers(),
            },
        }));
        write(root, 'tsconfig.json', '{}\n');
        writeRegistration(root);
        for (const name of ['convergence-progress-gate', 'convergence-progress-journal', 'story-scope-budget', 'story-scope-budget-decisions', 'story-scope-decomposition', 'acceptance-amendment-journal'])
            write(root, 'packages/main/src/core/' + name + '.ts', 'export const fixtureDependency=true;\n');
        write(root, 'packages/main/src/handlers/story-review.ts', 'export const fixtureDependency=true;\n');
        write(root, 'packages/main/src/producer.ts', 'export const produceFact=()=>({fact:true});\n');
        write(root, 'packages/main/src/consumer.ts', consumerControlSource);
        write(root, 'emit-proof.mjs', `console.log(${JSON.stringify(`PROOFSTORY_PRE_REVIEW_PROOF=${JSON.stringify(fixtureProof)}`)});\n`);
        writeActiveLiveProofRunner(root);
        git(root, ['init', '-b', 'main']);
        git(root, ['config', 'user.name', 'Pre Review Smoke']);
        git(root, ['config', 'user.email', 'smoke@example.test']);
        git(root, ['add', '.']);
        git(root, ['commit', '-m', 'seed']);
        git(root, ['switch', '-c', `story/${storyId}`]);
        process.chdir(root);
        resetConfigCache();
        const store = new StoryStore(root);
        const story = { storyId, name: storyId, title: 'pre review smoke', description: 'pre review smoke', type: 'feature', priority: 'high', phase: 'DEV', createdAt: baseAt, startedAt: baseAt, endedAt: null, events: [], worktree: { path: root, branch: `story/${storyId}`, createdAt: baseAt } };
        store.writeStory(storyId, story);
        store.writeChecklist(storyId, checklist());
        store.writeProofStoryContract(storyId, contract());
        store.writeScopeContract(storyId, scopeContract());
        store.writeScopeCheck(storyId, scopeCheck(root));
        git(root, ['add', '.']);
        git(root, ['commit', '--author=proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>', '-m', 'implementation']);
        const h = createProofStoryHandlers({ root, store, scanRoot: join(root, 'packages/main') });
        const basis = JSON.parse(h.acceptance_basis_generate({ storyId, json: true }));
        assert.equal(basis.artifact.basis.status, 'complete', JSON.stringify(basis));
        const topology = JSON.parse(h.acceptance_topology_check({ storyId, json: true }));

        assert.equal(topology.status, 'pass');

        cli(root, 'verification_evidence_batch_add', { storyId, evidences: [{ itemId: 'CHK-001', intentRef: 'INT-PRE', kind: 'integration_test', result: 'pass', command: 'node emit-proof.mjs', selector: 'PROOFSTORY_PRE_REVIEW_PROOF=', note: 'Actual fixture command execution' }] });
        const captured = JSON.parse(cli(root, 'live_smoke_transcript', { storyId, capture: PRE_REVIEW_LIVE_PROOF_COMMAND, write: true, json: true }));
        assert.equal(captured.transcript.status, 'present-fresh');

        const checked = JSON.parse(cli(root, 'pre_review_check', { storyId, json: true }));

        assert.equal(checked.ok, true);
        const before = JSON.stringify(store.readPreReviewCheck(storyId));
        const read = JSON.parse(cli(root, 'pre_review_check_read', { storyId, json: true }));
        assert.equal(read.ok, true, JSON.stringify(read));
        assert.equal(JSON.stringify(store.readPreReviewCheck(storyId)), before);
        return await callback({root,storyId,store,cli:(command,args,allowFail=false)=>cli(root,command,args,allowFail),mutationEvidenceBoundary:'Fixture case records; real CLI capture and signatures, not independent production mutation execution'});
    }
}
finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true }); resetConfigCache();
}

}
