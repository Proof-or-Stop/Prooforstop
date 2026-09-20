import { assert, execFileSync, spawnSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, tmpdir, join, fileURLToPath, distRoot, cliPath, buildMilestoneCloseoutSnapshot, buildMilestoneStatusReport, buildMilestoneStatusReportFromCloseoutSnapshot, milestoneStatusReportDigest, renderMilestoneCloseoutSnapshot, renderMilestoneStatusReport, renderChecklistDerivedLedger, EMPTY_STORY_FILES_HASH, currentMaterialHash, signDeliveryCheck, evaluateDoneIntentEquivalence, StoryStore, captureMilestoneCloseoutSnapshotFromStore, createMilestoneStatusHandlers, createStoryAdvanceHandlers, createPlaybookRuntimeMemoryHandlers, satisfyDevMemoryFinishDecisionAndCommit, story, intent, checklistItem, evidence, ledger, writeTestConfig, validStoryBackground, runJsonCommand, runTextCommand, storyDirs, milestone, writeJson, assertTextContract, assertCloseoutTextContract, assertReportShape, assertRowShape, assertEvidenceRefShape } from './support.mjs';

export async function case17() {
  let readCount = 0;
  const handlers = createMilestoneStatusHandlers({
    root: '/tmp/proof-or-stop-milestone-status',
    scanRoot: '/tmp/proof-or-stop-milestone-status',
    store: {
      readStory() {
        readCount += 1;
        throw new Error('readStory should not be called');
      },
      readChecklist() {
        readCount += 1;
        throw new Error('readChecklist should not be called');
      },
      readMilestoneLedger() {
        readCount += 1;
        throw new Error('readMilestoneLedger should not be called');
      },
      readSummary() {
        readCount += 1;
        throw new Error('readSummary should not be called');
      },
    },
  });

  assert.throws(
    () => handlers.milestone_status({ storyId: 'B-7ba7', surpriseFlag: true }),
    /read-only.*unexpected keys: surpriseFlag/s,
  );
  assert.equal(readCount, 0, 'unexpected args must be rejected before reading story facts');

  assert.throws(
    () => handlers.milestone_closeout({ storyId: 'B-7ba7', surpriseFlag: true }),
    /read-only.*unexpected keys: surpriseFlag/s,
  );
  assert.equal(readCount, 0, 'unexpected closeout args must be rejected before reading story facts');
}

export async function case18() {
  const reads = [];
  const handlers = createMilestoneStatusHandlers({
    root: '/tmp/proof-or-stop-milestone-status',
    scanRoot: '/tmp/proof-or-stop-milestone-status',
    store: {
      readStory() {
        reads.push('story');
        return story();
      },
      readChecklist() {
        reads.push('checklist');
        throw new SyntaxError('missing checklist json');
      },
      readMilestoneLedger() {
        reads.push('ledger');
        return null;
      },
      readSummary() {
        reads.push('summary');
        return null;
      },
    },
  });

  const report = handlers.milestone_status({ storyId: 'B-7ba7', json: true });
  assert.equal(report.schemaVersion, 'proof-or-stop.milestone_status.v1');
  assert.equal(report.mode.readOnly, true);
  assert.equal(report.mode.runCommands, false);
  assert.equal(report.ledger.present, false);
  assert.deepEqual(report.groups, { completed: [], current: [], remaining: [] });
  assert.match(report.risks.join('\n'), /Missing milestone ledger/);
  assert.deepEqual(reads, ['story', 'ledger', 'summary'], 'missing ledger report must not require checklist reads');
}

export async function case19() {
  const reads = [];
  const handlers = createMilestoneStatusHandlers({
    root: '/tmp/proof-or-stop-milestone-status',
    scanRoot: '/tmp/proof-or-stop-milestone-status',
    store: {
      readStory() {
        reads.push('story');
        return story();
      },
      readChecklist() {
        reads.push('checklist');
        throw new SyntaxError('corrupt checklist json');
      },
      readMilestoneLedger() {
        reads.push('ledger');
        return ledger([]);
      },
      readSummary() {
        reads.push('summary');
        return null;
      },
    },
  });

  assert.throws(
    () => handlers.milestone_status({ storyId: 'B-7ba7', json: true }),
    /corrupt checklist json/,
  );
  assert.deepEqual(reads, ['story', 'ledger', 'summary', 'checklist'], 'corrupt checklist must surface when a ledger exists');
}
