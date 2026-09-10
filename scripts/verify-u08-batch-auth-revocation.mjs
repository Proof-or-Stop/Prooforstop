import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), repo = process.env.U08_REVOCATION_REPO ?? path.resolve(here, '..'), load = n => import(pathToFileURL(path.join(repo, 'packages/main/dist/core', n + '.js')));
const api = await load('reviewer-batch-producer');
if (process.argv[2] === 'check') {
    assert.throws(() => api.verifyExecutionBatchBinding({ root: process.argv[3], binding: JSON.parse(fs.readFileSync(process.argv[4])) }), /revoked|not admitted/);
    console.log('OTHER_WORKER_REFUSED');
    process.exit(0);
}
const { withSignedReviewerBatchFixture } = await import(pathToFileURL(path.join(repo, 'scripts/lab/u08-batch-admission/subject-fixture.mjs'))), { deriveReviewerBatchSubject } = await load('reviewer-batch-subject'), { classifyHostExecutionFailure } = await load('host-execution-readiness');
const { runSupervisedProviderProcess } = await import(pathToFileURL(path.join(repo, 'packages/main/dist/providers/supervised-process.js')));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'u08-revocation-real-'));
try {
    let c = fs.readFileSync(path.join(repo, 'scripts/lab/u08-batch-admission/provider-fixture.c'), 'utf8');
    c = c.replace('if(mode&&strcmp(mode,"auth")==0)', 'if((getenv("U08_FAILURE_FILE")&&access(getenv("U08_FAILURE_FILE"),F_OK)==0)||(mode&&strcmp(mode,"auth")==0))');
    fs.writeFileSync(path.join(base, 'fixture.c'), c);
    execFileSync('cc', [path.join(base, 'fixture.c'), '-o', path.join(base, 'codex')]);
    await withSignedReviewerBatchFixture(repo, async ({ root, store, storyId, begin }) => {
        begin();
        const subject = deriveReviewerBatchSubject(store, root, { storyId }), assignments = subject.requiredLanes.map(lane => ({ lane, kind: 'managed', host: 'codex' }));
        const auth = path.join(root, 'auth');
        fs.mkdirSync(auth);
        fs.writeFileSync(path.join(auth, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture' }));
        const prior = { ...process.env }, log = path.join(root, 'probes.log'), flag = path.join(root, 'auth-revoked');
        Object.assign(process.env, { PATH: base + path.delimiter + process.env.PATH, CODEX_HOME: auth, U08_FIXTURE_MODE: 'ready', U08_FIXTURE_PROBE_LOG: log, U08_FAILURE_FILE: flag });
        const req = { root, store, storyId, epochId: subject.subject.binding.epochId, wave: subject.subject.binding.wave, assignments };
        try {
            const first = await api.admitReviewerBatch(req);
            assert.equal(first.state, 'ADMITTED');
            const env = { ...process.env };
            const consumed = await api.consumeReviewerBatchAdmission({ root, store, storyId, lane: assignments[0].lane, host: 'codex', profile: 'managed_reviewer', effectiveBaseEnvironment: env });
            fs.writeFileSync(flag, 'auth disabled');
            const result = runSupervisedProviderProcess(path.join(base, 'codex'), ['exec', '--json', '-'], { cwd: root, env, timeoutMs: 2000, stdin: 'real review' });
            assert.equal(classifyHostExecutionFailure({ ...result, signal: result.signal ?? null }), 'auth');
            const count = fs.readFileSync(log, 'utf8');
            const revoke = () => api.revokeExecutionBatchBinding({ root, binding: consumed.binding, effectiveBaseEnvironment: env });
            const { reviewerBatchInputIdentity } = await load('reviewer-batch-admission');
            const { REVIEWER_BATCH_ADMISSION_ARTIFACT, resolveCanonicalRuntimeProjectRoot } = await load('runtime-artifact-registry');
            const { PROOF_OR_STOP_DIR } = await load('proof-or-stop-paths');
            const directory = path.join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', REVIEWER_BATCH_ADMISSION_ARTIFACT.directoryName, reviewerBatchInputIdentity(consumed.binding.subjectIdentity));
            const active = path.join(directory, 'active.json');
            const terminal = path.join(directory, `generation-${first.generation}.json`);
            const revocationFile = path.join(directory, `generation-${first.generation}-revocation.json`);
            const activeBefore = fs.readFileSync(active, 'utf8');
            const terminalBefore = fs.readFileSync(terminal, 'utf8');
            const rename = fs.renameSync;
            let injected = false;
            fs.renameSync = function (from, to) {
                if (to === active && !injected) {
                    injected = true;
                    throw new Error('U08_REVOCATION_PUBLICATION_INTERRUPTED');
                }
                return rename.apply(this, arguments);
            };
            syncBuiltinESMExports();
            try {
                await assert.rejects(revoke, /U08_REVOCATION_PUBLICATION_INTERRUPTED/);
            }
            finally {
                fs.renameSync = rename;
                syncBuiltinESMExports();
            }
            assert.equal(injected, true);
            assert.equal(fs.readFileSync(active, 'utf8'), activeBefore);
            assert.equal(fs.readFileSync(terminal, 'utf8'), terminalBefore);
            assert.throws(() => api.verifyExecutionBatchBinding({ root, binding: consumed.binding, effectiveBaseEnvironment: env }), /revoked/);
            const revocationBytes = fs.readFileSync(revocationFile, 'utf8');
            const corrupted = JSON.parse(revocationBytes);
            corrupted.reason = 'caller-forged-reason';
            fs.writeFileSync(revocationFile, JSON.stringify(corrupted));
            assert.throws(() => api.verifyExecutionBatchBinding({ root, binding: consumed.binding, effectiveBaseEnvironment: env }), /revoked/);
            assert.equal((await api.admitReviewerBatch(req)).state, 'UNKNOWN');
            assert.equal(fs.readFileSync(log, 'utf8'), count);
            fs.writeFileSync(revocationFile, revocationBytes);
            const recovered = await api.admitReviewerBatch(req);
            assert.equal(recovered.state, 'BLOCKED');
            assert.equal(recovered.reason, 'provider-auth-revoked');
            assert.equal(JSON.parse(fs.readFileSync(active, 'utf8')).state, 'BLOCKED');
            assert.equal(fs.readFileSync(terminal, 'utf8'), terminalBefore);
            assert.equal(fs.readFileSync(log, 'utf8'), count);
            assert.equal((await revoke()).reason, 'provider-auth-revoked');
            assert.equal((await revoke()).reason, 'provider-auth-revoked');
            console.log('PASS signed tamper refuses and interrupted revocation publication recovers without probe or terminal overwrite');
            const bindingFile = path.join(root, 'binding.json');
            fs.writeFileSync(bindingFile, JSON.stringify(consumed.binding));
            const out = execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'check', root, bindingFile], { encoding: 'utf8', env });
            assert.match(out, /OTHER_WORKER_REFUSED/);
            assert.equal(fs.readFileSync(log, 'utf8'), count);
            assert.equal((await api.admitReviewerBatch(req)).state, 'BLOCKED');
            assert.equal(fs.readFileSync(log, 'utf8'), count);
            console.log('PASS native READY -> actual classified auth -> signed idempotent revoke -> separate worker refuses; zero reprobe');
            fs.rmSync(flag);
            process.env.U08_NEW_OWNER_INPUT = 'new-generation';
            const next = await api.admitReviewerBatch(req);
            assert.equal(next.state, 'ADMITTED');
            assert.ok(next.generation > first.generation);
            const stale = await revoke();
            assert.equal(stale.state, 'UNKNOWN');
            assert.equal(stale.reason, 'revocation-generation-not-current');
            assert.equal((await api.admitReviewerBatch(req)).state, 'ADMITTED');
            console.log('PASS stale generation auth does not revoke newer admission');
        }
        finally {
            for (const k of Object.keys(process.env))
                if (!(k in prior))
                    delete process.env[k];
            Object.assign(process.env, prior);
        }
    });
}
finally {
    fs.rmSync(base, { recursive: true, force: true });
}
