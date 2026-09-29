// Verification capability implementation; shared state is imported explicitly.
import { strict as assert } from 'node:assert';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { narrowVerificationPin, refreshStaleEvidenceMetadataOnly } from '../../handlers/checklist.js';

import { currentMaterialHash, currentStoryFilesHash } from '../../core/evidence-freshness.js';

import type { VerificationEvidence } from '../../core/types.js';
import { planVerificationExecutionReuse, prepareVerificationExecutionIdentity, validateVerificationReceipt, createVerificationExecutionReceipt, createVerificationAssertionReceipt, withVerificationExecutionLocks, verificationExecutionLockPath } from '../../core/verification-execution-evidence.js';

import { runSingleAllowlistedCommand } from '../../core/validation-executor.js';

import { verificationReuseCapsuleEnforcementSupported } from '../../core/verification-reuse-capsule.js';

import { makeEnv, intent, PASS_CMD, SELECTOR, git, commitRefreshDrift, findEvidence, gateCoverage, cleanup, HERE, collectRepairChecks, write, seedPinnedReceipt, verificationFreshnessHashBinding, doneIdentityPreview, evidenceContext, splitReceipt, writeCapsuleManifest, capsuleCommand } from './support.js';

export async function partMLegacyMetadataMaintenance(): Promise<void> {
  for (const mode of ['sync', 'async'] as const) {
    const ids = ['MANUAL', 'COMMAND', 'FAILED', 'WAIVER', 'DEFERRED', 'NOHEAD', 'CURRENT', 'PINNED', 'RECEIPT'];
    const env = makeEnv(`B-aa5f-legacy-${mode}`, ids.map(id => intent(id, 'logic',
      id === 'PINNED' ? { command: PASS_CMD, selector: SELECTOR } : undefined)));
    try {
      const old = {
        headHash: git(env.root, ['rev-parse', 'HEAD']),
        materialHash: currentMaterialHash(env.root, 'HEAD', env.root),
        storyFilesHash: currentStoryFilesHash(env.root, 'HEAD', env.root),
      };
      const rows: VerificationEvidence[] = ids.map(id => ({
        intentRef: id, kind: 'manual_transcript', result: 'pass', note: `retained ${id}`, ...old,
      }));
      rows[1].command = PASS_CMD;
      rows[2].result = 'fail';
      rows[3].kind = 'waiver';
      rows[4].kind = 'waiver'; rows[4].waiverType = 'deferred_gate_evidence';
      delete rows[5].headHash;
      // An invalid receipt-shaped legacy row must not enter the receipt-less fallback.
      rows[8].receipt = { exitCode: 0, selectorMatched: true } as VerificationEvidence['receipt'];
      const cl = env.store.readChecklist(env.storyId);
      cl.items[0].verificationEvidence = rows;
      env.store.writeChecklist(env.storyId, cl);
      commitRefreshDrift(env, `F089-${mode}`);
      const current = {
        headHash: git(env.root, ['rev-parse', 'HEAD']),
        materialHash: currentMaterialHash(env.root, 'HEAD', env.root),
        storyFilesHash: currentStoryFilesHash(env.root, 'HEAD', env.root),
      };
      Object.assign(rows[6], current);
      env.store.writeChecklist(env.storyId, cl);
      const before = structuredClone(env.store.readChecklist(env.storyId));
      const refresh = async (dryRun: boolean) => mode === 'sync'
        ? refreshStaleEvidenceMetadataOnly({ store: env.store, root: env.root, scanRoot: join(env.root, 'packages/main') }, env.storyId, dryRun)
        : await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId, dryRun });
      const preview = await refresh(true);
      assert.match(preview, /DRY-RUN/, `F089 ${mode}: stale receipt-less rows remain maintenance candidates`);
      assert.deepEqual(env.store.readChecklist(env.storyId), before, `F089 ${mode}: dry-run is read-only`);
      const output = await refresh(false);
      assert.match(output, /Refreshed 2\/2 stale evidence/, `F089 ${mode}: refresh only eligible stale legacy rows`);
      for (const id of ['MANUAL', 'COMMAND']) {
        const row = findEvidence(env, id)!;
        assert.equal(row.headHash, current.headHash);
        assert.equal(row.materialHash, current.materialHash);
        assert.equal(row.storyFilesHash, current.storyFilesHash);
        assert.equal(row.note, `retained ${id}`);
        assert.equal(row.receipt, undefined, `F089 ${mode}: no receipt is invented`);
        assert.notEqual(row.mechanical, true, `F089 ${mode}: metadata never grants execution authority`);
        assert.equal(gateCoverage(env).entries.find(e => e.intentRef === id)?.status,
          id === 'MANUAL' ? 'non_mechanical' : 'stale',
          'F089: manual remains non-mechanical; audited command demotion still requires execution');
      }
      assert.equal(findEvidence(env, 'COMMAND')?.mechanical, false, 'F089: unexecuted command-backed PASS is explicitly demoted');
      assert.match(findEvidence(env, 'COMMAND')?.nonMechanicalReason ?? '', /receipt invalidated/);
      for (const id of ids.slice(2)) {
        assert.deepEqual(findEvidence(env, id), before.items[0].verificationEvidence!.find(e => e.intentRef === id),
          `F089 ${mode}: failed, waived, deferred, missing-head, current, pinned and receipt-bearing rows are not restamped`);
      }
      assert.equal(env.launchCounter.count, 0, `F089 ${mode}: metadata-only rows never launch a subprocess`);
    } finally { cleanup(env); }
  }
  console.log('B-aa5f F089 legacy-metadata-maintenance PASS');
}

export async function partNLiveProducerOwnership(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-baa5f-lock-regression-'));
  const wait = (ms: number) => new Promise<void>(resolveWait => setTimeout(resolveWait, ms));
  const events: Array<{ event: string; label: string; pid: number; ppid: number; at: number; childPid?: number }> = [];
  const workers: Array<{ proc: ChildProcess; done: Promise<number | null> }> = [];
  const paused = new Set<ChildProcess>();
  const childOwners = new Map<number, number>();
  const active = new Set<number>();
  let maximum = 0;
  const workerCode = `
    import { spawn } from 'node:child_process';
    const [moduleUrl, root, key, label, duration, mode] = process.argv.slice(1);
    const emit = (event, extra = {}) => console.log(JSON.stringify({ event, label, pid: process.pid, ppid: process.ppid, at: Date.now(), ...extra }));
    const { withVerificationExecutionLocks } = await import(moduleUrl);
    if (mode === 'choosing-A' || mode === 'choosing-B') {
      // Deterministic filesystem interleaving in owned child processes only.
      // These UUIDs are acquisition tie-breakers, not session/receipt identities.
      const fs = (await import('node:fs')).default;
      const crypto = (await import('node:crypto')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      const ownId = mode === 'choosing-A' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001';
      crypto.randomUUID = () => ownId;
      const rename = fs.renameSync, lstat = fs.lstatSync;
      let ownTicketPublished = false;
      const barrier = name => root + '/' + name;
      const waitFile = path => {
        const limit = Date.now() + 10000;
        while (!fs.existsSync(path)) {
          if (Date.now() > limit) throw new Error('choosing interleaving barrier timed out: ' + path);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      };
      fs.renameSync = (from, to) => {
        if (String(from).endsWith(ownId + '.choosing')) {
          if (mode === 'choosing-B') { emit('choosing-pending'); waitFile(barrier('allow-b-publication')); }
          rename(from, to); ownTicketPublished = true;
          if (mode === 'choosing-B') fs.writeFileSync(barrier('b-published'), 'published');
          return;
        }
        return rename(from, to);
      };
      fs.lstatSync = (path, ...args) => {
        if (mode === 'choosing-A' && ownTicketPublished && String(path).endsWith('00000000-0000-4000-8000-000000000001.choosing')) {
          emit('choosing-snapshot-observed');
          fs.writeFileSync(barrier('allow-b-publication'), 'publish');
          waitFile(barrier('b-published'));
        }
        return lstat(path, ...args);
      };
      syncBuiltinESMExports();
    }
    emit('worker-ready');
    await withVerificationExecutionLocks(root, [key], async () => {
      emit('acquired');
      if (mode === 'exit-owner') process.exit(0); // Deliberately no child: this proves dead-holder recovery, not orphan-child containment.
      const child = spawn(process.execPath, ['-e',
        'const label=process.argv[1]; const emit=event=>console.log(JSON.stringify({event,label,pid:process.pid,ppid:process.ppid,at:Date.now()})); emit("child-start"); setTimeout(()=>emit("child-end"), Number(process.argv[2]));', label, duration],
        { stdio: ['ignore', 'inherit', 'inherit'] });
      emit('child-spawned', { childPid: child.pid });
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      if (code !== 0) throw new Error('owned child failed: ' + code);
    });
    emit('complete');
  `;
  const start = (key: string, label: string, duration: number, mode = 'normal') => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', workerCode,
      pathToFileURL(join(HERE, '../core/verification-execution-evidence.js')).href, root, key, label, String(duration), mode],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    let parseError: unknown;
    proc.stdout!.on('data', chunk => {
      pending += String(chunk);
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n'); const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line) continue;
        try {
          const row = JSON.parse(line) as typeof events[number];
          events.push(row);
          console.log(`F088 owned-process ${line}`);
          if (row.event === 'child-spawned') childOwners.set(row.childPid!, row.pid);
          if (row.event === 'child-start') {
            assert.equal(childOwners.get(row.pid), row.ppid, 'F088: real leaf belongs to a spawned fixture worker');
            active.add(row.pid); maximum = Math.max(maximum, active.size);
          }
          if (row.event === 'child-end') active.delete(row.pid);
        } catch (error) { parseError = error; }
      }
    });
    proc.stderr!.on('data', chunk => console.error(`F088 ${label}: ${String(chunk).trim()}`));
    const done = new Promise<number | null>((resolveDone, reject) => {
      proc.once('error', reject);
      proc.once('close', code => parseError ? reject(parseError) : resolveDone(code));
    });
    const worker = { proc, done }; workers.push(worker); return worker;
  };
  const within = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`F088 owned-process deadline ${timeoutMs}ms`)), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const event = async (name: string, label: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = events.find(e => e.event === name && e.label === label);
      if (row) return row;
      await wait(20);
    }
    throw new Error(`F088 missing ${name} for ${label}`);
  };
  try {
    let concurrent = 0; let maxLocal = 0;
    await within(Promise.all(Array.from({ length: 3 }, () => withVerificationExecutionLocks(root, ['same-process'], async () => {
      concurrent++; maxLocal = Math.max(maxLocal, concurrent); await wait(40); concurrent--;
    }))), 5000);
    assert.equal(maxLocal, 1, 'F088: same-process Promise contention must yield the event loop');
    await assert.rejects(withVerificationExecutionLocks(root, ['throwing'], async () => { throw new Error('owned callback failure'); }), /owned callback failure/);
    await within(withVerificationExecutionLocks(root, ['throwing'], async () => undefined), 5000);
    const healthyA = start('healthy', 'healthy-A', 400);
    await event('child-start', 'healthy-A');
    const healthyB = start('healthy', 'healthy-B', 400);
    assert.deepEqual(await within(Promise.all([healthyA.done, healthyB.done]), 10_000), [0, 0]);
    assert.equal(maximum, 1, 'F088: healthy actual subprocesses serialize');
    if (process.platform !== 'win32') {
      const a = start('paused-live', 'paused-A', 37_000);
      const leaf = await event('child-start', 'paused-A');
      assert.equal(leaf.ppid, a.proc.pid);
      process.kill(a.proc.pid!, 0); process.kill(leaf.pid, 0);
      a.proc.kill('SIGSTOP'); paused.add(a.proc);
      const pausedAt = Date.now();
      await wait(31_000); // Real lease expiry is the fault, never a forged mtime or clock.
      assert.ok(Date.now() - pausedAt > 30_000);
      process.kill(a.proc.pid!, 0); process.kill(leaf.pid, 0);
      const state = execFileSync('ps', ['-p', String(a.proc.pid), '-o', 'state='], { encoding: 'utf8' });
      assert.match(state, /T/, 'F088: exact owned worker is still live and stopped');
      const b = start('paused-live', 'paused-B', 600);
      await event('worker-ready', 'paused-B');
      await wait(700);
      process.kill(a.proc.pid!, 0); process.kill(leaf.pid, 0);
      console.log(`F088 realPauseMs=${Date.now() - pausedAt} ownerAlive=true childAlive=true maxSimultaneous=${maximum}`);
      a.proc.kill('SIGCONT'); paused.delete(a.proc);
      assert.deepEqual(await within(Promise.all([a.done, b.done]), 15_000), [0, 0]);
      assert.equal(maximum, 1, 'F088: a live paused owner beyond 30s must not permit a second live producer');
      const aEnd = events.find(e => e.event === 'child-end' && e.label === 'paused-A')!;
      const bStart = events.find(e => e.event === 'child-start' && e.label === 'paused-B')!;
      assert.ok(bStart.at >= aEnd.at, 'F088: successor starts only after predecessor child completes');
    } else {
      console.log('F088 POSIX SIGSTOP case not executed on win32; native Windows pause coverage is not claimed');
    }
    // B chooses ticket 1 first, A chooses the same number with a later UUID.
    // Publish B between A's readdir and lstat of B.choosing: ENOENT must rescan,
    // not silently omit B and let both real child commands acquire.
    const choosingB = start('choosing-race', 'choosing-B', 500, 'choosing-B');
    await event('choosing-pending', 'choosing-B');
    const choosingA = start('choosing-race', 'choosing-A', 100, 'choosing-A');
    await event('choosing-snapshot-observed', 'choosing-A');
    assert.deepEqual(await within(Promise.all([choosingA.done, choosingB.done]), 10_000), [0, 0]);
    assert.equal(maximum, 1, 'F088: choosing-to-ticket publication invalidates the entire reader snapshot');
    const dead = start('dead-owner', 'dead-owner', 0, 'exit-owner');
    await event('acquired', 'dead-owner');
    assert.equal(await within(dead.done, 5000), 0);
    assert.throws(() => process.kill(dead.proc.pid!, 0), /ESRCH/);
    const recovery = start('dead-owner', 'dead-recovery', 50);
    assert.equal(await within(recovery.done, 35_000), 0, 'F088: a genuinely exited owner without an orphan child is recoverable');
    // Legacy/malformed runtime layouts must fail closed; these are not forged receipts.
    for (const layout of ['legacy', 'malformed']) {
      const path = verificationExecutionLockPath(root, layout);
      mkdirSync(path, { recursive: true });
      const originalOwner = layout === 'legacy'
        ? JSON.stringify({ ownerId: 'owned-legacy-control', pid: process.pid, acquiredAt: new Date().toISOString() }) : '{';
      writeFileSync(join(path, 'owner.json'), originalOwner);
      const blocked = start(layout, layout, 50);
      await event('worker-ready', layout);
      await wait(100);
      assert.equal(events.some(e => e.event === 'acquired' && e.label === layout), false, 'F088: existing ownership is never ignored');
      if (blocked.proc.exitCode === null && blocked.proc.signalCode === null) blocked.proc.kill('SIGTERM');
      await within(blocked.done, 5000);
      assert.equal(readFileSync(join(path, 'owner.json'), 'utf8'), originalOwner);
    }
    const ownedQueue = verificationExecutionLockPath(root, 'healthy');
    assert.deepEqual(readdirSync(ownedQueue), ['protocol'], 'F088: normal release leaves no acquisition token');
    const partialToken = join(ownedQueue, '0000000000000001-00000000-0000-4000-8000-000000000003.ticket');
    const partialBytes = JSON.stringify({ schemaVersion: 'proof-or-stop.verification-execution-ticket.v1', ownerId: '00000000-0000-4000-8000-000000000003' });
    writeFileSync(partialToken, partialBytes);
    let enteredPartial = false;
    await assert.rejects(withVerificationExecutionLocks(root, ['healthy'], async () => { enteredPartial = true; }), /verification_execution_lock_invalid_owner/);
    assert.equal(enteredPartial, false, 'F088: partial ticket ownership cannot grant admission');
    assert.equal(readFileSync(partialToken, 'utf8'), partialBytes, 'F088: malformed ownership is not silently reclaimed');
    rmSync(partialToken);
    console.log('B-aa5f F088 live-producer-ownership PASS');
  } finally {
    for (const proc of paused) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGCONT');
    for (const pid of active) {
      try { process.kill(pid, 'SIGTERM'); } catch (error: any) { if (error?.code !== 'ESRCH') throw error; }
    }
    for (const { proc } of workers) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    await within(Promise.all(workers.map(w => w.done)), 5000);
    rmSync(root, { recursive: true, force: true });
  }
}

export async function partIIdentityDrift(): Promise<void> {
  await collectRepairChecks(async check => {
    for (const drift of ['environment', 'toolchain'] as const) {
      const external = mkdtempSync(join(tmpdir(), 'baa5f-live-identity-'));
      const log = join(external, 'children.jsonl');
      const bin = join(external, 'bin');
      mkdirSync(bin);
      writeFileSync(log, '');
      const priorPath = process.env.PATH;
      const key = 'B_AA5F_REAL_ENVIRONMENT_CHANGE';
      const priorValue = process.env[key];
      process.env.PATH = `${bin}:${priorPath ?? ''}`;
      process.env[key] = 'normal-control';
      const childCode = (tag: string, version: string) =>
        `require('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({tag:${JSON.stringify(tag)},pid:process.pid})+'\\n');` +
        `console.log('IDENTITY_A IDENTITY_B',${JSON.stringify(version)},process.env.${key})`;
      const wrapper = join(bin, 'npm');
      const writeTool = (version: string) => {
        writeFileSync(wrapper, `#!${process.execPath}\n${childCode('tool', version)}\n`);
        chmodSync(wrapper, 0o755);
      };
      writeTool('tool-v1');
      const commands = drift === 'environment'
        ? ['one', 'two'].map(tag => `node -e ${JSON.stringify(childCode(tag, 'env-verifier'))}`)
        : ['npm --version', `node -e ${JSON.stringify(childCode('node-control', 'unchanged'))}`];
      const refs = ['LIVE-0-A', 'LIVE-0-B', 'LIVE-1-A', 'LIVE-1-B'];
      const env = makeEnv(`B-aa5f-live-${drift}`, refs.map(ref => intent(ref, 'cli')));
      try {
        // Ignore fixture-owned runtime/artifacts before earning any receipts.
        // DONE's clean-tree gate must pass honestly; it
        // must not be bypassed or mistake the fixture's own cache for source.
        write(env.root, '.gitignore', '.proof-or-stop/evidence/\n.proof-or-stop/runtime/\n.proof-or-stop/locks/\n.proof-or-stop/learning/runtime-memory-pack-cache/\n');
        git(env.root, ['add', '.gitignore']);
        git(env.root, ['commit', '-m', 'ignore fixture runtime artifacts before execution']);
        for (let index = 0; index < refs.length; index++) {
          await seedPinnedReceipt(env, { intentRef: refs[index], command: commands[Math.floor(index / 2)], selector: index % 2 ? 'IDENTITY_B' : 'IDENTITY_A' });
        }
        const before = env.store.readChecklist(env.storyId);
        const gitBefore = verificationFreshnessHashBinding(env, refs[0]);
        assert.equal(gateCoverage(env).entries.filter(entry => entry.status === 'covered').length, 4, `F057 ${drift}: unchanged-input control is admissible`);
        const normalDone = await doneIdentityPreview(env);
        assert.match(normalDone.transcript, /staleEvidenceRefresh: PASS/,
          `F057 ${drift}: normal DONE classification reaches its real freshness step\n${normalDone.transcript}`);
        assert.match(refreshStaleEvidenceMetadataOnly(evidenceContext(env), env.storyId, true), /No stale verification evidence/);
        console.log(`F057 ${drift} normal-control admissible=true doneFresh=true`);
        const oldIdentity = splitReceipt(env, refs[0]).executionReceipt;
        if (drift === 'environment') process.env[key] = 'changed-after-signed-execution';
        else writeTool('tool-v2-real-behavior-change');
        const currentIdentity = prepareVerificationExecutionIdentity({ command: commands[0], cwd: env.root, effectiveTimeoutMs: oldIdentity.effectiveTimeoutMs });
        assert.notEqual(currentIdentity.executionIdentityDigest, oldIdentity.executionIdentityDigest, 'F057: live execution identity really changed');
        assert.notEqual(drift === 'environment' ? currentIdentity.environmentDigest : currentIdentity.toolchainDigest,
          drift === 'environment' ? oldIdentity.environmentDigest : oldIdentity.toolchainDigest);
        assert.deepEqual(env.store.readChecklist(env.storyId), before, 'F057: drift changed no receipt bytes');
        assert.deepEqual(verificationFreshnessHashBinding(env, refs[0]), gitBefore, 'F057: drift changed no Git freshness bindings');
        await check(`F057 ${drift} gate denies actual live drift`, () => {
          const coverage = gateCoverage(env);
          assert.equal(coverage.entries[0].status, 'stale', 'changed live identity must be stale-needs-execution, not covered/non_mechanical');
          const diagnostic = coverage.entries[0]?.evidence?.nonMechanicalReason ?? '';
          assert.match(diagnostic, new RegExp(`${drift}_digest_changed`),
            `F057 ${drift}: stale diagnostic must identify the execution identity component that changed: ${diagnostic}`);
          assert.doesNotMatch(diagnostic, /missing_dependency_manifest/,
            `F057 ${drift}: missing reuse authority must not be reported as the live identity mismatch: ${diagnostic}`);
          if (drift === 'toolchain') assert.equal(coverage.entries[2].status, 'covered', 'unaffected executable remains current');
        });
        await check(`F057 ${drift} refresh selects actual live drift`, () => {
          assert.doesNotMatch(refreshStaleEvidenceMetadataOnly(evidenceContext(env), env.storyId, true), /No stale verification evidence/);
        });
        await check(`F057 ${drift} DONE selects actual live drift`, async () => {
          const preview = await doneIdentityPreview(env);
          assert.equal(preview.blockedAt, 'evidenceFreshness', preview.transcript);
          assert.match(preview.transcript, /staleEvidenceRefresh: BLOCKED/);
          assert.ok(preview.transcript.includes(commands[0]), 'DONE names the affected command');
        });
        writeFileSync(log, '');
        env.launchCounter.count = 0;
        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        const launches = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { pid: number; tag: string });
        const expected = drift === 'environment' ? 2 : 1;
        await check(`F057 ${drift} real refresh launches each affected identity once`, () => {
          assert.equal(launches.length, expected, 'actual child-written log counts executions, not receipt publications');
          assert.equal(new Set(launches.map(row => row.pid)).size, expected);
          assert.equal(env.launchCounter.count, expected);
          if (drift === 'toolchain') assert.deepEqual(launches.map(row => row.tag), ['tool']);
          assert.equal(gateCoverage(env).entries.filter(entry => entry.status === 'covered').length, 4, 'renewed observations are admissible');
          for (const ref of refs) {
            const receipt = splitReceipt(env, ref);
            assert.equal(receipt.executionReceipt.inputClosureComplete, false);
            assert.equal(receipt.reuseReceipt, undefined, 'ordinary execution never earns persistent reuse');
          }
        });
      } finally {
        cleanup(env);
        if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
        if (priorValue === undefined) delete process.env[key]; else process.env[key] = priorValue;
        rmSync(external, { recursive: true, force: true });
      }
    }
  });
}

export async function partJPublicationBinding(): Promise<void> {
  const env = makeEnv('B-aa5f-publication-binding', [intent('PUB-A', 'cli'), intent('PUB-B', 'cli')]);
  try {
    await seedPinnedReceipt(env, { intentRef: 'PUB-A', command: PASS_CMD, selector: SELECTOR });
    await seedPinnedReceipt(env, { intentRef: 'PUB-B', command: PASS_CMD, selector: SELECTOR });
    assert.equal(gateCoverage(env).entries.filter(entry => entry.status === 'covered').length, 2, 'F058: genuine current normal controls are admissible');
    const originals = env.store.readChecklist(env.storyId);
    // Retained low-level legacy issuer observes a REAL child; no manufactured
    // result, static key, copied cwd, schema-string downgrade or signature edit.
    const run = await runSingleAllowlistedCommand(PASS_CMD, env.root, { cwd: env.root });
    const execution = createVerificationExecutionReceipt({ projectRoot: env.root, storyId: env.storyId, command: PASS_CMD, cwd: env.root, run });
    const legacy = createVerificationAssertionReceipt({ projectRoot: env.root, storyId: env.storyId, executionReceipt: execution, intentRef: 'PUB-A', selector: SELECTOR });
    assert.equal(legacy.schemaVersion, 'proof-or-stop.verification-receipt-bundle.v4');
    assert.equal(validateVerificationReceipt(env.root, legacy, { storyId: env.storyId, intentRef: 'PUB-A', selector: SELECTOR }).ok, true);
    const original = { ...findEvidence(env, 'PUB-A')!, receipt: legacy };
    commitRefreshDrift(env, 'actual-publication-material-change');
    const attack: VerificationEvidence = {
      ...original,
      headHash: git(env.root, ['rev-parse', 'HEAD']),
      materialHash: currentMaterialHash(env.root, 'HEAD', env.root),
      storyFilesHash: currentStoryFilesHash(env.root, 'HEAD', env.root),
    };
    assert.notEqual(original.materialHash, attack.materialHash, 'F058: actual fixture material drift happened');
    assert.deepEqual(attack.receipt, original.receipt, 'F058: every legacy signed byte is unchanged');
    const attacked = env.store.readChecklist(env.storyId);
    attacked.items[0].verificationEvidence = [attack];
    console.log('F058 controls actualLegacyExecution=true authenticAuditReadable=true materialDrift=true signedBytesChanged=false');
    assert.notEqual(gateCoverage(env, attacked).entries[0].status, 'covered',
      'F058 unsigned outer tuple rewrite must not launder an old signed V4 execution into current admission');
    // Reached only once the genuine baseline defect is fixed. These assertions
    // remain identical for GREEN and bind the full new-publication contract.
    const deniedReuse = planVerificationExecutionReuse({ projectRoot: env.root, storyId: env.storyId, priorReceipt: legacy,
      intentRef: 'PUB-A', selector: SELECTOR, command: PASS_CMD, cwd: env.root, effectiveTimeoutMs: run.timeoutMs,
      freshnessHashBinding: { evidenceHeadHash: attack.headHash, evidenceMaterialHash: attack.materialHash,
        evidenceStoryFilesHash: attack.storyFilesHash, currentHeadHash: attack.headHash,
        currentMaterialHash: attack.materialHash, currentStoryFilesHash: attack.storyFilesHash } });
    assert.equal(deniedReuse.reusable, false, 'legacy history has no reuse authority');
    assert.equal(validateVerificationReceipt(env.root, legacy, { storyId: env.storyId, intentRef: 'PUB-A', selector: SELECTOR }).promotable, false);
    env.store.writeChecklist(env.storyId, attacked);
    assert.throws(() => narrowVerificationPin(evidenceContext(env), { storyId: env.storyId, itemId: 'CHK-001', intentRef: 'PUB-A',
      selector: `${SELECTOR} stricter`, reason: 'legacy signed observations cannot authorize a new current narrowing' }),
    /not_authoritative|legacy/i, 'F058 authentic legacy V4 is not a narrowing witness');
    assert.deepEqual(env.store.readChecklist(env.storyId), attacked, 'F058 refused legacy narrowing rewrites nothing');
    const renewal = structuredClone(originals);
    renewal.items[0].verificationEvidence![0] = original;
    env.store.writeChecklist(env.storyId, renewal);
    env.launchCounter.count = 0;
    await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
    assert.equal(env.launchCounter.count, 1, 'authentic legacy renewal requires a real child');
    const current = findEvidence(env, 'PUB-A')!;
    const sibling = findEvidence(env, 'PUB-B')!;
    assert.deepEqual((current.receipt as any).executionReceipt, (sibling.receipt as any).executionReceipt,
      'F058 real renewal fan-out shares exactly one execution');
    assert.notEqual((current.receipt as any).assertionReceipt.assertionReceiptDigest, (sibling.receipt as any).assertionReceipt.assertionReceiptDigest,
      'F058 fan-out independently authenticates the selectors/intents');
    const bundle = current.receipt as unknown as Record<string, any>;
    assert.equal(bundle.schemaVersion, 'proof-or-stop.verification-receipt-bundle.v5');
    assert.equal(gateCoverage(env).entries[0].status, 'covered');
    assert.ok(bundle.publicationBinding, 'current publication has a signed context');
    for (const field of ['storyId', 'publicationMode', 'executionReceiptDigest', 'assertionReceiptDigest', 'reuseReceiptDigest', 'outputArtifactDigest', 'outputDigest']) {
      const changed = structuredClone(current);
      (changed.receipt as unknown as Record<string, any>).publicationBinding[field] = field === 'storyId' ? 'B-other-publication'
        : field === 'publicationMode' ? 'reused' : 'f'.repeat(64);
      assert.equal(validateVerificationReceipt(env.root, changed.receipt!, { storyId: env.storyId, intentRef: 'PUB-A', selector: SELECTOR }).ok,
        false, `F058 canonical-shaped signed ${field} tamper fails graph validation independently of gate freshness`);
      const cl = env.store.readChecklist(env.storyId);
      cl.items[0].verificationEvidence = [changed];
      assert.notEqual(gateCoverage(env, cl).entries[0].status, 'covered', `F058: signed ${field} tamper rejected`);
    }
    for (const field of ['headHash', 'materialHash', 'storyFilesHash']) {
      const changed = structuredClone(current);
      (changed.receipt as unknown as Record<string, any>).publicationBinding.freshness[field] = 'f'.repeat(field === 'headHash' ? 40 : 64);
      const validation = validateVerificationReceipt(env.root, changed.receipt!, { storyId: env.storyId, intentRef: 'PUB-A', selector: SELECTOR });
      assert.equal(validation.ok, false, `F058 canonical-shaped signed freshness ${field} fails without any outer-row freshness check`);
      assert.match(validation.errors.join('; '), /signature|authentic|binding/i);
      const cl = env.store.readChecklist(env.storyId);
      cl.items[0].verificationEvidence = [changed];
      assert.notEqual(gateCoverage(env, cl).entries[0].status, 'covered', `F058: signed freshness ${field} tamper rejected`);
    }
    for (const fresh of originals.items[0].verificationEvidence!) {
      assert.equal((fresh.receipt as any).schemaVersion, 'proof-or-stop.verification-receipt-bundle.v5', 'F058 canonical fresh producer emits current V5');
      assert.ok((fresh.receipt as any).publicationBinding, 'F058 fresh publication includes signed context');
    }
    assert.equal((sibling.receipt as any).schemaVersion, 'proof-or-stop.verification-receipt-bundle.v5');
    assert.ok((sibling.receipt as any).publicationBinding, 'F058 every fan-out assertion has current signed context');

    const cap = makeEnv('B-aa5f-publication-reuse', [intent('PUB-CAP', 'cli')]);
    try {
      assert.equal(verificationReuseCapsuleEnforcementSupported(), true, 'F058 supported reuse mode cannot be skipped');
      const input = 'packages/main/src/publication-cap.txt';
      const manifest = 'packages/main/publication.verification-dependencies.json';
      write(cap.root, input, 'PUBLICATION_CAP_OK\n');
      writeCapsuleManifest(cap.root, manifest, [input]);
      git(cap.root, ['add', input, manifest]); git(cap.root, ['commit', '-m', 'publication capsule']);
      const command = capsuleCommand(cap.root, manifest, [input]);
      await seedPinnedReceipt(cap, { intentRef: 'PUB-CAP', command, selector: 'PUBLICATION_CAP_OK', file: manifest });
      const beforeReuse = structuredClone(findEvidence(cap, 'PUB-CAP')!);
      commitRefreshDrift(cap, 'unrelated-publication-drift');
      cap.launchCounter.count = 0;
      await cap.handlers.verification_evidence_refresh_stale({ storyId: cap.storyId });
      const reused = findEvidence(cap, 'PUB-CAP')!;
      assert.equal(cap.launchCounter.count, 0, 'F058 actual capsule reuse has zero subprocesses');
      assert.equal(gateCoverage(cap).entries[0].status, 'covered');
      assert.equal((reused.receipt as any).schemaVersion, 'proof-or-stop.verification-receipt-bundle.v5');
      assert.equal((reused.receipt as any).publicationMode, 'reused');
      assert.deepEqual((reused.receipt as any).executionReceipt, (beforeReuse.receipt as any).executionReceipt, 'F058 reuse never rewrites execution history');
      const publication = (reused.receipt as any).publicationBinding;
      assert.equal(publication.storyId, cap.storyId);
      assert.equal(publication.publicationMode, 'reused');
      assert.deepEqual(publication.freshness, { headHash: reused.headHash, materialHash: reused.materialHash, storyFilesHash: reused.storyFilesHash });
      for (const field of ['storyId', 'publicationMode', 'executionReceiptDigest', 'assertionReceiptDigest', 'reuseReceiptDigest', 'outputArtifactDigest', 'outputDigest']) {
        const cl = cap.store.readChecklist(cap.storyId);
        (cl.items[0].verificationEvidence![0].receipt as any).publicationBinding[field] = field === 'storyId' ? 'B-other-publication'
          : field === 'publicationMode' ? 'executed' : 'f'.repeat(64);
        assert.equal(validateVerificationReceipt(cap.root, cl.items[0].verificationEvidence![0].receipt!, {
          storyId: cap.storyId, intentRef: 'PUB-CAP', selector: 'PUBLICATION_CAP_OK',
        }).ok, false, `F058 reused canonical-shaped ${field} fails independent graph authentication`);
        assert.notEqual(gateCoverage(cap, cl).entries[0].status, 'covered', `F058 reused signed ${field} rejected`);
      }
      for (const field of ['headHash', 'materialHash', 'storyFilesHash']) {
        const cl = cap.store.readChecklist(cap.storyId);
        (cl.items[0].verificationEvidence![0].receipt as any).publicationBinding.freshness[field] = 'f'.repeat(field === 'headHash' ? 40 : 64);
        const validation = validateVerificationReceipt(cap.root, cl.items[0].verificationEvidence![0].receipt!, {
          storyId: cap.storyId, intentRef: 'PUB-CAP', selector: 'PUBLICATION_CAP_OK',
        });
        assert.equal(validation.ok, false, `F058 reused signed freshness ${field} fails independent authentication`);
        assert.match(validation.errors.join('; '), /signature|authentic|binding/i);
        assert.notEqual(gateCoverage(cap, cl).entries[0].status, 'covered', `F058 reused signed freshness ${field} rejected`);
      }
    } finally { cleanup(cap); }
  } finally { cleanup(env); }
}
