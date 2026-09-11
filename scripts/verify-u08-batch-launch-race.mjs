// Bounded source-fragment regression: executes the exact worker verify/grant block,
// using real native admission, signed revocation and mkdir locks; no scratch build.
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
            const { acquireMkdirLock } = await load('mkdir-lock');
            const { reviewerBatchInputIdentity } = await load('reviewer-batch-admission');
            const { REVIEWER_BATCH_ADMISSION_ARTIFACT, resolveCanonicalRuntimeProjectRoot } = await load('runtime-artifact-registry');
            const { PROOF_OR_STOP_DIR } = await load('proof-or-stop-paths');
            const directory = path.join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', REVIEWER_BATCH_ADMISSION_ARTIFACT.directoryName, reviewerBatchInputIdentity(consumed.binding.subjectIdentity));
            const source = fs.readFileSync(path.join(repo, 'packages/main/src/core/managed-host-run.ts'), 'utf8');
            const resultStart = source.indexOf('  let result: HostRunResult | null = null;');
            const grantStart = source.indexOf('    const grantLaunch =', resultStart);
            const from = grantStart >= 0 ? grantStart : source.indexOf('    if (spec.executionAdmission) {', resultStart);
            const to = source.indexOf('    if (launchRefusal) {', from);
            assert.ok(from > 0 && to > from);
            const snippet = source.slice(from, to) + '\nreturn launchRefusal;';
            const { createRequire } = await import('node:module');
            const ts = createRequire(path.join(repo, 'package.json'))('typescript');
            const javascript = ts.transpileModule('async function boundary(){' + snippet + '}', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
            const reservation = { runId: 'grant-race-run', deadlineAt: Date.now() + 60000 };
            api.reserveExecutionBatchLaunch({ root, binding: consumed.binding, effectiveBaseEnvironment: env, ...reservation });
            let pendingRevocation, grants = 0;
            const verifyAfterBinding = async () => {
                api.verifyExecutionBatchBinding({ root, binding: consumed.binding, effectiveBaseEnvironment: env });
                pendingRevocation = api.revokeExecutionBatchBinding({ root, binding: consumed.binding, effectiveBaseEnvironment: env });
                // A shared launch/controller lock makes revocation wait until the grant callback.
                // Without that common lock it completes at this actual await boundary.
                if (!fs.existsSync(path.join(directory, 'controller.lock')))
                    await pendingRevocation;
            };
            const verify = async (_args, grant) => {
                if (grant)
                    return api.withVerifiedExecutionBatchLaunch({ root, binding: consumed.binding, effectiveBaseEnvironment: env, launchReservation: reservation }, async () => { await verifyAfterBinding(); return grant(); });
                return verifyAfterBinding();
            };
            const terminalLock = (_paths, callback) => {
                const lock = acquireMkdirLock(path.join(root, 'race-terminal.lock'));
                try {
                    return callback();
                }
                finally {
                    lock.release();
                }
            };
            const grant = () => {
                const active = JSON.parse(fs.readFileSync(path.join(directory, 'active.json')));
                assert.equal(active.state, 'ADMITTED', 'U08_REVOKED_BATCH_MUST_NOT_GRANT_WAITING_WORKER');
                assert.equal(fs.existsSync(path.join(directory, `generation-${consumed.binding.generation}-revocation.json`)), false, 'U08_DURABLE_REVOCATION_MUST_WIN_GRANT');
                grants++;
            };
            const bindings = { spec: { executionAdmission: { version: 1, binding: { execution: consumed.binding, launchReservation: { runId: reservation.runId, deadlineAt: new Date(reservation.deadlineAt).toISOString() } } }, profile: 'managed_reviewer', root, deadlineAt: new Date(Date.now() + 60000).toISOString() }, readonlyLane: {}, oneShotEnvironment: env, providerEnvironment: env, deps: {}, capability: '', owner: { specDigest: 'spec' }, paths: {}, readManagedHostRunSpec: () => ({ text: 'spec' }), sha256: x => x, verifyManagedLaunchAdmission: verify, withTerminalAuthorityLock: terminalLock, readTerminal: () => null, readManagedHostRunSnapshot: () => ({ providerLaunchState: 'pending' }), readCancelRequest: () => null, now: Date.now, updateSnapshotUnlocked: grant,
                withVerifiedExecutionBatchLaunch: api.withVerifiedExecutionBatchLaunch };
            const boundary = Function(...Object.keys(bindings), javascript + ';return boundary;')(...Object.values(bindings));
            await boundary();
            if (pendingRevocation)
                await pendingRevocation;
            assert.equal(grants, 1);
            assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'active.json'))).state, 'BLOCKED');
            console.log('U08_WORKER_GRANT_REVOCATION_LINEARIZATION_PASS');
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
