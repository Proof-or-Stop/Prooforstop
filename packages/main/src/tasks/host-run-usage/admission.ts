import assert from 'node:assert/strict';



import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { acquireHostRunSlot, defaultHostRunRunner, releaseSlot, runHostRun, usageLineRetainerFor, hostRunSlotsDir, resolveMaxConcurrent, writeSlotFileExclusive, type HostRunChunk } from '../../core/host-run.js';









import { resolveLedgerPath } from '../../core/usage-ledger/writer.js';

import { checkAsync, freshRoot, RunnerSink, baseArgs, makeRunner, CODEX_STDOUT, readLedger, CLAUDE_STDOUT, seedSlot, DEAD_PID, check, slotMeta, AGY_STDOUT } from "./support.js";

export async function case47(): Promise<void> {


  // =========================================================================
  // F-011: the host subprocess executes in the RESOLVED PROJECT ROOT (args.cwd,
  // the same value the ledger attributes as root), never the caller's process
  // cwd. Against the old code the spawn plan carried NO cwd at all, so the host
  // inherited whatever directory the CLI happened to be invoked from while the
  // ledger still pointed at --root.
  // =========================================================================
  await checkAsync('F-011: plan.cwd is the injected resolved root while process.cwd() is intentionally elsewhere; empty cwd refused pre-spawn', async () => {
    const sub = freshRoot();
    mkdirSync(sub, { recursive: true });
    const elsewhere = mkdtempSync(join(tmpdir(), 'host-run-caller-cwd-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(elsewhere);
      // The smoke process now sits in a directory that is NOT the injected root
      // — exactly the reported bug setup (`proofOrStop --root <worktree> host_run`
      // invoked from somewhere else).
      assert.notEqual(realpathSync(sub), process.cwd(), 'precondition: caller cwd differs from the injected root');
      const sink: RunnerSink = { calls: 0, lastPlan: null };
      const result = await runHostRun(baseArgs({ root: sub }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
      assert.equal(result.spawned, true);
      assert.equal(sink.calls, 1);
      assert.ok(sink.lastPlan);
      assert.equal(sink.lastPlan!.cwd, sub, 'plan.cwd === the injected root (the ledger-attribution root), NOT the caller cwd');
      assert.notEqual(realpathSync(sink.lastPlan!.cwd), process.cwd(), 'the caller cwd never leaks into the spawn plan');

      // Fail-closed: a missing/empty cwd is refused BEFORE any spawn (and before
      // any ledger row) rather than silently falling back to the caller cwd.
      const sub2 = freshRoot();
      const sink2: RunnerSink = { calls: 0, lastPlan: null };
      await assert.rejects(
        () => runHostRun({ ...baseArgs({ root: sub2 }), cwd: '' }, { runner: makeRunner({ stdout: CODEX_STDOUT }, sink2) }),
        /cwd is required/i,
      );
      assert.equal(sink2.calls, 0, 'no spawn without a resolved cwd');
      assert.equal(existsSync(resolveLedgerPath(sub2)), false, 'no rows written for a missing-cwd refusal');
    } finally {
      process.chdir(originalCwd);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
}

export async function case48(): Promise<void> {


  await checkAsync('F-011: the DEFAULT runner spawns the real child IN plan.cwd — child process.cwd() equals the injected root, not the smoke cwd', async () => {
    const target = mkdtempSync(join(tmpdir(), 'host-run-cwd-target-'));
    try {
      const chunks: string[] = [];
      const result = await defaultHostRunRunner({
        command: process.execPath,
        argv: ['-e', 'console.log(process.cwd());'],
        env: process.env,
        cwd: target,
        host: 'codex',
        retainUsageLine: usageLineRetainerFor('codex'),
        onChunk: (c: HostRunChunk) => { if (c.stream === 'stdout') chunks.push(c.text); },
      });
      assert.equal(result.exitCode, 0);
      const printed = chunks.join('').trim();
      assert.ok(printed.length > 0, 'child printed its cwd');
      assert.equal(realpathSync(printed), realpathSync(target), 'the child executed in the injected root (spawn received plan.cwd)');
      assert.notEqual(realpathSync(printed), process.cwd(), 'and NOT in the smoke process cwd (the old no-cwd inheritance)');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
}

export async function case49(): Promise<void> {


  // =========================================================================
  // CHK-007a: hard-budget cap
  // =========================================================================
  await checkAsync('CHK-007a budget: over-budget preflight refuses before spawn, writes blocked row (hard_budget_exceeded)', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(sink.calls, 0, 'runner NOT invoked when over budget');
    assert.equal(result.blocked, true);
    assert.equal(result.spawned, false);
    assert.equal(result.refusalReason, 'hard_budget_exceeded');
    assert.notEqual(result.exitCode, 0);
    const records = readLedger(sub);
    const blocked = records.find((r) => r.decision.kind === 'blocked');
    assert.ok(blocked, 'a blocked ledger row is written');
    assert.equal(blocked!.decision.reasonCode, 'hard_budget_exceeded');
    assert.ok(records.some((r) => r.usage.source === 'prompt-size-estimate'), 'preflight estimate present');
    // F-027 positive path: with a healthy ledger the summary still claims the row.
    assert.equal(result.usageSummary.recorded, 'blocked', 'healthy ledger keeps the blocked claim');
    assert.ok((result.usageSummary.reason ?? '').startsWith('hard_budget_exceeded ('), 'reason stays the plain refusal (no append-failure suffix)');
    assert.equal((result.usageSummary.reason ?? '').includes('ledger_append_failed'), false);
  });
}

export async function case50(): Promise<void> {


  await checkAsync('CHK-007a budget (F-004): blocked rows are provider-honest — codex=openai, claude=anthropic (legacy shape byte-compat)', async () => {
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;

    // codex budget refusal -> provider.name openai (was mis-attributed anthropic).
    const sub1 = freshRoot();
    const r1 = await runHostRun(baseArgs({ root: sub1, host: 'codex', env }), { runner: makeRunner({ stdout: CODEX_STDOUT }) });
    assert.equal(r1.blocked, true);
    const b1 = readLedger(sub1).find((r) => r.decision.kind === 'blocked');
    assert.ok(b1, 'codex blocked row written');
    assert.equal(b1!.provider?.name, 'openai', 'codex budget block attributed to openai (F-004)');
    assert.equal(b1!.decision.reasonCode, 'hard_budget_exceeded');

    // claude budget refusal -> provider.name anthropic, and the legacy blocked-row
    // shape is unchanged (source/estimator/model default byte-compat).
    const sub2 = freshRoot();
    const r2 = await runHostRun(baseArgs({ root: sub2, host: 'claude', env }), { runner: makeRunner({ stdout: CLAUDE_STDOUT }) });
    assert.equal(r2.blocked, true);
    const b2 = readLedger(sub2).find((r) => r.decision.kind === 'blocked');
    assert.ok(b2, 'claude blocked row written');
    assert.equal(b2!.provider?.name, 'anthropic', 'claude blocked row stays anthropic');
    assert.equal(b2!.provider?.model, 'unknown', 'model default unchanged');
    assert.equal(b2!.usage.source, 'prompt-size-estimate', 'blocked usage stays the preflight estimate');
    assert.equal(b2!.usage.estimator?.name, 'bytes-chars-heuristic', 'estimator provenance unchanged');
    assert.equal(b2!.decision.kind, 'blocked');
    assert.equal(b2!.decision.reasonCode, 'hard_budget_exceeded');
  });
}

export async function case51(): Promise<void> {


  // =========================================================================
  // CHK-007b: concurrency cap
  // =========================================================================
  await checkAsync('CHK-007b concurrency: 5th run under cap 4 refuses, writes blocked row (concurrency_cap_exceeded)', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    for (let i = 0; i < 4; i++) seedSlot(dir, i, process.pid); // slot-0..slot-3 held live
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(sink.calls, 0, 'runner NOT invoked when at the concurrency cap');
    assert.equal(result.blocked, true);
    assert.equal(result.refusalReason, 'concurrency_cap_exceeded');
    assert.equal(result.liveRuns?.length, 4, 'live-run list surfaced');
    assert.notEqual(result.exitCode, 0);
    const records = readLedger(sub);
    const blocked = records.find((r) => r.decision.kind === 'blocked');
    assert.ok(blocked);
    assert.equal(blocked!.decision.reasonCode, 'concurrency_cap_exceeded');
    // F-027 positive path: with a healthy ledger the summary claims the row and
    // the surfaced recordId is the APPENDED blocked row's id (never minted).
    assert.equal(result.usageSummary.recorded, 'blocked', 'healthy ledger keeps the blocked claim');
    assert.equal(result.usageSummary.recordId, blocked!.recordId, 'summary recordId matches the appended blocked row');
    assert.ok((result.usageSummary.reason ?? '').startsWith('concurrency_cap_exceeded ('), 'reason stays the plain refusal');
    assert.equal((result.usageSummary.reason ?? '').includes('ledger_append_failed'), false);
    // F-004: a codex refusal is attributed to openai, never anthropic.
    assert.equal(blocked!.provider?.name, 'openai', 'codex concurrency block attributed to openai');
    // Slot metadata never leaks into a ledger row (slots carry pid/timestamps only).
    const ledgerText = readFileSync(resolveLedgerPath(sub), 'utf8');
    assert.equal(ledgerText.includes('2000-01-01T00:00:00.000Z'), false, 'slot startedAt marker must not appear in the ledger');
  });
}

export async function case52(): Promise<void> {


  await checkAsync('CHK-007b concurrency: dead-pid slot is reclaimed so the run proceeds', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const dead = seedSlot(dir, 0, DEAD_PID);
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(existsSync(dead), false, 'dead-pid slot reclaimed (reused + released)');
    assert.equal(sink.calls, 1, 'run proceeds after reclaim');
    assert.equal(result.blocked, false);
  });
}

export async function case53(): Promise<void> {


  await checkAsync('F-025 live-holder protection: a LIVE-pid slot is NEVER age-reclaimed — the cap=1 waiter refuses fail-closed and the slot file survives (the OLD mtime rule reclaimed it here)', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const held = seedSlot(dir, 0, process.pid); // a LIVE holder...
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000); // ...whose slot looks ancient (7h > the 6h window)
    utimesSync(held, old, old);
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    assert.equal(sink.calls, 0, 'runner NOT invoked — the live slot was not stolen by age');
    assert.equal(result.blocked, true, 'the waiter refuses at cap instead of reclaiming a live run');
    assert.equal(result.refusalReason, 'concurrency_cap_exceeded');
    assert.equal(result.liveRuns?.length, 1, 'the live holder still appears in the refusal live list');
    assert.equal(existsSync(held), true, 'the live holder keeps its slot file');
  });
}

export async function case54(): Promise<void> {


  await checkAsync('F-025 meta-less orphan backstop: a slot whose meta never landed (corrupt/empty file) is waited out while FRESH (cap=1 refusal) and reclaimed only PAST the mtime backstop', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    mkdirSync(dir, { recursive: true });
    const orphan = join(dir, 'slot-0.json');
    writeFileSync(orphan, '', 'utf8'); // the crash-between-wx-create-and-meta-write window: no parseable meta
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;

    // FRESH meta-less slot: possibly a holder mid-way through its meta write —
    // never stolen; the run refuses fail-closed.
    const sinkFresh: RunnerSink = { calls: 0, lastPlan: null };
    const fresh = await runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sinkFresh) });
    assert.equal(sinkFresh.calls, 0, 'a young meta-less slot is waited out, not stolen');
    assert.equal(fresh.blocked, true);
    assert.equal(existsSync(orphan), true, 'the young orphan survives');

    // PAST the backstop: pid liveness is unknowable, so mtime age is the only
    // signal left — the orphan is reclaimed and the run proceeds.
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(orphan, old, old);
    const sinkOld: RunnerSink = { calls: 0, lastPlan: null };
    const reclaimed = await runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sinkOld) });
    assert.equal(sinkOld.calls, 1, 'the aged orphan is reclaimed and the run proceeds');
    assert.equal(reclaimed.blocked, false);
    assert.equal(existsSync(orphan), false, 'the aged orphan slot was reclaimed (and released after the run)');
  });
}

export async function case55(): Promise<void> {


  check('F-025 release-token guard: a reclaimed+reacquired slot survives the ORIGINAL holder\'s late release (token mismatch), the cap stays enforced, and a matching-token release still works', () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const staleMs = 6 * 60 * 60 * 1000;

    // Matching token: acquire records pid + token on disk; release unlinks.
    const happy = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('happy-holder'));
    assert.ok(happy, 'admission returns the slot handle');
    assert.equal(happy!.file, join(dir, 'slot-0.json'));
    const onDiskHappy = JSON.parse(readFileSync(happy!.file, 'utf8')) as { pid?: number; token?: string };
    assert.equal(onDiskHappy.pid, process.pid, 'the slot file records the holder pid');
    assert.equal(onDiskHappy.token, happy!.token, 'the slot file records the acquire-minted token');
    releaseSlot(happy!.file, happy!.token);
    assert.equal(existsSync(happy!.file), false, 'matching token: release unlinks the slot');

    // The F-025 bug scenario: original holder A is judged reclaimable by a racing
    // contender (simulated unlink — e.g. a pid-death false positive) and a NEW
    // holder B re-acquires the SAME fixed slot-0 path. A's LATE release must not
    // delete B's live admission. Against the OLD blind-unlink releaseSlot, B's
    // slot vanished here and the cap admitted a third run.
    const a = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('original-holder'));
    assert.ok(a, 'original holder admitted');
    rmSync(a!.file, { force: true }); // the reclaimer's unlink
    const b = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('new-holder'));
    assert.ok(b, 'new holder re-acquires the reclaimed slot');
    assert.equal(b!.file, a!.file, 'same fixed slot path, different owner');
    assert.notEqual(b!.token, a!.token, 'each acquire mints a fresh token');
    releaseSlot(a!.file, a!.token); // the ORIGINAL holder's late release
    assert.equal(existsSync(b!.file), true, 'the new holder\'s slot survives the stale release');
    const onDisk = JSON.parse(readFileSync(b!.file, 'utf8')) as { token?: string; agentType?: string };
    assert.equal(onDisk.token, b!.token, 'the on-disk token is still the NEW holder\'s');
    assert.equal(onDisk.agentType, 'new-holder', 'the on-disk meta is still the NEW holder\'s');
    assert.equal(
      acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('third-run')),
      null,
      'cap=1 stays enforced under the surviving slot (the OLD code admitted this run)',
    );
    releaseSlot(b!.file, b!.token);
    assert.equal(existsSync(b!.file), false, 'the new holder\'s own release still works');
  });
}

export async function case56(): Promise<void> {


  await checkAsync('CHK-007b adversarial (F-003): cap=1 real contention — second admission fails while the first holds (index wx IS the cap decision)', async () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const staleMs = 6 * 60 * 60 * 1000;

    // Two concurrent admissions: the first wx-wins slot-0; the second (NO release
    // in between) must be refused. Against the old check-then-acquire design both
    // would have been admitted (unique names always wx-succeed after a racy scan).
    const first = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('winner'));
    assert.equal(first?.file, join(dir, 'slot-0.json'), 'first admission wins slot-0');
    const second = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('loser'));
    assert.equal(second, null, 'second admission refused while the first still holds (atomic, no TOCTOU)');

    // Full-run refusal under the held slot: an agy run with cap=1 must refuse
    // fail-closed with the blocked row attributed to antigravity (F-004).
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    const result = await runHostRun(baseArgs({ root: sub, host: 'agy', env }), { runner: makeRunner({ stdout: AGY_STDOUT }, sink) });
    assert.equal(sink.calls, 0, 'runner NOT invoked under contention refusal');
    assert.equal(result.blocked, true);
    assert.equal(result.refusalReason, 'concurrency_cap_exceeded');
    assert.equal(result.liveRuns?.length, 1, 'live-run list surfaced');
    assert.notEqual(result.exitCode, 0);
    const blocked = readLedger(sub).find((r) => r.decision.kind === 'blocked');
    assert.ok(blocked, 'blocked ledger row written');
    assert.equal(blocked!.decision.reasonCode, 'concurrency_cap_exceeded');
    assert.equal(blocked!.provider?.name, 'antigravity', 'agy concurrency block attributed to antigravity (F-004)');
  });
}

export async function case57(): Promise<void> {


  check('CHK-007b adversarial (F-003): stale-reclaim race — exactly one of two reclaimers wins the wx re-create', () => {
    const sub = freshRoot();
    const dir = hostRunSlotsDir(sub);
    const staleMs = 6 * 60 * 60 * 1000;
    const file = seedSlot(dir, 0, DEAD_PID); // dead pid => stale occupant of slot-0
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(file, old, old);

    // Reclaimer A: observes staleness, unlink + wx re-create — wins slot-0.
    const a = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('reclaimer-a'));
    assert.equal(a?.file, file, 'reclaimer A wins the stale slot');
    // Reclaimer B races the SAME slot: its fresh pre-unlink staleness probe now
    // sees A's live fresh slot (NOT stale => it must not unlink A), and cap=1
    // leaves no other index => B loses.
    const b = acquireHostRunSlot(dir, 1, staleMs, Date.now(), slotMeta('reclaimer-b'));
    assert.equal(b, null, 'reclaimer B loses (never unlinks the winner)');
    // The slot on disk is A's, untouched by B; and a direct wx re-create (the
    // losing half of the reclaim race) fails EEXIST-atomically.
    const held = JSON.parse(readFileSync(file, 'utf8')) as { agentType?: string };
    assert.equal(held.agentType, 'reclaimer-a', 'winner slot content intact');
    assert.equal(writeSlotFileExclusive(file, { ...slotMeta('reclaimer-b'), token: 'reclaimer-b-token' }), false, 'losing wx re-create fails atomically');
  });
}

export async function case58(): Promise<void> {


  check('CHK-007b edge: PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT unset/invalid falls back to 4; valid honored', () => {
    assert.equal(resolveMaxConcurrent({} as NodeJS.ProcessEnv), 4);
    assert.equal(resolveMaxConcurrent({ PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '0' } as NodeJS.ProcessEnv), 4);
    assert.equal(resolveMaxConcurrent({ PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '-3' } as NodeJS.ProcessEnv), 4);
    assert.equal(resolveMaxConcurrent({ PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: 'abc' } as NodeJS.ProcessEnv), 4);
    assert.equal(resolveMaxConcurrent({ PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '3.5' } as NodeJS.ProcessEnv), 4);
    assert.equal(resolveMaxConcurrent({ PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '8' } as NodeJS.ProcessEnv), 8);
  });
}
