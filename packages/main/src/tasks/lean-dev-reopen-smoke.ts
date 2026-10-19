#!/usr/bin/env node
/**
 * Lab lean-dev (old-PoS runs 117 / 118; bench-staging/oldpos/run114-120-analysis.md): unit level, made-up rows only (no
 * benchmark-task material). The lifecycle shape is harness NLN-X in tasks/e2e-review-to-done-smoke.ts.
 *
 * Runs 117 and 118 (pipeline.lean=on, implementation.grouping=story) failed in DEV the same way:
 *   (a) the Story run's commit named the member CHK-002, so the framework marked it done (story_item_done); with every
 *       item done the exact-text gate reopened it; the next devNext call found the SAME Story-run commit naming it and
 *       marked it done again; the gate reopened it again: 40 framework steps per `next --run`, never an implementer
 *       launch for the reopened item.
 *   (b) the owner hand-launched `host_run itemId=CHK-002` while the item stood done (the loop's last step was
 *       story_item_done; in 118 the owner ran it by hand): the worker's completion call was done->done, which binds no
 *       run-bound result, so both runs ended managed_dispatch_output_missing although the first one had committed the
 *       fix.
 *
 *   C. A Story run's claim on a member is used once: once the member was marked done at or after the run started (any
 *      path: the framework step, the owner, a worker), the run's commit no longer marks it done; a reopened member then
 *      gets its own implementer run. Done marks before the run, other items and failed results do not use the claim.
 *   T. A managed implementer launch for an item that already stands done is refused before any prompt or provider
 *      (managed_dispatch_target_already_done, with one Next: `next`, which reopens and relaunches what still needs
 *      work); an open item is launchable; an unknown item is refused as an invalid target.
 *
 * Usage: node packages/main/dist/tasks/lean-dev-reopen-smoke.js
 */
import assert from 'node:assert/strict';

type Fn = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
/** A module export that may not exist yet (RED: the check fails, the smoke still runs). */
async function load(path: string, name: string): Promise<Fn> {
  let module: Record<string, unknown> = {};
  try { module = await import(path) as Record<string, unknown>; } catch { module = {}; }
  const fn = module[name];
  assert.ok(fn !== undefined, `${path} exports ${name}`);
  return fn as Fn;
}

const RUN_AT = '2026-10-18T06:46:04.480Z';
const before = '2026-10-18T06:40:00.000Z';
const after = '2026-10-18T06:53:10.000Z';

// ---------------------------------------------------------------------------
// C. The Story run's claim on a member is used once.

await check('C1 a member the framework marked done after the Story run started is not marked done again from that run\'s commit', async () => {
  const used = await load('../core/lean-story-run.js', 'storyRunMemberClaimUsed');
  // Run 117: story_item_done (audit row with the run's reason, subagent_result without a run id), then the exact-text reopen.
  const events = [
    { type: 'subagent_result', checklistId: 'CHK-001', success: true, managedDispatchRunId: 'run-1', timestamp: '2026-10-18T06:51:35.000Z' },
    { type: 'subagent_result', checklistId: 'CHK-002', success: true, timestamp: after },
    { type: 'dispatch', checklistId: 'CHK-002', timestamp: '2026-10-18T06:53:12.000Z' },
  ];
  const auditLog = [
    { itemId: 'CHK-002', action: 'update', from: 'in_progress', to: 'done', timestamp: after, reason: 'Story run run-1 (A/B implementation.grouping=story) implemented CHK-002' },
    { itemId: 'CHK-002', action: 'update', from: 'done', to: 'in_progress', timestamp: '2026-10-18T06:53:12.000Z', reason: 'Request-quoted exact strings asserted only by prefix / contains' },
  ];
  assert.equal(used({ itemId: 'CHK-002', since: RUN_AT, events, auditLog }), true, 'the reopened member: the claim is used');
  assert.equal(used({ itemId: 'CHK-002', since: RUN_AT, events: [], auditLog }), true, 'the audit row alone suffices');
  assert.equal(used({ itemId: 'CHK-002', since: RUN_AT, events: events.slice(1, 2), auditLog: [] }), true, 'the process event alone suffices');
});

await check('C2 the claim is open for a member never marked done since the run started (its first framework done step)', async () => {
  const used = await load('../core/lean-story-run.js', 'storyRunMemberClaimUsed');
  assert.equal(used({ itemId: 'CHK-002', since: RUN_AT, events: [], auditLog: [] }), false, 'nothing recorded');
  // Done BEFORE the run (an earlier DEV visit) and reopened since: the new run's commit may still mark it done.
  assert.equal(used({ itemId: 'CHK-002', since: RUN_AT,
    events: [{ type: 'subagent_result', checklistId: 'CHK-002', success: true, timestamp: before }],
    auditLog: [{ itemId: 'CHK-002', from: 'in_progress', to: 'done', timestamp: before }] }), false, 'a done mark before the run');
  // Other items, failed results, the dispatch row and done->done rewrites do not use it.
  assert.equal(used({ itemId: 'CHK-002', since: RUN_AT,
    events: [
      { type: 'subagent_result', checklistId: 'CHK-003', success: true, timestamp: after },
      { type: 'subagent_result', checklistId: 'CHK-002', success: false, timestamp: after },
      { type: 'dispatch', checklistId: 'CHK-002', timestamp: after },
    ],
    auditLog: [
      { itemId: 'CHK-003', from: 'in_progress', to: 'done', timestamp: after },
      { itemId: 'CHK-002', from: 'done', to: 'done', timestamp: after, reason: 'PLAN amendment kept the item done' },
      { itemId: 'CHK-002', from: 'in_progress', to: 'pending', timestamp: after },
    ] }), false, 'other items / failures / non-transitions');
});

// ---------------------------------------------------------------------------
// T. A managed implementer launch on a done item is refused pre-spawn.

await check('T1 a managed implementer launch for an item that stands done is refused with managed_dispatch_target_already_done and one Next', async () => {
  const refusal = await load('../core/managed-host-run.js', 'managedImplementerTargetRefusal');
  const text = refusal({ storyId: 'B-0001', itemId: 'CHK-002', item: { id: 'CHK-002', status: 'done' }, prior: null });
  assert.equal(typeof text, 'string', 'refused');
  assert.match(text, /managed_dispatch_target_already_done/, 'the classified reason');
  assert.match(text, /CHK-002 is already done/, 'names the item');
  assert.match(text, /done->done|already done.*cannot/i, 'says why a run cannot deliver');
  assert.match(text, /Next: proof-or-stop next --storyId=B-0001/, 'one Next');
  assert.doesNotMatch(text, /host_run/, 'never tells the owner to hand-launch');
  const sealed = refusal({ storyId: 'B-0001', itemId: 'CHK-002', item: { id: 'CHK-002', status: 'done' }, prior: { runId: 'run-9', commit: 'abc1234' } });
  assert.match(sealed, /completed by managed run run-9 \(commit abc1234\)/, 'a sealed completion keeps the run-15 wording');
});

await check('T2 an open item is launchable; an unknown item is refused as an invalid target', async () => {
  const refusal = await load('../core/managed-host-run.js', 'managedImplementerTargetRefusal');
  for (const status of ['pending', 'in_progress']) {
    assert.equal(refusal({ storyId: 'B-0001', itemId: 'CHK-002', item: { id: 'CHK-002', status }, prior: null }), null, status);
  }
  const unknown = refusal({ storyId: 'B-0001', itemId: 'CHK-009', item: undefined, prior: null });
  assert.match(String(unknown), /managed_dispatch_target_invalid/, 'unknown item');
});

if (failures.length > 0) {
  console.log(`\nlean-dev-reopen-smoke: ${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nlean-dev-reopen-smoke: all checks passed');
