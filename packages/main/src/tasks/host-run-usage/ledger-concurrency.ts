import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';


import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';

import { dirname, join } from 'node:path';












import {
  acquireLedgerLock,
  appendUsageRecord,
  releaseLedgerLock,
  resolveLedgerLockPath,
  resolveLedgerPath,
  verifyLedgerChain,
  USAGE_LEDGER_LOCK_OWNER_FILENAME,
} from '../../core/usage-ledger/writer.js';

import { checkAsync, freshRoot, minimalValidUsageRecord, check, ON } from "./support.js";

export async function case71(): Promise<void> {


  // =========================================================================
  // F-012: cross-process append serialization at the writer choke point.
  // Against the OLD writer the parallel check below breaks near-deterministically:
  // all rows land (appendFileSync) but verifyLedgerChain throws, because
  // concurrent processes read the same predecessor before appending.
  // =========================================================================
  await checkAsync('F-012 parallel writes: 6 REAL concurrent processes x 5 appends each -> zero skips, no lost writes, hash chain intact', async () => {
    const sub = freshRoot();
    mkdirSync(sub, { recursive: true });
    const CHILDREN = 6;
    const APPENDS = 5;
    // Each child dynamically imports the COMPILED writer + ids modules and
    // appends APPENDS minimal valid records against the SAME root — the exact
    // shape of concurrent host_run processes (ledger default-ON, cap 4).
    const childScript = [
      '(async () => {',
      '  const writer = await import(process.env.F012_WRITER_URL);',
      '  const ids = await import(process.env.F012_IDS_URL);',
      '  const template = JSON.parse(process.env.F012_TEMPLATE);',
      '  for (let i = 0; i < Number(process.env.F012_APPENDS); i++) {',
      '    const record = { ...template, recordId: ids.mintRecordId(), ledgerCallId: ids.mintLedgerCallId(), attemptId: ids.mintAttemptId() };',
      '    const res = writer.appendUsageRecord(process.env.F012_ROOT, record, { env: { PROOF_OR_STOP_USAGE_LEDGER: "1" } });',
      '    if (!res.written) throw new Error("append reported not-written");',
      '  }',
      '})().catch((err) => { console.error(String((err && err.message) || err)); process.exit(1); });',
    ].join('\n');
    const childEnv = {
      ...process.env,
      F012_WRITER_URL: new URL('../../core/usage-ledger/writer.js', import.meta.url).href,
      F012_IDS_URL: new URL('../../core/usage-ledger/ids.js', import.meta.url).href,
      F012_TEMPLATE: JSON.stringify(minimalValidUsageRecord()),
      F012_ROOT: sub,
      F012_APPENDS: String(APPENDS),
    };
    const codes = await Promise.all(
      Array.from({ length: CHILDREN }, () => new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, ['-e', childScript], { env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] });
        child.on('close', (code) => resolve(code));
      })),
    );
    // Zero skips at N=6: a bounded-wait skip throws in the child (non-zero
    // exit). Skips are acceptable only under pathological contention, which
    // 6 processes x 5 quick appends is not.
    assert.deepEqual(codes, Array.from({ length: CHILDREN }, () => 0), 'every child appended all its rows (zero skips)');
    const records = verifyLedgerChain(resolveLedgerPath(sub)); // throws if any previousRecordHash breaks the chain
    assert.equal(records.length, CHILDREN * APPENDS, 'no lost writes: row count == sum of the children appends');
    assert.equal(existsSync(resolveLedgerLockPath(sub)), false, 'the append lock is released after the run');
  });
}

export async function case72(): Promise<void> {


  check('F-012/F-018 ownerless orphan reclaim: a lock dir with NO owner.json and an old mtime (crash-before-owner-write window) is reclaimed by the backstop — a single append succeeds and releases it', () => {
    const sub = freshRoot();
    const lockDir = resolveLedgerLockPath(sub);
    // No owner.json: pid liveness is unknowable, so the mtime backstop applies.
    mkdirSync(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000); // older than the 30s orphan backstop default
    utimesSync(lockDir, old, old);
    const res = appendUsageRecord(sub, minimalValidUsageRecord(), { env: ON });
    assert.equal(res.written, true, 'the append reclaimed the ownerless orphan lock and succeeded');
    assert.equal(verifyLedgerChain(resolveLedgerPath(sub)).length, 1, 'exactly one valid row');
    assert.equal(existsSync(lockDir), false, 'the reclaimed lock is released after the append');
  });
}

export async function case73(): Promise<void> {


  check('F-012 bounded-wait skip-not-corrupt: a HELD fresh lock + tiny wait -> the append throws (skips), chain stays valid, foreign lock not stolen', () => {
    const sub = freshRoot();
    // Seed one real row so a corrupting append would have a predecessor to race.
    assert.equal(appendUsageRecord(sub, minimalValidUsageRecord(), { env: ON }).written, true);
    const lockDir = resolveLedgerLockPath(sub);
    // An ownerless lock with a FRESH mtime (younger than the orphan backstop):
    // possibly a holder mid-way between mkdir and its owner.json write — waited
    // out, never reclaimed within the bounded budget.
    mkdirSync(lockDir, { recursive: true });
    const env = {
      PROOF_OR_STOP_USAGE_LEDGER: '1',
      PROOF_OR_STOP_USAGE_LEDGER_LOCK_WAIT_MS: '50',
      PROOF_OR_STOP_USAGE_LEDGER_LOCK_STALE_MS: '60000',
    } as NodeJS.ProcessEnv;
    assert.throws(
      () => appendUsageRecord(sub, minimalValidUsageRecord(), { env }),
      /skip-not-corrupt/,
      'the writer surfaces the skip through its existing throw path (seam callers catch -> honest under-count)',
    );
    assert.equal(existsSync(lockDir), true, 'a fresh (non-orphaned) foreign lock is never stolen on a bounded-wait failure');
    assert.equal(verifyLedgerChain(resolveLedgerPath(sub)).length, 1, 'no row appended on the skip — the chain is intact');
    rmSync(lockDir, { recursive: true, force: true });
  });
}

export async function case74(): Promise<void> {


  check('F-018 live-holder protection: a LIVE pid with valid owner.json is never reclaimed regardless of lock age — bounded wait then skip-not-corrupt, lock + token intact', () => {
    const sub = freshRoot();
    // Seed one real row so a stolen lock would have a predecessor to corrupt.
    assert.equal(appendUsageRecord(sub, minimalValidUsageRecord(), { env: ON }).written, true);
    const lockDir = resolveLedgerLockPath(sub);
    const ownerPath = join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME);
    // A live holder: THIS process's pid, but the lock dir looks ancient. The
    // pre-F-018 writer reclaimed on mtime age alone and stole exactly this
    // lock (the holder was merely slow/suspended inside the critical section).
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      ownerPath,
      JSON.stringify({ pid: process.pid, token: 'live-holder-token', acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    const env = {
      PROOF_OR_STOP_USAGE_LEDGER: '1',
      PROOF_OR_STOP_USAGE_LEDGER_LOCK_WAIT_MS: '50',
      PROOF_OR_STOP_USAGE_LEDGER_LOCK_STALE_MS: '1', // even an absurdly tiny backstop must not matter
    } as NodeJS.ProcessEnv;
    assert.throws(
      () => appendUsageRecord(sub, minimalValidUsageRecord(), { env }),
      /skip-not-corrupt/,
      'the waiter waits out its bounded budget and skips — it never steals a live lock',
    );
    assert.equal(existsSync(lockDir), true, 'the live holder keeps its lock');
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: string };
    assert.equal(owner.token, 'live-holder-token', 'owner.json untouched (same token)');
    assert.equal(verifyLedgerChain(resolveLedgerPath(sub)).length, 1, 'no row appended on the skip — the chain is intact');
    rmSync(lockDir, { recursive: true, force: true });
  });
}

export async function case75(): Promise<void> {


  await checkAsync('F-018 dead-holder reclaim: owner.json with a REAL dead pid is reclaimed immediately (age-independent) — the append succeeds', async () => {
    const sub = freshRoot();
    // A genuinely dead pid: spawn a child that exits at once and wait for it.
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', () => resolve(child.pid as number));
    });
    const lockDir = resolveLedgerLockPath(sub);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME),
      JSON.stringify({ pid: deadPid, token: 'dead-holder-token', acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    // FRESH mtime + a huge orphan backstop: pid death ALONE authorizes reclaim.
    const env = {
      PROOF_OR_STOP_USAGE_LEDGER: '1',
      PROOF_OR_STOP_USAGE_LEDGER_LOCK_STALE_MS: '3600000',
    } as NodeJS.ProcessEnv;
    const res = appendUsageRecord(sub, minimalValidUsageRecord(), { env });
    assert.equal(res.written, true, 'the append reclaimed the dead holder lock and succeeded');
    assert.equal(verifyLedgerChain(resolveLedgerPath(sub)).length, 1, 'exactly one valid row');
    assert.equal(existsSync(lockDir), false, 'the reclaimed lock is released after the append');
  });
}

export async function case76(): Promise<void> {


  check('F-018 release-token guard: release removes the lock only while owner.json still carries OUR token — a reclaimed+reacquired foreign lock survives a stale release', () => {
    const sub = freshRoot();
    const lockDir = resolveLedgerLockPath(sub);
    mkdirSync(dirname(lockDir), { recursive: true });
    const ownerPath = join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME);

    // Happy path: acquire mints a token and records pid+token; a matching
    // release removes the lock.
    const ownToken = acquireLedgerLock(lockDir, ON);
    assert.ok(ownToken, 'acquire returns a token');
    const recorded = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: number; token?: string };
    assert.equal(recorded.pid, process.pid, 'owner.json records the holder pid');
    assert.equal(recorded.token, ownToken, 'owner.json records the minted token');
    releaseLedgerLock(lockDir, ownToken as string);
    assert.equal(existsSync(lockDir), false, 'matching token: release removes the lock');

    // Guard: simulate "we were judged dead and reclaimed; a NEW holder
    // re-acquired" by swapping owner.json to a foreign token. Our late release
    // must NOT remove the foreign holder's lock.
    const staleToken = acquireLedgerLock(lockDir, ON);
    assert.ok(staleToken, 're-acquired for the guard scenario');
    writeFileSync(
      ownerPath,
      JSON.stringify({ pid: process.pid, token: 'foreign-reclaimer-token', acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    releaseLedgerLock(lockDir, staleToken as string);
    assert.equal(existsSync(lockDir), true, 'foreign lock dir survives our stale release');
    const foreign = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: string };
    assert.equal(foreign.token, 'foreign-reclaimer-token', 'foreign owner.json survives with its token');
    rmSync(lockDir, { recursive: true, force: true });
  });
}

export async function case77(): Promise<void> {


  check('F-018/F-019 owner-write-failure rollback: when owner.json cannot be written after a successful mkdir, acquire returns null AND gives the dir back — no ownerless lock left behind', () => {
    const sub = freshRoot();
    const lockDir = resolveLedgerLockPath(sub);
    const ownerPath = join(lockDir, USAGE_LEDGER_LOCK_OWNER_FILENAME);
    // The usage dir (the lock dir's PARENT) is created BEFORE the umask change
    // so it stays writable: rmdir of the lock dir needs write on the parent
    // only, so the rollback itself is never blocked by this setup.
    mkdirSync(dirname(lockDir), { recursive: true });
    // Deterministic owner-write failure WITHOUT touching the writer (its ESM
    // named fs imports are snapshot bindings, so monkey-patching fs from here
    // would not intercept): a 0o277 umask makes acquire's own mkdirSync create
    // the lock dir as 0o500 (dr-x------), so the immediately following
    // writeFileSync(owner.json) fails EACCES (non-root) — exactly the
    // mkdir-succeeded-but-owner-write-failed branch. WAIT_MS=0 bounds the
    // retry loop to a single pass through that branch.
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_USAGE_LEDGER_LOCK_WAIT_MS: '0' } as NodeJS.ProcessEnv;
    const prevUmask = process.umask(0o277);
    let res: string | null;
    try {
      res = acquireLedgerLock(lockDir, env);
    } finally {
      process.umask(prevUmask);
    }
    assert.equal(res, null, 'the failed acquire returns null — no lock is held by the caller');
    assert.equal(
      existsSync(lockDir),
      false,
      'rollback: the just-created lock dir was given back (rmdirSync ran) — an ownerless lock that only the mtime backstop could age out is never left behind',
    );
    assert.equal(existsSync(ownerPath), false, 'the failure path never wrote a partial owner.json');
    // The same lock path is immediately acquirable once writes succeed again.
    const token = acquireLedgerLock(lockDir, ON);
    assert.ok(token, 'a subsequent unimpaired acquire succeeds');
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: number; token?: string };
    assert.equal(owner.pid, process.pid, 'owner.json records the holder pid after the clean acquire');
    assert.equal(owner.token, token, 'owner.json records the minted token after the clean acquire');
    releaseLedgerLock(lockDir, token as string);
    assert.equal(existsSync(lockDir), false, 'the clean acquire releases normally');
  });
}
