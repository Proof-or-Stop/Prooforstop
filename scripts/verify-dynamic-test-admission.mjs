import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const repo = fileURLToPath(new URL('..', import.meta.url));
const dist = join(repo, 'packages/main/dist');
const load = p => import(join(dist, p));
const { StoryStore } = await load('core/store.js');
const { createVerifierHandlers, configuredValidationCommands } = await load('handlers/verifier.js');
const { acquireOwnerLease, releaseOwnerLease } = await load('core/story-owner-lease.js');
const { persistSyntheticAdmittedWindowForTest } = await load('core/certification-window.js');
const { deriveCertificationDomainInputHashes } = await load('handlers/certification-window.js');
const { executeValidationPlan } = await load('core/validation-executor.js');
const { persistCanonicalFullBaseline, runStoryAwareDynamicValidation } = await load('handlers/story-aware-validation.js');
const {readStoryAwareValidationArtifacts,persistStoryAwareValidationArtifacts} = await load('handlers/story-aware-validation.js');
const {appendReceiptRevocation} = await load('core/story-aware-validation.js');
const { runValidateGate } = await load('handlers/phase-gates.js');
const { assessStoredValidationPassAdmissibility } = await load('handlers/validation-pass-admissibility.js');
async function runCase(phase, full) {
    const root = mkdtempSync(join(tmpdir(), 'u09-full-authority-'));
    const oldCwd = process.cwd();
    let store;
    const storyId = 'B-u09-authority';
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
    try {
        mkdirSync(join(root, 'packages/main/src/core'), { recursive: true });
        writeFileSync(join(root, 'packages/main/src/core/validation-runtime-tracer.cjs'), readFileSync(join(dist, 'core/validation-runtime-tracer.cjs')));
        writeFileSync(join(root, '.gitignore'), '.proof-or-stop/runtime/\n.proof-or-stop/locks/\n.proof-or-stop/activity.jsonl\n**/owner-lease.json\n**/certification-window.json\n');
        const commands = ['build', 'unaffected'].map(label => ({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(label + '-marker')})`], label, assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'static-and-traced', fullBaselineReusePolicy: 'not-applicable', declaredEnvironmentKeys: ['PROOF_OR_STOP_RUNTIME_TRACE_FILE'] }));
        writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', validate: { dynamic: { mode: 'enforce-low-risk' }, commands } }));
        git('init', '-q', '-b', 'main');
        git('config', 'user.name', 'Audit');
        git('config', 'user.email', 'audit@example.invalid');
        store = new StoryStore(root);
        const now = new Date().toISOString();
        store.writeStory(storyId, { storyId, name: 'authority-fixture', title: 'Authority fixture', description: 'Isolated dynamic validation boundary test', type: 'bug', phase, priority: 'low', createdAt: now, startedAt: now, endedAt: null, events: [] });
        store.writeChecklist(storyId, { items: [] });
        writeFileSync(join(store.storyDirPath(storyId), 'closeout-write-receipts.jsonl'), '');
        git('add', '.');
        git('commit', '-qm', 'fixture');
        const head = git('rev-parse', 'HEAD');
        process.chdir(root);
        const configured = configuredValidationCommands(root);
        const baseline = await executeValidationPlan({ provider: 'full-baseline', commands: configured, warnings: [] }, root, head, storyId);
        assert.equal(baseline.allPass, true);
        assert.deepEqual(baseline.commands.map(c => c.label), ['build', 'unaffected']);
        console.log('BASELINE_ISSUED', Boolean(persistCanonicalFullBaseline({ projectRoot: root, sourceHead: head, result: baseline, commands: configured })));
        console.log('WARM', (await runStoryAwareDynamicValidation({ projectRoot: root, gitCwd: root, storyId, baseHead: head, head, mode: 'enforce-low-risk', commands: configured })).manifest.totals);
        acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: root });
        persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes: deriveCertificationDomainInputHashes(root, 'HEAD', root) });
        const facts = { cli: { available: true, path: process.execPath }, worktree: { expected: root, actual: root }, gitIndex: { readable: true, path: join(root, '.git/index'), contentDigest: 'stable' }, gitMaterial: { available: true, headHash: head, materialHash: 'stable', storyFilesHash: 'stable' }, writerLease: { available: true, valid: true }, providerCapability: { required: ['validation-plan', 'bounded-output'], available: ['validation-plan', 'bounded-output'] }, resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } }, evidenceTarget: { writable: true, path: join(root, '.proof-or-stop/causal-evidence') }, sideChannel: { available: true, maxOutputChars: 12000, maxProgressEvents: 1 } };
        const result = JSON.parse(await createVerifierHandlers({ root, scanRoot: join(root, 'packages/main'), store, causalPreflightFacts: () => structuredClone(facts), log: message => console.log('HANDLER', message) }).validate({ story: storyId, ...(full ? { full: true } : {}), json: true, noSync: true }));
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        assert.equal(parsed.status, 'pass', JSON.stringify(parsed));
        console.log('ACTUAL_COMMANDS', parsed.commands.map(c=>c.label));
        const ctx = {root,scanRoot:join(root,'packages/main'),store,log:console.log};
        assert.equal(assessStoredValidationPassAdmissibility(ctx,storyId).ok,true);
        assert.deepEqual(parsed.commands.map(c=>c.label), ['build']);
        assert.equal(parsed.dynamicValidation.manifest.totals.reused, 1);
        await runValidateGate(ctx,storyId,{stop(){}});
        console.log('ACTUAL_TEST_GATE_ACCEPTED');
        const artifacts=readStoryAwareValidationArtifacts(root,storyId);
        const ids=artifacts.receipts.map(row=>row.id);
        assert.ok(ids.length>0);
        persistStoryAwareValidationArtifacts({projectRoot:root,storyId,manifest:parsed.dynamicValidation.manifest,report:'owned revocation mutation',receipts:artifacts.receipts,revocationLedger:appendReceiptRevocation(artifacts.revocationLedger,ids)});
        await assert.rejects(()=>runValidateGate(ctx,storyId,{stop(){}}),undefined,'REVOKED_DYNAMIC_RECEIPTS_MUST_NOT_ENTER_TEST');
        console.log(`PASS U09 complete plan phase=${phase} full=${full}`);
    }
    finally {
        if (store)
            releaseOwnerLease(store.storyDirPath(storyId));
        process.chdir(oldCwd);
        rmSync(root, { recursive: true, force: true });
    }
}
await runCase('REVIEW',false);
