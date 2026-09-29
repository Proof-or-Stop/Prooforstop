import assert from 'node:assert/strict';



import { existsSync } from 'node:fs';




import { runHostRun, type HostRunStoryResolver } from '../../core/host-run.js';









import { resolveLedgerPath } from '../../core/usage-ledger/writer.js';

import { checkAsync, freshRoot, baseArgs, makeRunner, CODEX_STDOUT, fakeStoreResolver, readLedger, RunnerSink } from "./support.js";

export async function case20(): Promise<void> {


  // =========================================================================
  // CHK-002: binding (threadId=reviewRunId, subagentId=lane) + phase resolution
  // =========================================================================
  await checkAsync('CHK-002 binding: reviewRunId->threadId, lane->subagentId, phase resolves from the configured store', async () => {
    const sub = freshRoot();
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex', storyId: 'B-70e9', reviewRunId: 'B-70e9:RR-001', lane: 'proof-or-stop-review-quality', agentType: 'reviewer' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT }), resolveStory: fakeStoreResolver({ 'B-70e9': 'REVIEW' }) },
    );
    assert.equal(result.phase, 'REVIEW', 'phase resolved from the configured store (no story-path read)');
    const records = readLedger(sub);
    assert.ok(records.length >= 1);
    for (const r of records) {
      assert.equal(r.threadId, 'B-70e9:RR-001');
      assert.equal(r.subagentId, 'proof-or-stop-review-quality');
      assert.equal(r.storyId, 'B-70e9');
      assert.equal(r.phase, 'REVIEW');
    }
  });
}

export async function case21(): Promise<void> {


  await checkAsync('CHK-002 edge: omitted reviewRunId/lane -> threadId/subagentId null (no empty-string pollution)', async () => {
    const sub = freshRoot();
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex', phase: 'adhoc' }), { runner: makeRunner({ stdout: CODEX_STDOUT }) });
    assert.equal(result.phase, 'adhoc');
    const records = readLedger(sub);
    for (const r of records) {
      assert.equal(r.threadId, null);
      assert.equal(r.subagentId, null);
      assert.notEqual(r.threadId, '');
      assert.notEqual(r.subagentId, '');
    }
  });
}

export async function case22(): Promise<void> {


  await checkAsync('CHK-002 edge: unknown storyId (per configured store) fails pre-spawn (runner never invoked)', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    await assert.rejects(
      () => runHostRun(
        baseArgs({ root: sub, host: 'codex', storyId: 'B-9999' }),
        { runner: makeRunner({ stdout: CODEX_STDOUT }, sink), resolveStory: fakeStoreResolver({ 'B-70e9': 'REVIEW' }) },
      ),
      /unknown story/i,
    );
    assert.equal(sink.calls, 0, 'no spawn on unknown story');
    assert.equal(existsSync(resolveLedgerPath(sub)), false, 'no rows written for an unknown-story refusal');
  });
}

export async function case23(): Promise<void> {


  await checkAsync('CHK-002 adversarial: cross-story reviewRunId refused pre-spawn (runner never invoked)', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    await assert.rejects(
      () => runHostRun(
        baseArgs({ root: sub, host: 'codex', storyId: 'B-70e9', reviewRunId: 'B-1234:RR-009' }),
        { runner: makeRunner({ stdout: CODEX_STDOUT }, sink), resolveStory: fakeStoreResolver({ 'B-70e9': 'REVIEW' }) },
      ),
      /does not belong to story/i,
    );
    assert.equal(sink.calls, 0, 'no spawn on cross-story reviewRunId');
  });
}

export async function case24(): Promise<void> {


  // =========================================================================
  // F-005: story metadata resolves through the configured store, NOT a hard-coded
  // .proof-or-stop/story/actives path; an explicit --phase never reads the store.
  // =========================================================================
  await checkAsync('F-005: explicit --phase is honored AS-IS with NO story-store read (fake resolver never consulted)', async () => {
    const sub = freshRoot();
    let resolverCalls = 0;
    const resolveStory: HostRunStoryResolver = (id: string) => {
      resolverCalls += 1;
      return id === 'B-70e9' ? { phase: 'REVIEW' } : null;
    };
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex', storyId: 'B-70e9', phase: 'DEV' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT }, sink), resolveStory },
    );
    assert.equal(result.phase, 'DEV', 'explicit --phase used verbatim');
    assert.equal(resolverCalls, 0, 'the configured store is NEVER consulted when --phase is explicit');
    assert.equal(sink.calls, 1, 'the host still launches');
  });
}

export async function case25(): Promise<void> {


  await checkAsync('F-005: unknown story is NOT refused when --phase overrides (the exact configured-storyDir bug)', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    // The resolver would refuse B-9999 (unknown per the store), but --phase means
    // the store is never asked, so the host launches. Under the old hard-coded
    // .proof-or-stop/story/actives read this was refused pre-spawn.
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex', storyId: 'B-9999', phase: 'REVIEW' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT }, sink), resolveStory: fakeStoreResolver({ 'B-70e9': 'REVIEW' }) },
    );
    assert.equal(sink.calls, 1, 'host launches even though the store does not know B-9999');
    assert.equal(result.phase, 'REVIEW', 'explicit phase honored');
    assert.equal(result.spawned, true);
  });
}

export async function case26(): Promise<void> {


  await checkAsync('F-005: storyId with a store phase of null falls back to adhoc (no fabricated phase)', async () => {
    const sub = freshRoot();
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex', storyId: 'B-70e9' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT }), resolveStory: () => ({ phase: null }) },
    );
    assert.equal(result.phase, 'adhoc', 'a store with no recorded phase resolves to adhoc');
  });
}
