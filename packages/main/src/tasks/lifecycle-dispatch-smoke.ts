import assert from 'assert';
import { commitInitCheckMetadataAndMergeMain } from '../cli-engine.js';
import { runStoryAdvanceInitCheckLifecycleDispatch } from '../cli/lifecycle-dispatch.js';
import { dispatchRecoverEvidenceWithStructuredFailure } from '../cli/recover-evidence-dispatch.js';
import type { StoryStore } from '../core/store.js';

async function smokeInitCheckDryRun(): Promise<void> {
  let runCalled = false;
  let output = '';
  let storyGetCalled = false;
  let devStartCalled = false;

  await runStoryAdvanceInitCheckLifecycleDispatch({
    data: { storyId: 'B-smoke', phase: 'INIT_CHECK', dryRun: true },
    gitReady: true,
    handlers: {
      story_get(args: Record<string, unknown>) {
        storyGetCalled = true;
        assert.deepStrictEqual(args, { storyId: 'B-smoke', detail: true });
        return { index: { phase: 'INIT' } };
      },
      dev_start() {
        devStartCalled = true;
        throw new Error('dev_start must not run for dry-run');
      },
    },
    root: '/tmp/proof-or-stop-lifecycle-dispatch-smoke',
    run: async (fn) => {
      runCalled = true;
      output = String(await fn());
    },
    store: {} as StoryStore,
    getGuardFailureReason: () => {
      throw new Error('guard must not run for dry-run');
    },
    commitInitCheckMetadataAndMergeMain: () => {
      throw new Error('metadata sync must not run for dry-run');
    },
  });

  assert.equal(runCalled, true, 'INIT_CHECK dry-run must execute through run wrapper');
  assert.equal(storyGetCalled, true, 'INIT_CHECK dry-run must read current phase');
  assert.equal(devStartCalled, false, 'INIT_CHECK dry-run must not bootstrap worktree');
  assert.match(output, /\[DRY-RUN\] INIT_CHECK bootstrap plan for B-smoke/);
  assert.match(output, /no phase, branch, commit, or worktree changes were made/);
}

async function smokeRecoverEvidenceDispatch(): Promise<void> {
  const refusedStdout: string[] = [];
  await assert.rejects(
    () => dispatchRecoverEvidenceWithStructuredFailure({
      data: { storyId: 'B-smoke' },
      handler: async () => ({
        status: 'refused',
        refused: { reason: 'dirty material paths present' },
      }),
      stdout: { write: (chunk) => refusedStdout.push(chunk) },
    }),
    /dirty material paths present/,
  );
  assert.equal(refusedStdout.length, 1, 'refused result must be written before throwing');
  assert.equal(JSON.parse(refusedStdout[0]).status, 'refused');

  const failStdout: string[] = [];
  await assert.rejects(
    () => dispatchRecoverEvidenceWithStructuredFailure({
      data: { storyId: 'B-smoke' },
      handler: async () => ({ status: 'fail', validateTranscript: 'nope' }),
      stdout: { write: (chunk) => failStdout.push(chunk) },
    }),
    /recover_evidence: validate failed after refresh; inspect validateTranscript for details/,
  );
  assert.equal(failStdout.length, 1, 'fail result must be written before throwing');
  assert.equal(JSON.parse(failStdout[0]).status, 'fail');

  const successStdout: string[] = [];
  const success = await dispatchRecoverEvidenceWithStructuredFailure({
    data: { storyId: 'B-smoke' },
    handler: async () => ({ status: 'pass' }),
    stdout: { write: (chunk) => successStdout.push(chunk) },
  });
  assert.deepStrictEqual(success, { status: 'pass' });
  assert.equal(successStdout.length, 0, 'success result must pass through without eager stdout writes');
}

function smokeCompatibilityExport(): void {
  assert.equal(typeof commitInitCheckMetadataAndMergeMain, 'function');
}

await smokeInitCheckDryRun();
await smokeRecoverEvidenceDispatch();
smokeCompatibilityExport();

console.log('lifecycle-dispatch-smoke passed');
