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
const { createVerifierHandlers } = await load('handlers/verifier.js');
const { acquireOwnerLease, releaseOwnerLease } = await load('core/story-owner-lease.js');
const { persistSyntheticAdmittedWindowForTest } = await load('core/certification-window.js');
const { deriveCertificationDomainInputHashes } = await load('handlers/certification-window.js');
async function runCase(mode = 'enforce-low-risk', fullOnly = false) {
    const phase = 'DEV';
    const root = mkdtempSync(join(tmpdir(), 'u09-full-authority-'));
    const oldCwd = process.cwd();
    let store;
    const storyId = 'B-u09-authority';
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
    try {
        mkdirSync(join(root, 'packages/main/src/core'), { recursive: true });
        writeFileSync(join(root, 'packages/main/src/core/validation-runtime-tracer.cjs'), readFileSync(join(dist, 'core/validation-runtime-tracer.cjs')));
        writeFileSync(join(root, '.gitignore'), 'launches.txt\n.proof-or-stop/runtime/\n.proof-or-stop/locks/\n.proof-or-stop/activity.jsonl\n**/owner-lease.json\n**/certification-window.json\n');
        const counter = join(root, 'launches.txt');
        const commands = ['build', 'unaffected'].map(label => ({ command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(counter)}, ${JSON.stringify(label+'\n')});process.stdout.write(${JSON.stringify(label + '-marker')})`], label, assurance: fullOnly ? 'full-only' : 'story-selectable', riskTier: 'local', closurePolicy: 'static-and-traced', fullBaselineReusePolicy: fullOnly ? 'forbidden' : 'not-applicable', declaredEnvironmentKeys: ['PROOF_OR_STOP_RUNTIME_TRACE_FILE'] }));
        writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', validate: { dynamic: { mode }, commands } }));
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
        acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: root });
        persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes: deriveCertificationDomainInputHashes(root, 'HEAD', root) });
        const facts = { cli: { available: true, path: process.execPath }, worktree: { expected: root, actual: root }, gitIndex: { readable: true, path: join(root, '.git/index'), contentDigest: 'stable' }, gitMaterial: { available: true, headHash: head, materialHash: 'stable', storyFilesHash: 'stable' }, writerLease: { available: true, valid: true }, providerCapability: { required: ['validation-plan', 'bounded-output'], available: ['validation-plan', 'bounded-output'] }, resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } }, evidenceTarget: { writable: true, path: join(root, '.proof-or-stop/causal-evidence') }, sideChannel: { available: true, maxOutputChars: 12000, maxProgressEvents: 1 } };
        const result = JSON.parse(await createVerifierHandlers({ root, scanRoot: join(root, 'packages/main'), store, causalPreflightFacts: () => structuredClone(facts), log: message => console.log('HANDLER', message) }).validate({ story: storyId, json: true, noSync: true }));
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        assert.equal(parsed.status, 'pass', JSON.stringify(parsed));
        const launches = readFileSync(counter, 'utf8').trim().split('\n');
        assert.deepEqual(launches, ['build', 'unaffected'], 'DYNAMIC_FALLBACK_MUST_EXECUTE_CANONICAL_COMMANDS_ONCE');
        assert.equal(parsed.dynamicValidation.authority, mode === 'observe' ? 'full-plan-oracle' : 'full-fallback');
        assert.equal(store.readTestEvidence(storyId).commandExecution.commandCount, 2);
        console.log('DYNAMIC_FALLBACK_ONCE_PASS');
    }
    finally {
        if (store)
            releaseOwnerLease(store.storyDirPath(storyId));
        process.chdir(oldCwd);
        rmSync(root, { recursive: true, force: true });
    }
}
await runCase();
await runCase('enforce-low-risk', true);
await runCase('observe');
execFileSync(process.execPath, [join(repo, 'scripts/verify-final-validation-full-plan.mjs')], { cwd: repo, stdio: 'inherit', timeout: 180000 });
