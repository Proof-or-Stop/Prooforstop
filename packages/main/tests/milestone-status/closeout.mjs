import { assert, execFileSync, spawnSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, tmpdir, join, fileURLToPath, distRoot, cliPath, buildMilestoneCloseoutSnapshot, buildMilestoneStatusReport, buildMilestoneStatusReportFromCloseoutSnapshot, milestoneStatusReportDigest, renderMilestoneCloseoutSnapshot, renderMilestoneStatusReport, renderChecklistDerivedLedger, EMPTY_STORY_FILES_HASH, currentMaterialHash, signDeliveryCheck, evaluateDoneIntentEquivalence, StoryStore, captureMilestoneCloseoutSnapshotFromStore, createMilestoneStatusHandlers, createStoryAdvanceHandlers, createPlaybookRuntimeMemoryHandlers, satisfyDevMemoryFinishDecisionAndCommit, story, intent, checklistItem, evidence, ledger, writeTestConfig, validStoryBackground, runJsonCommand, runTextCommand, storyDirs, milestone, writeJson, assertTextContract, assertCloseoutTextContract, assertReportShape, assertRowShape, assertEvidenceRefShape } from './support.mjs';

export async function case05() {
  const closeoutStory = story('B-closeout');
  closeoutStory.phase = 'TEST';
  const cl = {
    items: [
      checklistItem('CHK-CLOSE', 'done', [
        evidence('CHK-CLOSE:happy:0', 'pass', {
          headHash: 'head-closeout',
          materialHash: 'material-closeout',
          storyFilesHash: 'story-closeout',
        }),
      ], intent('closeout evidence')),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: closeoutStory,
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-closeout',
        sourceRequirementId: 'REQ-closeout',
        claim: 'Users can read the final solved problem',
        doneMeans: 'A completed risk-free report can be frozen',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-CLOSE'],
        verificationIntentRefs: ['CHK-CLOSE:happy:0'],
        status: 'done',
      }),
    ], 'B-closeout'),
    currentEvidenceBinding: {
      headHash: 'head-closeout',
      materialHash: 'material-closeout',
      storyFilesHash: 'story-closeout',
    },
  });

  const snapshot = buildMilestoneCloseoutSnapshot({
    report,
    bindings: {
      headHash: 'head-closeout',
      materialHash: 'material-closeout',
      storyFilesHash: 'story-closeout',
    },
    generatedAt: '2026-07-04T12:00:00.000Z',
  });

  assert.equal(snapshot.schemaVersion, 'proof-or-stop.milestone_closeout.v1');
  assert.equal(snapshot.storyId, 'B-closeout');
  assert.equal(snapshot.phase, 'TEST');
  assert.equal(snapshot.generatedAt, '2026-07-04T12:00:00.000Z');
  assert.equal(snapshot.sourceReport.schemaVersion, 'proof-or-stop.milestone_status.v1');
  assert.equal(snapshot.sourceReport.digest, milestoneStatusReportDigest(report));
  assert.deepEqual(snapshot.sourceReport.groups, { completed: ['M-closeout'], current: [], remaining: [] });
  assert.deepEqual(snapshot.bindings, {
    headHash: 'head-closeout',
    materialHash: 'material-closeout',
    storyFilesHash: 'story-closeout',
  });
  assert.equal(snapshot.rows.length, 1);
  assert.deepEqual(Object.keys(snapshot.rows[0]).sort(), [
    'acceptance',
    'evidence',
    'milestone',
    'nextAction',
    'risks',
    'solvedProblem',
    'status',
  ]);
  assert.equal(snapshot.rows[0].milestone, 'M-closeout');
  assert.match(snapshot.rows[0].status, /^completed /);
  assert.equal(snapshot.rows[0].solvedProblem, 'Users can read the final solved problem');
  assert.equal(snapshot.rows[0].acceptance, 'A completed risk-free report can be frozen');
  assert.match(snapshot.rows[0].evidence.join('\n'), /CHK-CLOSE:happy:0 \[pass\/logic_test\]/);
  assert.deepEqual(snapshot.rows[0].risks, []);
  assert.equal(snapshot.rows[0].nextAction, 'No action for this milestone.');

  const text = renderMilestoneCloseoutSnapshot(snapshot);
  assertCloseoutTextContract(text);
  assert.match(text, /Source milestone_status digest:/);
  assert.match(text, /\| M-closeout \| completed \(ledger=done; checklist=complete; evidence=covered; requiredEvidence=covered\) \| Users can read the final solved problem \|/);

  const snapshotBackedReport = buildMilestoneStatusReportFromCloseoutSnapshot(snapshot, { phase: 'DONE' });
  assert.equal(snapshotBackedReport.schemaVersion, 'proof-or-stop.milestone_status.v1');
  assertReportShape(snapshotBackedReport);
  assert.equal(snapshotBackedReport.storyId, 'B-closeout');
  assert.equal(snapshotBackedReport.phase, 'DONE');
  assert.deepEqual(snapshotBackedReport.ledger, report.ledger);
  assert.deepEqual(snapshotBackedReport.groups, { completed: ['M-closeout'], current: [], remaining: [] });
  assert.deepEqual(snapshotBackedReport.risks, []);
  assert.deepEqual(snapshotBackedReport.nextActions, ['No milestone action; all ledger rows are completed or not applicable.']);
  assert.equal(snapshotBackedReport.milestones.length, 1);
  assertRowShape(snapshotBackedReport.milestones[0]);
  assert.equal(snapshotBackedReport.milestones[0].status, 'completed');
  assert.equal(snapshotBackedReport.milestones[0].statusDetail, 'ledger=done; checklist=complete; evidence=covered; requiredEvidence=covered');
  assert.equal(snapshotBackedReport.milestones[0].ledgerStatus, 'done');
  assert.equal(snapshotBackedReport.milestones[0].evidenceRefs[0].intentRef, 'CHK-CLOSE:happy:0');
  assert.equal(snapshotBackedReport.milestones[0].evidenceRefs[0].status, 'pass');
  const snapshotBackedText = renderMilestoneStatusReport(snapshotBackedReport);
  assertTextContract(snapshotBackedText.replaceAll('B-closeout', 'B-7ba7'));
  assert.match(snapshotBackedText, /Milestone Status - B-closeout/);
  assert.match(snapshotBackedText, /\| M-closeout \| Users can read the final solved problem \| ✅ Done \(ledger=done; checklist=complete; evidence=covered; requiredEvidence=covered\) \|/);

  const plannedLedgerStoryId = 'B-closeout-planned-ledger';
  const plannedLedgerReport = buildMilestoneStatusReport({
    story: story(plannedLedgerStoryId),
    checklist: {
      items: [
        checklistItem('CHK-PLANNED-CLOSEOUT', 'done', [
          evidence('CHK-PLANNED-CLOSEOUT:happy:0'),
        ], intent('planned ledger evidence is covered')),
      ],
    },
    milestoneLedger: ledger([
      milestone({
        id: 'M-planned-closeout',
        sourceRequirementId: 'REQ-planned-closeout',
        claim: 'Closeout completed rows render done even when frozen detail says ledger planned',
        doneMeans: 'The completed closeout group is display-final',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-PLANNED-CLOSEOUT'],
        verificationIntentRefs: ['CHK-PLANNED-CLOSEOUT:happy:0'],
        status: 'planned',
      }),
    ], plannedLedgerStoryId),
  });
  assert.deepEqual(plannedLedgerReport.groups, { completed: ['M-planned-closeout'], current: [], remaining: [] });
  const activePlannedText = renderMilestoneStatusReport(plannedLedgerReport);
  assert.match(
    activePlannedText,
    /\| M-planned-closeout \| Closeout completed rows render done even when frozen detail says ledger planned \| 🟡 Pending Review \(ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered\) \|/,
    'active live planned+covered rows still render Pending Review',
  );
  assert.doesNotMatch(activePlannedText, /✅ Done \(ledger=planned;/);

  const plannedLedgerSnapshot = buildMilestoneCloseoutSnapshot({
    report: plannedLedgerReport,
    bindings: { headHash: 'head-planned-closeout' },
    generatedAt: '2026-07-04T12:30:00.000Z',
  });
  assert.equal(
    plannedLedgerSnapshot.rows[0].status,
    'completed (ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered)',
  );
  const plannedSnapshotBackedReport = buildMilestoneStatusReportFromCloseoutSnapshot(
    plannedLedgerSnapshot,
    { phase: 'DONE' },
  );
  assert.equal(plannedSnapshotBackedReport.milestones[0].status, 'completed');
  assert.equal(plannedSnapshotBackedReport.milestones[0].statusDetail, 'ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered');
  assert.equal(plannedSnapshotBackedReport.milestones[0].ledgerStatus, 'done');
  const plannedSnapshotBackedText = renderMilestoneStatusReport(plannedSnapshotBackedReport);
  assert.match(
    plannedSnapshotBackedText,
    /\| M-planned-closeout \| Closeout completed rows render done even when frozen detail says ledger planned \| ✅ Done \(ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered\) \|/,
    'DONE closeout-backed completed rows render Done even when frozen ledger detail is planned',
  );
  assert.doesNotMatch(plannedSnapshotBackedText, /🟡 Pending Review \(ledger=planned;/);

  const laterLiveReport = buildMilestoneStatusReport({
    story: closeoutStory,
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-closeout',
        sourceRequirementId: 'REQ-closeout',
        claim: 'Users can read the final solved problem',
        doneMeans: 'A completed risk-free report can be frozen',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-CLOSE'],
        verificationIntentRefs: ['CHK-CLOSE:happy:0'],
        status: 'done',
      }),
    ], 'B-closeout'),
    currentEvidenceBinding: {
      headHash: 'head-later',
      materialHash: 'material-later',
      storyFilesHash: 'story-later',
    },
  });
  assert.deepEqual(laterLiveReport.groups.completed, [], 'later live milestone_status can become stale');
  assert.equal(snapshot.rows[0].milestone, 'M-closeout', 'closeout snapshot preserves the accepted row');
  assert.match(snapshot.rows[0].status, /^completed /, 'closeout snapshot remains the historical completed state');
}

export async function case20() {
  const reads = [];
  const writes = [];
  const skipped = captureMilestoneCloseoutSnapshotFromStore({
    readMilestoneLedger() {
      reads.push('ledger');
      return null;
    },
    readStory() {
      reads.push('story');
      throw new Error('readStory should not be called when ledger is missing');
    },
    readChecklist() {
      reads.push('checklist');
      throw new Error('readChecklist should not be called when ledger is missing');
    },
    readSummary() {
      reads.push('summary');
      throw new Error('readSummary should not be called when ledger is missing');
    },
    writeMilestoneCloseout() {
      writes.push('write');
    },
  }, 'B-capture-missing');
  assert.deepEqual(skipped, {
    status: 'skipped',
    reason: 'missing_milestone_ledger',
    message: 'No milestone-ledger.json exists for B-capture-missing; DONE milestone closeout capture skipped.',
  });
  assert.deepEqual(reads, ['ledger']);
  assert.deepEqual(writes, []);
}

export async function case21() {
  const storyId = 'B-capture';
  const captureStory = story(storyId);
  captureStory.phase = 'TEST';
  const captureChecklist = {
    items: [
      checklistItem('CHK-CAPTURE', 'done', [
        evidence('CHK-CAPTURE:happy:0', 'pass', {
          headHash: 'head-capture',
          materialHash: 'material-capture',
          storyFilesHash: 'story-capture',
        }),
      ], intent('capture helper evidence')),
    ],
  };
  const captureLedger = ledger([
    milestone({
      id: 'M-capture',
      sourceRequirementId: 'REQ-capture',
      claim: 'DONE path writes closeout before phase metadata',
      doneMeans: 'Completed risk-free report produces a snapshot',
      requiredEvidence: ['logic_test'],
      checklistRefs: ['CHK-CAPTURE'],
      verificationIntentRefs: ['CHK-CAPTURE:happy:0'],
      status: 'done',
    }),
  ], storyId);
  const writes = [];
  const result = captureMilestoneCloseoutSnapshotFromStore({
    readMilestoneLedger() {
      return captureLedger;
    },
    readStory() {
      return captureStory;
    },
    readChecklist() {
      return captureChecklist;
    },
    readSummary() {
      return null;
    },
    writeMilestoneCloseout(id, snapshot) {
      writes.push({ id, snapshot });
    },
  }, storyId, {
    currentEvidenceBinding: {
      headHash: 'head-capture',
      materialHash: 'material-capture',
      storyFilesHash: 'story-capture',
    },
    generatedAt: '2026-07-04T13:00:00.000Z',
  });
  assert.equal(result.status, 'written');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, storyId);
  assert.equal(writes[0].snapshot.generatedAt, '2026-07-04T13:00:00.000Z');
  assert.equal(writes[0].snapshot.rows[0].milestone, 'M-capture');
  assert.equal(writes[0].snapshot.phase, 'TEST', 'capture happens before DONE phase metadata is written');
}

export async function case22() {
  const storyId = 'B-done-closeout';
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-closeout-'));
  const originalCwd = process.cwd();
  const originalSettlementEnabled = process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED;
  const originalCandidateIngestEnabled = process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED;
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  try {
    process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED = '0';
    process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED = '0';
    process.chdir(root);
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Milestone Status Test']);
    git(['config', 'user.email', 'milestone-status@example.com']);
    writeJson(join(root, 'proof-or-stop.config.json'), {
      scanRoot: '.',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      workflow: { profile: 'light' },
      proofStory: { doneGateMode: 'observe', reviewGateMode: 'observe' },
      flows: { defaults: {}, patterns: [] },
    });
    git(['add', 'proof-or-stop.config.json']);
    git(['commit', '-m', 'init']);

    const store = new StoryStore(root);
    satisfyDevMemoryFinishDecisionAndCommit(root, store, storyId, git);
    const preEvidenceHead = git(['rev-parse', 'HEAD']);
    const preEvidenceMaterialHash = currentMaterialHash(root, 'HEAD', root);
    assert.ok(preEvidenceMaterialHash, 'fixture must be able to compute a material hash');
    const doneStory = {
      ...story(storyId),
      phase: 'TEST',
      priority: 'low',
      currentReviewRound: '2026-07-04T10:00:00.000Z',
    };
    const closeoutChecklist = {
      items: [
        checklistItem('CHK-DONE-CLOSEOUT', 'done', [
          evidence('CHK-DONE-CLOSEOUT:happy:0', 'pass', {
            headHash: preEvidenceHead,
            materialHash: preEvidenceMaterialHash,
          }),
        ], intent('DONE handler evidence')),
      ],
    };
    const docsPromises = [];
    const realMachineTests = [
      {
        featureId: 'milestone-closeout-done-transition',
        transcript: 'Focused temp-repo story_advance DONE fixture reached the closeout capture path.',
      },
    ];
    const closingSelfCheck = {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'The DONE transition fixture has enough signed delivery context for the orchestrator gate.',
    };
    const reviewRound = doneStory.currentReviewRound;

    store.writeStory(storyId, doneStory);
    store.writeChecklist(storyId, closeoutChecklist);
    store.writeMilestoneLedger(storyId, ledger([
      milestone({
        id: 'M-done-closeout',
        sourceRequirementId: 'REQ-done-closeout',
        claim: 'The real DONE transition writes milestone-closeout.json',
        doneMeans: 'A completed milestone snapshot is persisted during story_advance DONE',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-DONE-CLOSEOUT'],
        verificationIntentRefs: ['CHK-DONE-CLOSEOUT:happy:0'],
        status: 'done',
      }),
    ], storyId));
    store.writeTestEvidence(storyId, {
      command: `proof-or-stop validate --story=${storyId} --json`,
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-07-04T11:00:00.000Z',
      headHash: preEvidenceHead,
      materialHash: preEvidenceMaterialHash,
    });
    store.writeDeliveryCheck(storyId, {
      storyId,
      checkedAt: '2026-07-04T11:30:00.000Z',
      headHash: preEvidenceHead,
      materialHash: preEvidenceMaterialHash,
      reviewRound,
      agentId: 'proof-or-stop-review-delivery',
      docsPromises,
      realMachineTests,
      closingSelfCheck,
      _hash: signDeliveryCheck(
        storyId,
        docsPromises,
        realMachineTests,
        closingSelfCheck,
        reviewRound,
        preEvidenceMaterialHash,
      ),
    });
    git(['add', '.']);
    git(['commit', '-m', 'ready for DONE']);
    assert.equal(git(['status', '--porcelain']), '', 'fixture must be clean before the DONE gate runs');
    assert.equal(currentMaterialHash(root, 'HEAD', root), preEvidenceMaterialHash);
    const doneHead = git(['rev-parse', 'HEAD']);

    const logs = [];
    const handlers = createStoryAdvanceHandlers({
      root,
      scanRoot: root,
      store,
      log: (msg) => logs.push(msg),
    });
    const output = await handlers.story_advance({ storyId, phase: 'DONE' });

    assert.match(output, new RegExp(`Story ${storyId} advanced to DONE`));
    assert.equal(store.readStory(storyId).phase, 'DONE');
    assert.ok(
      existsSync(store.storyFilePath(storyId, 'milestone-closeout.json')),
      'story_advance DONE must persist milestone-closeout.json through transition-orchestrator wiring',
    );
    assert.ok(
      logs.some((line) => line.includes(`milestone closeout snapshot captured for ${storyId}`)),
      'story_advance DONE should report the closeout capture path',
    );
    const snapshot = store.readMilestoneCloseout(storyId);
    assert.ok(snapshot);
    assert.equal(snapshot.schemaVersion, 'proof-or-stop.milestone_closeout.v1');
    assert.equal(snapshot.storyId, storyId);
    assert.equal(snapshot.phase, 'TEST', 'closeout is captured before DONE phase metadata is persisted');
    assert.equal(snapshot.bindings.headHash, doneHead);
    assert.equal(snapshot.bindings.materialHash, preEvidenceMaterialHash);
    assert.equal(snapshot.rows[0].milestone, 'M-done-closeout');
  } finally {
    process.chdir(originalCwd);
    if (originalSettlementEnabled === undefined) {
      delete process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED;
    } else {
      process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED = originalSettlementEnabled;
    }
    if (originalCandidateIngestEnabled === undefined) {
      delete process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED;
    } else {
      process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED = originalCandidateIngestEnabled;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

export async function case23() {
  const storyId = 'B-done-closeout-worktree';
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-closeout-worktree-'));
  const mainRoot = join(root, 'main');
  const worktreeRoot = join(root, 'story-worktree');
  const originalCwd = process.cwd();
  const originalSettlementEnabled = process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED;
  const originalCandidateIngestEnabled = process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED;
  const gitMain = (args) => execFileSync('git', args, {
    cwd: mainRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const gitWorktree = (args) => execFileSync('git', args, {
    cwd: worktreeRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  try {
    process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED = '0';
    process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED = '0';
    mkdirSync(mainRoot, { recursive: true });
    gitMain(['init', '-b', 'main']);
    gitMain(['config', 'user.name', 'Milestone Status Test']);
    gitMain(['config', 'user.email', 'milestone-status@example.com']);
    writeJson(join(mainRoot, 'proof-or-stop.config.json'), {
      scanRoot: '.',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      workflow: { profile: 'light' },
      proofStory: { doneGateMode: 'observe', reviewGateMode: 'observe' },
      flows: { defaults: {}, patterns: [] },
    });
    gitMain(['add', 'proof-or-stop.config.json']);
    gitMain(['commit', '-m', 'init']);
    gitMain(['worktree', 'add', '-b', `story/${storyId}`, worktreeRoot]);

    process.chdir(worktreeRoot);
    const store = new StoryStore(worktreeRoot);
    satisfyDevMemoryFinishDecisionAndCommit(worktreeRoot, store, storyId, gitWorktree);
    const preEvidenceHead = gitWorktree(['rev-parse', 'HEAD']);
    const preEvidenceMaterialHash = currentMaterialHash(worktreeRoot, 'HEAD', worktreeRoot);
    assert.ok(preEvidenceMaterialHash, 'worktree fixture must be able to compute a material hash');
    const doneStory = {
      ...story(storyId),
      phase: 'TEST',
      priority: 'low',
      currentReviewRound: '2026-07-04T10:00:00.000Z',
    };
    const closeoutChecklist = {
      items: [
        checklistItem('CHK-DONE-CLOSEOUT', 'done', [
          evidence('CHK-DONE-CLOSEOUT:happy:0', 'pass', {
            headHash: preEvidenceHead,
            materialHash: preEvidenceMaterialHash,
          }),
        ], intent('DONE handler worktree cleanup evidence')),
      ],
    };
    const docsPromises = [];
    const realMachineTests = [
      {
        featureId: 'milestone-closeout-done-worktree-transition',
        transcript: 'Focused worktree story_advance DONE fixture must leave closeout readable from canonical main.',
      },
    ];
    const closingSelfCheck = {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'The worktree DONE transition fixture has enough signed delivery context for the orchestrator gate.',
    };
    const reviewRound = doneStory.currentReviewRound;

    store.writeStory(storyId, doneStory);
    store.writeChecklist(storyId, closeoutChecklist);
    store.writeMilestoneLedger(storyId, ledger([
      milestone({
        id: 'M-done-closeout-worktree',
        sourceRequirementId: 'REQ-done-closeout-worktree',
        claim: 'The real DONE worktree cleanup path preserves milestone-closeout.json in canonical main',
        doneMeans: 'After story_advance DONE removes the story worktree, main-root milestone_closeout reads the frozen snapshot',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-DONE-CLOSEOUT'],
        verificationIntentRefs: ['CHK-DONE-CLOSEOUT:happy:0'],
        status: 'done',
      }),
    ], storyId));
    store.writeTestEvidence(storyId, {
      command: `proof-or-stop validate --story=${storyId} --json`,
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-07-04T11:00:00.000Z',
      headHash: preEvidenceHead,
      materialHash: preEvidenceMaterialHash,
    });
    store.writeDeliveryCheck(storyId, {
      storyId,
      checkedAt: '2026-07-04T11:30:00.000Z',
      headHash: preEvidenceHead,
      materialHash: preEvidenceMaterialHash,
      reviewRound,
      agentId: 'proof-or-stop-review-delivery',
      docsPromises,
      realMachineTests,
      closingSelfCheck,
      _hash: signDeliveryCheck(
        storyId,
        docsPromises,
        realMachineTests,
        closingSelfCheck,
        reviewRound,
        preEvidenceMaterialHash,
      ),
    });
    gitWorktree(['add', '.']);
    gitWorktree(['commit', '-m', 'ready for DONE in story worktree']);
    assert.equal(gitWorktree(['status', '--porcelain']), '', 'story worktree fixture must be clean before the DONE gate runs');
    assert.equal(gitMain(['status', '--porcelain']), '', 'main worktree fixture must be clean before the DONE merge runs');
    assert.equal(currentMaterialHash(worktreeRoot, 'HEAD', worktreeRoot), preEvidenceMaterialHash);
    const doneHead = gitWorktree(['rev-parse', 'HEAD']);

    const logs = [];
    const handlers = createStoryAdvanceHandlers({
      root: worktreeRoot,
      scanRoot: worktreeRoot,
      store,
      log: (msg) => logs.push(msg),
    });
    const output = await handlers.story_advance({ storyId, phase: 'DONE' });
    process.chdir(mainRoot);

    assert.match(output, new RegExp(`Story ${storyId} advanced to DONE`));
    assert.ok(!existsSync(worktreeRoot), 'story_advance DONE should remove the story worktree after merging to main');
    assert.ok(
      logs.some((line) => line.includes(`milestone closeout snapshot captured for ${storyId}`)),
      'story_advance DONE should report the closeout capture path before cleanup',
    );
    const mainStore = new StoryStore(mainRoot);
    const snapshot = mainStore.readMilestoneCloseout(storyId);
    assert.ok(snapshot, 'canonical main must retain milestone-closeout.json after worktree cleanup');
    assert.equal(snapshot.schemaVersion, 'proof-or-stop.milestone_closeout.v1');
    assert.equal(snapshot.storyId, storyId);
    assert.equal(snapshot.phase, 'TEST', 'closeout is captured before DONE phase metadata is persisted');
    assert.equal(snapshot.bindings.headHash, doneHead);
    assert.equal(snapshot.bindings.materialHash, preEvidenceMaterialHash);
    assert.equal(snapshot.rows[0].milestone, 'M-done-closeout-worktree');

    const closeoutJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      mainRoot,
      '--storyId',
      storyId,
      '--format=json',
    ], { cwd: mainRoot, encoding: 'utf8' }));
    assert.equal(closeoutJson.schemaVersion, 'proof-or-stop.milestone_closeout.v1');
    assert.equal(closeoutJson.rows[0].milestone, 'M-done-closeout-worktree');
    assert.equal(
      gitMain(['status', '--porcelain', '--untracked-files=no']),
      '',
      'DONE merge cleanup should leave canonical main without tracked dirt',
    );
  } finally {
    process.chdir(originalCwd);
    if (originalSettlementEnabled === undefined) {
      delete process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED;
    } else {
      process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED = originalSettlementEnabled;
    }
    if (originalCandidateIngestEnabled === undefined) {
      delete process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED;
    } else {
      process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED = originalCandidateIngestEnabled;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

export async function case24() {
  // B-f7b3 CHK-010 reconciliation (b): the DONE-time closeout capture must NOT
  // act as an undesigned second DONE gate with throw-semantics. On an incomplete
  // report (which buildMilestoneCloseoutSnapshot still rejects at the pure-builder
  // level) capture must DEGRADE to a non-throwing 'skipped' result and write
  // nothing — leaving evaluateDoneIntentEquivalence as the single designed gate.
  const storyId = 'B-capture-incomplete';
  const writes = [];
  let result;
  assert.doesNotThrow(() => {
    result = captureMilestoneCloseoutSnapshotFromStore({
      readMilestoneLedger() {
        return ledger([
          milestone({
            id: 'M-incomplete',
            sourceRequirementId: 'REQ-incomplete',
            claim: 'Incomplete rows block closeout',
            doneMeans: 'Missing evidence cannot be frozen as success',
            requiredEvidence: [],
            checklistRefs: ['CHK-INCOMPLETE'],
            verificationIntentRefs: ['CHK-INCOMPLETE:happy:0'],
            status: 'done',
          }),
        ], storyId);
      },
      readStory() {
        return story(storyId);
      },
      readChecklist() {
        return {
          items: [
            checklistItem('CHK-INCOMPLETE', 'done', [], intent('missing evidence')),
          ],
        };
      },
      readSummary() {
        return null;
      },
      writeMilestoneCloseout() {
        writes.push('write');
      },
    }, storyId);
  }, 'DONE-time closeout capture must not throw on an incomplete report (no divergent second gate)');
  assert.equal(result.status, 'skipped', 'incomplete capture must degrade to a skipped result');
  assert.equal(result.reason, 'closeout_snapshot_unbuildable', 'incomplete capture must report closeout_snapshot_unbuildable');
  assert.match(result.message, /incomplete milestone rows: M-incomplete=current/, 'skip message must carry the builder rejection reason');
  assert.deepEqual(writes, [], 'incomplete capture must not write a closeout');
}
