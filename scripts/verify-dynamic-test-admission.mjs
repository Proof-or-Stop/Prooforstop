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
const {appendReceiptRevocation,createValidationCommandReceipt} = await load('core/story-aware-validation.js');
const { runValidateGate, runDoneOracleGate } = await load('handlers/phase-gates.js');
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
        writeFileSync(join(root, 'packages/main/src/local-input.ts'), 'export const localInput = 1;\n');
        writeFileSync(join(root, 'packages/main/src/unaffected-input.ts'), 'export const unaffectedInput = 1;\n');
        writeFileSync(join(root, '.gitignore'), '.proof-or-stop/runtime/\n.proof-or-stop/locks/\n.proof-or-stop/activity.jsonl\n**/owner-lease.json\n**/certification-window.json\n');
        const commands = ['build', 'unaffected'].map(label => ({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(label + '-marker')})`], label, inputRoots: [label === 'build' ? 'packages/main/src/local-input.ts' : 'packages/main/src/unaffected-input.ts'], inputsComplete: true, assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'static-and-traced', fullBaselineReusePolicy: 'not-applicable', declaredEnvironmentKeys: ['PROOF_OR_STOP_RUNTIME_TRACE_FILE'] }));
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
        const baseHead = git('rev-parse', 'HEAD');
        process.chdir(root);
        const configured = configuredValidationCommands(root);
        const baseline = await executeValidationPlan({ provider: 'full-baseline', commands: configured, warnings: [] }, root, baseHead, storyId);
        assert.equal(baseline.allPass, true);
        assert.deepEqual(baseline.commands.map(c => c.label), ['build', 'unaffected']);
        const canonicalBaseline = persistCanonicalFullBaseline({ projectRoot: root, sourceHead: baseHead, result: baseline, commands: configured });
        assert.ok(canonicalBaseline, 'canonical baseline must be persisted');
        git('checkout', '-qb', 'story');
        writeFileSync(join(root, 'packages/main/src/local-input.ts'), 'export const localInput = 2;\n');
        git('add', 'packages/main/src/local-input.ts');
        git('commit', '-qm', 'change build input');
        const head = git('rev-parse', 'HEAD');
        await runStoryAwareDynamicValidation({ projectRoot: root, gitCwd: root, storyId, baseHead, head, mode: 'enforce-low-risk', commands: configured });
        acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: root });
        persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes: deriveCertificationDomainInputHashes(root, 'HEAD', root) });
        const facts = { cli: { available: true, path: process.execPath }, worktree: { expected: root, actual: root }, gitIndex: { readable: true, path: join(root, '.git/index'), contentDigest: 'stable' }, gitMaterial: { available: true, headHash: head, materialHash: 'stable', storyFilesHash: 'stable' }, writerLease: { available: true, valid: true }, providerCapability: { required: ['validation-plan', 'bounded-output'], available: ['validation-plan', 'bounded-output'] }, resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } }, evidenceTarget: { writable: true, path: join(root, '.proof-or-stop/causal-evidence') }, sideChannel: { available: true, maxOutputChars: 12000, maxProgressEvents: 1 } };
        const result = JSON.parse(await createVerifierHandlers({ root, scanRoot: join(root, 'packages/main'), store, causalPreflightFacts: () => structuredClone(facts), log: () => {} }).validate({ story: storyId, ...(full ? { full: true } : {}), json: true, noSync: true }));
        let parsed = typeof result === 'string' ? JSON.parse(result) : result;
        assert.equal(parsed.status, 'pass', JSON.stringify(parsed));
        const ctx = {root,scanRoot:join(root,'packages/main'),store,log:console.log};
        const admission = assessStoredValidationPassAdmissibility(ctx,storyId,{allowDynamicCoverage:!full});
        assert.equal(admission.ok,true,JSON.stringify(admission.reasonCodes));
        if (full) {
          assert.deepEqual(parsed.commands.map(c => c.label), ['build', 'unaffected']);
          assert.equal(store.readTestEvidence(storyId).commandExecution.commandCount, 2);
          await runValidateGate(ctx, storyId, { stop() {} });
          const repeatedFull = JSON.parse(await createVerifierHandlers({ root, scanRoot: join(root, 'packages/main'), store,
            causalPreflightFacts: () => structuredClone(facts), log: message => console.log('REPEAT_FULL', message)
          }).validate({ story: storyId, full: true, json: true, noSync: true }));
          assert.equal(repeatedFull.status, 'pass', JSON.stringify(repeatedFull));
          assert.equal(repeatedFull.commandExecutions, 0, 'CANONICAL_FULL_REPEAT_MUST_REUSE_WITHOUT_NEW_WINDOW');
          assert.deepEqual(repeatedFull.commands, []);
          assert.ok(store.readTestEvidence(storyId).validationArtifactSignature);
          assert.equal(assessStoredValidationPassAdmissibility(ctx, storyId, {allowDynamicCoverage:false}).ok, true);
          await runValidateGate(ctx, storyId, { stop() {} });
          console.log('CANONICAL_FULL_SIGNED_TEST_ADMISSION_PASS');
          return;
        }
        assert.deepEqual(parsed.commands.map(c => c.label), ['build']);
        const canonicalConsumer = assessStoredValidationPassAdmissibility(ctx,storyId,{allowDynamicCoverage:false});
        assert.equal(canonicalConsumer.ok,false);
        assert.ok(canonicalConsumer.reasonCodes.includes('dynamic_requires_canonical_full_plan'),JSON.stringify(canonicalConsumer.reasonCodes));
        assert.equal(assessStoredValidationPassAdmissibility(ctx,storyId,{allowDynamicCoverage:true}).ok,true);
        // PRE_CERT authorizes one routine execution. A repeat may reuse that
        // signed result only while preserving its dynamic authority and live checks.
        const originalExecutionHead = parsed.dynamicValidation.manifest.head;
        parsed = JSON.parse(await createVerifierHandlers({ root, scanRoot: join(root, 'packages/main'), store,
          causalPreflightFacts: () => structuredClone(facts), log: message => console.log('REPEAT', message) }).validate({ story: storyId, json: true, noSync: true }));
        assert.equal(parsed.status, 'pass', JSON.stringify(parsed));
        assert.equal(parsed.commandExecutions, 0, 'DYNAMIC_REPEAT_MUST_NOT_REEXECUTE_CONSUMED_PRECERT_WINDOW');
        assert.equal(parsed.dynamicValidation?.manifest?.head, originalExecutionHead,
          'DYNAMIC_REPEAT_MUST_PRESERVE_SIGNED_EXECUTION_HEAD');
        assert.equal(parsed.dynamicValidation?.authority, 'enforce-authority',
          'DYNAMIC_WHOLE_RESULT_REUSE_MUST_PRESERVE_AUTHORITY_KIND');
        assert.deepEqual(parsed.commands, []);
        assert.equal(parsed.dynamicValidation.manifest.totals.executed, 1);
        assert.equal(parsed.dynamicValidation.manifest.totals.excluded, 1);
        await runValidateGate(ctx,storyId,{stop(){}});
        console.log('ACTUAL_TEST_GATE_ACCEPTED');
        const signedEvidence = store.readTestEvidence(storyId);
        assert.ok(signedEvidence.validationArtifactSignature);
        let downstreamDoneError = '';
        try { runDoneOracleGate(storyId, store, root, { stop() {} }, root); }
        catch (error) { downstreamDoneError = error instanceof Error ? error.message : String(error); }
        assert.ok(downstreamDoneError, 'the bounded fixture should reach ordinary downstream DONE prerequisites');
        assert.doesNotMatch(downstreamDoneError, /Stored routine validation admission|dynamic_.*(?:invalid|changed|missing)/,
          'a valid dynamic TEST PASS must cross the DONE dynamic-consumer boundary');
        console.log('DYNAMIC_DONE_CONSUMER_ACCEPTED');
        const artifacts=readStoryAwareValidationArtifacts(root,storyId);
        const requiredCommandId = parsed.dynamicValidation.manifest.rows.find(row=>row.disposition==='execute').commandId;
        const reuseId = artifacts.receipts.find(row=>row.commandId===requiredCommandId)?.id;
        assert.ok(reuseId,'dynamic executed row must publish a required receipt');
        const persist = (receipts, revocationLedger=artifacts.revocationLedger) => persistStoryAwareValidationArtifacts({projectRoot:root,storyId,manifest:parsed.dynamicValidation.manifest,report:'owned negative-control mutation',receipts,revocationLedger});
        const assertSignatureRefusal = () => {
          const result = assessStoredValidationPassAdmissibility(ctx, storyId, {allowDynamicCoverage:true});
          assert.equal(result.ok, false);
          assert.ok(result.reasonCodes.includes('validation_evidence_signature_invalid'), JSON.stringify(result.reasonCodes));
        };
        for (const mutated of [
          { ...signedEvidence, validationArtifactSignature: undefined },
          { ...signedEvidence, output: JSON.stringify({ ...JSON.parse(signedEvidence.output), summary: 'mutated output' }) },
        ]) {
          store.writeTestEvidence(storyId, mutated);
          assertSignatureRefusal();
          await assert.rejects(() => runValidateGate(ctx, storyId, { stop() {} }), /validation evidence signature is missing or invalid/);
          assert.throws(() => runDoneOracleGate(storyId, store, root, { stop() {} }, root),
            /Stored routine validation admission|validation evidence signature is missing or invalid/,
            'DONE must authenticate the complete stored PASS before reading its execution mode');
          store.writeTestEvidence(storyId, signedEvidence);
          await runValidateGate(ctx, storyId, { stop() {} });
        }
        const otherStoryId = 'B-u09-signature-replay';
        writeFileSync(join(root, '.git/info/exclude'), '.proof-or-stop/story/actives/B-u09-signature-replay/\n');
        store.writeStory(otherStoryId, { ...store.readStory(storyId), storyId: otherStoryId });
        store.writeChecklist(otherStoryId, { items: [] });
        store.writeTestEvidence(otherStoryId, signedEvidence);
        const replay = assessStoredValidationPassAdmissibility(ctx, otherStoryId, {allowDynamicCoverage:true});
        assert.equal(replay.ok, false);
        assert.ok(replay.reasonCodes.includes('validation_evidence_signature_invalid'), JSON.stringify(replay.reasonCodes));
        // Other-story files are owned test data, ignored before creation so they
        // cannot turn later signature controls into unrelated dirty-tree refusals.
        const expire = row => { const {signature,schema,...fields}=row; return createValidationCommandReceipt({...fields,createdAt:new Date(Date.now()-172800000).toISOString(),expiresAt:new Date(Date.now()-86400000).toISOString()}); };
        const refuse = label => assert.rejects(()=>runValidateGate(ctx,storyId,{stop(){}}),/dynamic_/,label);
        for (const [label, receipts] of [
          ['missing reused receipt', artifacts.receipts.filter(row=>row.id!==reuseId)],
          ['tampered reused signature', artifacts.receipts.map(row=>row.id===reuseId?{...row,signature:'invalid'}:row)],
          ['expired reused receipt', artifacts.receipts.map(row=>row.id===reuseId?expire(row):row)],
        ]) {
          persist(receipts);
          await refuse(label);
          if (label === 'missing reused receipt') {
            assert.throws(() => runDoneOracleGate(storyId, store, root, { stop() {} }, root),
              /Stored routine validation admission|dynamic_receipt_missing_invalid_expired_or_revoked/,
              'DONE must re-check the same required dynamic receipt');
          }
          persist(artifacts.receipts);
          await runValidateGate(ctx,storyId,{stop(){}});
        }
        const ledgerPath=join(root,'.proof-or-stop/runtime/dynamic-validation',storyId,'revocation-ledger.json');
        const originalLedger=readFileSync(ledgerPath);
        for (const content of [null,'{invalid']) {
          if(content===null)rmSync(ledgerPath);else writeFileSync(ledgerPath,content);
          await refuse('missing or malformed ledger');
          writeFileSync(ledgerPath,originalLedger);
          await runValidateGate(ctx,storyId,{stop(){}});
        }
        persist(artifacts.receipts,appendReceiptRevocation(artifacts.revocationLedger,[],[parsed.dynamicValidation.manifest.canonicalBaselineEpochId]));
        await refuse('revoked epoch');
        persist(artifacts.receipts);
        const ids=artifacts.receipts.map(row=>row.id);
        assert.ok(ids.length>0);
        persistStoryAwareValidationArtifacts({projectRoot:root,storyId,manifest:parsed.dynamicValidation.manifest,report:'owned revocation mutation',receipts:artifacts.receipts,revocationLedger:appendReceiptRevocation(artifacts.revocationLedger,ids)});
        await assert.rejects(()=>runValidateGate(ctx,storyId,{stop(){}}),undefined,'REVOKED_DYNAMIC_RECEIPTS_MUST_NOT_ENTER_TEST');
        // Owned fixture mutation: removing an unsigned presentation discriminator
        // must not turn revoked selective authority into an ordinary full PASS.
        const originalEvidence = store.readTestEvidence(storyId);
        const strippedOutput = JSON.parse(originalEvidence.output);
        delete strippedOutput.dynamicValidation;
        strippedOutput.provider = 'proof-or-stop-verifier';
        store.writeTestEvidence(storyId, {
          ...originalEvidence,
          output: JSON.stringify(strippedOutput),
        });
        await assert.rejects(() => runValidateGate(ctx, storyId, { stop() {} }), /validation evidence signature is missing or invalid/,
          'STRIPPED_DYNAMIC_AUTHORITY_MUST_NOT_BYPASS_REVOKED_RECEIPTS');
        assert.throws(() => runDoneOracleGate(storyId, store, root, { stop() {} }, root),
          /Stored routine validation admission|validation evidence signature is missing or invalid/,
          'DONE must not let a stripped dynamic marker skip stored-PASS authentication');
        assertSignatureRefusal();
        store.writeTestEvidence(storyId, originalEvidence);
        persist(artifacts.receipts);
        await runValidateGate(ctx, storyId, { stop() {} });
        console.log('DYN3_STORED_RECEIPT_INTEGRITY_PASS');
    }
    finally {
        if (store)
            releaseOwnerLease(store.storyDirPath(storyId));
        process.chdir(oldCwd);
        rmSync(root, { recursive: true, force: true });
    }
}
await runCase('REVIEW',true);
await runCase('REVIEW',false);
console.log('low-risk dynamic TEST PASS');
console.log('authority mutations rejected');
