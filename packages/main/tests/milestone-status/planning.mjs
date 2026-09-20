import { assert, execFileSync, spawnSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, tmpdir, join, fileURLToPath, distRoot, cliPath, buildMilestoneCloseoutSnapshot, buildMilestoneStatusReport, buildMilestoneStatusReportFromCloseoutSnapshot, milestoneStatusReportDigest, renderMilestoneCloseoutSnapshot, renderMilestoneStatusReport, renderChecklistDerivedLedger, EMPTY_STORY_FILES_HASH, currentMaterialHash, signDeliveryCheck, evaluateDoneIntentEquivalence, StoryStore, captureMilestoneCloseoutSnapshotFromStore, createMilestoneStatusHandlers, createStoryAdvanceHandlers, createPlaybookRuntimeMemoryHandlers, satisfyDevMemoryFinishDecisionAndCommit, story, intent, checklistItem, evidence, ledger, writeTestConfig, validStoryBackground, runJsonCommand, runTextCommand, storyDirs, milestone, writeJson, assertTextContract, assertCloseoutTextContract, assertReportShape, assertRowShape, assertEvidenceRefShape } from './support.mjs';

export async function case02() {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-milestone-ledger-planning-writes-'));
  const readLedger = (storyId) => JSON.parse(readFileSync(
    join(root, '.proof-or-stop', 'story', 'actives', storyId, 'milestone-ledger.json'),
    'utf8',
  ));
  const ledgerExists = (storyId) => existsSync(join(root, '.proof-or-stop', 'story', 'actives', storyId, 'milestone-ledger.json'));
  const parseStoryId = (text) => {
    const match = text.match(/\bB-[0-9a-f]{4,6}\b/i);
    assert.ok(match, `expected story id in output: ${text}`);
    return match[0];
  };
  const explicitMilestones = [
    milestone({
      id: 'M-auto',
      sourceRequirementId: 'REQ-auto',
      claim: 'Structured milestone rows create a candidate ledger',
      doneMeans: 'A planning write with explicit rows persists milestone-ledger.json',
      requiredEvidence: ['cli_blackbox'],
      checklistRefs: ['CHK-001'],
      verificationIntentRefs: ['CHK-001:happy:0'],
    }),
  ];

  try {
    writeTestConfig(root);

    const createdWithLedger = runTextCommand(root, 'story_create', {
      name: 'auto-ledger-story-create',
      title: 'Auto ledger story create',
      description: 'Create a candidate milestone ledger from explicit structured milestone rows.',
      type: 'feature',
      priority: 'high',
      forceNew: true,
      background: validStoryBackground('story_create structured rows'),
      checklist: [{ title: 'Deliver structured milestone rows', context: 'Explicit rows should be persisted as a ledger.' }],
      milestones: explicitMilestones,
    });
    const storyCreateLedgerId = parseStoryId(createdWithLedger);
    const storyCreateLedger = readLedger(storyCreateLedgerId);
    assert.equal(storyCreateLedger.state, 'candidate', 'story_create writes explicit rows as a candidate ledger');
    assert.equal(storyCreateLedger.milestones.length, 1);
    assert.equal(storyCreateLedger.milestones[0].id, 'M-auto');

    const createdWithoutLedger = runTextCommand(root, 'story_create', {
      name: 'auto-ledger-story-create-no-rows',
      title: 'Auto ledger story create no rows',
      description: 'Deliver all milestones mentioned in prose, but do not provide structured rows.',
      type: 'feature',
      priority: 'high',
      forceNew: true,
      background: validStoryBackground('story_create prose only'),
      checklist: [{ title: 'Deliver all milestones from prose only', context: 'No structured milestone rows are supplied.' }],
    });
    const noLedgerStoryId = parseStoryId(createdWithoutLedger);
    assert.equal(ledgerExists(noLedgerStoryId), false, 'story_create does not infer milestone-ledger.json from prose/checklist text');

    const beforeMalformed = storyDirs(root);
    const malformed = spawnSync(process.execPath, [
      cliPath,
      '--root',
      root,
      'story_create',
      JSON.stringify({
        name: 'auto-ledger-story-create-duplicate-rows',
        title: 'Auto ledger story create duplicate rows',
        description: 'Duplicate milestone ids should reject before metadata is written.',
        type: 'feature',
        priority: 'high',
        forceNew: true,
        background: validStoryBackground('story_create malformed rows'),
        checklist: [{ title: 'Reject duplicate rows', context: 'The ledger builder must fail before persistence.' }],
        milestones: [
          ...explicitMilestones,
          milestone({
            id: 'M-auto',
            sourceRequirementId: 'REQ-auto-duplicate',
            claim: 'Duplicate row',
            doneMeans: 'This duplicate must be rejected',
          }),
        ],
      }),
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(malformed.status, 0, 'story_create rejects malformed/duplicate milestone rows');
    assert.match(`${malformed.stdout}\n${malformed.stderr}`, /duplicate milestone id: M-auto/);
    assert.deepEqual(storyDirs(root), beforeMalformed, 'malformed milestone rows fail before story metadata is persisted');

    const plannerDraft = runJsonCommand(root, 'planner_draft', {
      request: 'Implement an explicit planner milestone ledger pass-through.',
      milestones: explicitMilestones,
    });
    const plannerCreated = runJsonCommand(root, 'planner_create_story', {
      runId: plannerDraft.plannerRunId,
      forceNew: true,
    });
    assert.equal(plannerCreated.status, 'created');
    const plannerLedger = readLedger(plannerCreated.storyId);
    assert.equal(plannerLedger.state, 'candidate', 'planner_create_story passes explicit draft milestones into story_create');
    assert.equal(plannerLedger.milestones[0].id, 'M-auto');

    const proseOnlyDraft = runJsonCommand(root, 'planner_draft', {
      request: 'Deliver all milestones M1 and M2 from this prose-only planner request.',
      forceNewRun: true,
      forceNewRunReason: 'verify prose-only planner draft does not infer milestone rows',
    });
    const proseOnlyCreated = runJsonCommand(root, 'planner_create_story', {
      runId: proseOnlyDraft.plannerRunId,
      forceNew: true,
    });
    assert.equal(proseOnlyCreated.status, 'created');
    assert.equal(ledgerExists(proseOnlyCreated.storyId), false, 'planner_create_story does not infer ledgers from draft prose');

    const previewStoryId = 'B-planpreview';
    const previewStoryDir = join(root, '.proof-or-stop', 'story', 'actives', previewStoryId);
    mkdirSync(previewStoryDir, { recursive: true });
    writeJson(join(previewStoryDir, 'index.json'), {
      ...story(previewStoryId),
      phase: 'PLAN',
      description: 'Plan skeleton preview mentions all milestones, but preview mode must stay read-only.',
    });
    writeJson(join(previewStoryDir, 'checklist.json'), { items: [] });
    const previewReport = runJsonCommand(root, 'plan_skeleton', {
      storyId: previewStoryId,
      milestones: explicitMilestones,
    });
    assert.equal(previewReport.mode.write, false);
    assert.equal(ledgerExists(previewStoryId), false, 'plan_skeleton preview never writes a ledger even when rows are supplied');

    const writeStoryId = 'B-planwrite';
    const writeStoryDir = join(root, '.proof-or-stop', 'story', 'actives', writeStoryId);
    mkdirSync(writeStoryDir, { recursive: true });
    writeJson(join(writeStoryDir, 'index.json'), {
      ...story(writeStoryId),
      phase: 'PLAN',
      description: 'Plan skeleton write should persist explicit rows only.',
    });
    writeJson(join(writeStoryDir, 'checklist.json'), { items: [] });
    const writeReport = runJsonCommand(root, 'plan_skeleton', {
      storyId: writeStoryId,
      write: true,
      milestones: explicitMilestones,
    });
    assert.equal(writeReport.write.milestoneLedger.status, 'written');
    const planSkeletonLedger = readLedger(writeStoryId);
    assert.equal(planSkeletonLedger.state, 'candidate', 'plan_skeleton --write writes explicit rows as a candidate ledger');
    assert.equal(planSkeletonLedger.milestones[0].id, 'M-auto');

    const noMilestoneWriteStoryId = 'B-planwrite-no-rows';
    const noMilestoneWriteStoryDir = join(root, '.proof-or-stop', 'story', 'actives', noMilestoneWriteStoryId);
    mkdirSync(noMilestoneWriteStoryDir, { recursive: true });
    writeJson(join(noMilestoneWriteStoryDir, 'index.json'), {
      ...story(noMilestoneWriteStoryId),
      phase: 'PLAN',
      description: 'Deliver all milestones from prose only; no structured rows are present.',
    });
    writeJson(join(noMilestoneWriteStoryDir, 'checklist.json'), { items: [] });
    const noMilestoneWriteReport = runJsonCommand(root, 'plan_skeleton', {
      storyId: noMilestoneWriteStoryId,
      write: true,
    });
    assert.equal(noMilestoneWriteReport.write.milestoneLedger.status, 'skipped_absent');
    assert.equal(ledgerExists(noMilestoneWriteStoryId), false, 'plan_skeleton --write does not synthesize milestone rows from prose');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
