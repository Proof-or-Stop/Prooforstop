import { assert, execFileSync, spawnSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, tmpdir, join, fileURLToPath, distRoot, cliPath, buildMilestoneCloseoutSnapshot, buildMilestoneStatusReport, buildMilestoneStatusReportFromCloseoutSnapshot, milestoneStatusReportDigest, renderMilestoneCloseoutSnapshot, renderMilestoneStatusReport, renderChecklistDerivedLedger, EMPTY_STORY_FILES_HASH, currentMaterialHash, signDeliveryCheck, evaluateDoneIntentEquivalence, StoryStore, captureMilestoneCloseoutSnapshotFromStore, createMilestoneStatusHandlers, createStoryAdvanceHandlers, createPlaybookRuntimeMemoryHandlers, satisfyDevMemoryFinishDecisionAndCommit, story, intent, checklistItem, evidence, ledger, writeTestConfig, validStoryBackground, runJsonCommand, runTextCommand, storyDirs, milestone, writeJson, assertTextContract, assertCloseoutTextContract, assertReportShape, assertRowShape, assertEvidenceRefShape } from './support.mjs';

export async function case29() {
  const storyId = 'B-done-cli-append';
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-cli-append-'));
  const mainRoot = join(root, 'main');
  const worktreeRoot = join(root, 'story-worktree');
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
    writeFileSync(join(mainRoot, '.gitignore'), '**/owner-lease.json\n', 'utf8');
    gitMain(['add', 'proof-or-stop.config.json', '.gitignore']);
    gitMain(['commit', '-m', 'init']);
    gitMain(['worktree', 'add', '-b', `story/${storyId}`, worktreeRoot]);

    const store = new StoryStore(worktreeRoot);
    satisfyDevMemoryFinishDecisionAndCommit(worktreeRoot, store, storyId, gitWorktree);
    const preEvidenceHead = gitWorktree(['rev-parse', 'HEAD']);
    const preEvidenceMaterialHash = currentMaterialHash(worktreeRoot, 'HEAD', worktreeRoot);
    assert.ok(preEvidenceMaterialHash, 'CLI worktree fixture must be able to compute a material hash');
    const doneStory = {
      ...story(storyId),
      phase: 'TEST',
      priority: 'low',
      currentReviewRound: '2026-07-04T10:00:00.000Z',
      worktree: {
        path: worktreeRoot,
        branch: `story/${storyId}`,
        createdAt: '2026-07-04T09:00:00.000Z',
      },
    };
    const closeoutChecklist = {
      items: [
        checklistItem('CHK-DONE-CLI-APPEND', 'done', [
          evidence('CHK-DONE-CLI-APPEND:happy:0', 'pass', {
            headHash: preEvidenceHead,
            materialHash: preEvidenceMaterialHash,
          }),
        ], intent('DONE CLI append evidence')),
      ],
    };
    const docsPromises = [];
    const realMachineTests = [
      {
        featureId: 'milestone-status-done-cli-append',
        transcript: 'Built CLI story_advance DONE fixture removed the story worktree and still printed milestone_status.',
      },
    ];
    const closingSelfCheck = {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'The runCli DONE fixture has enough signed delivery context for the orchestrator gate.',
    };
    const reviewRound = doneStory.currentReviewRound;

    store.writeStory(storyId, doneStory);
    store.writeChecklist(storyId, closeoutChecklist);
    store.writeMilestoneLedger(storyId, ledger([
      milestone({
        id: 'M-done-cli-append',
        sourceRequirementId: 'REQ-done-cli-append',
        claim: 'The built CLI appends milestone status after DONE worktree cleanup',
        doneMeans: 'story_advance DONE stdout includes milestone_status even after the story worktree is removed',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-DONE-CLI-APPEND'],
        verificationIntentRefs: ['CHK-DONE-CLI-APPEND:happy:0'],
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
    gitWorktree(['commit', '-m', 'ready for CLI DONE append']);
    assert.equal(gitWorktree(['status', '--porcelain']), '', 'CLI story worktree fixture must be clean before DONE');
    assert.equal(gitMain(['status', '--porcelain']), '', 'CLI main fixture must be clean before DONE');
    assert.equal(currentMaterialHash(worktreeRoot, 'HEAD', worktreeRoot), preEvidenceMaterialHash);

    // B-7c05: the post-mutation milestone suffix is BRIEF by default; this block
    // asserts the full table row, so restore it via the env hatch.
    const result = spawnSync(process.execPath, [
      cliPath,
      'story_advance',
      '--root',
      worktreeRoot,
      '--storyId',
      storyId,
      '--phase',
      'DONE',
    ], { cwd: worktreeRoot, encoding: 'utf8', env: { ...process.env, PROOF_OR_STOP_BRIEF_OUTPUT: '0' } });

    assert.equal(result.status, 0, `story_advance DONE should succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(
      !existsSync(worktreeRoot),
      `runCli story_advance DONE should remove the story worktree\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, new RegExp(`Story ${storyId} advanced to DONE`));
    assert.match(result.stdout, new RegExp(`Milestone Status - ${storyId}`));
    assert.match(result.stdout, /\| M-done-cli-append \| The built CLI appends milestone status after DONE worktree cleanup \|/);
    assert.doesNotMatch(result.stdout, /milestone ledger required/);
  } finally {
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

export async function case30() {
  const storyId = 'B-cli-ms';
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-milestone-status-'));
  try {
    const storyDir = join(root, '.proof-or-stop', 'story', 'actives', storyId);
    mkdirSync(storyDir, { recursive: true });
    writeJson(join(root, 'proof-or-stop.config.json'), {
      scanRoot: '.',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      flows: { defaults: {}, patterns: [] },
    });
    const cliStory = story(storyId);
    const cliChecklist = {
      items: [
        checklistItem('CHK-CLI', 'done', [evidence('CHK-CLI:happy:0')], intent('CLI-covered intent')),
      ],
    };
    const cliLedger = ledger([
      milestone({
        id: 'M-cli',
        sourceRequirementId: 'REQ-cli',
        claim: 'CLI report milestone',
        doneMeans: 'The built CLI renders milestone headings',
        requiredEvidence: [],
        checklistRefs: ['CHK-CLI'],
        verificationIntentRefs: ['CHK-CLI:happy:0'],
        status: 'covered',
      }),
    ], storyId);
    writeJson(join(storyDir, 'index.json'), cliStory);
    writeJson(join(storyDir, 'checklist.json'), cliChecklist);
    writeJson(join(storyDir, 'milestone-ledger.json'), cliLedger);

    // B-7c05: bare milestone_status is brief by default; assert the full grouped
    // table via --full.
    const stdout = execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      storyId,
      '--full',
    ], { cwd: root, encoding: 'utf8' });
    assert.match(stdout, /Milestone Status - B-cli-ms/);
    assert.match(stdout, /Completed/);
    assert.match(stdout, /Current/);
    assert.match(stdout, /Remaining/);
    assert.match(stdout, /\| M-cli \| CLI report milestone \|/);

    const missingCloseout = execFileSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      root,
      '--storyId',
      storyId,
    ], { cwd: root, encoding: 'utf8' });
    assertCloseoutTextContract(missingCloseout);
    assert.match(missingCloseout, /Snapshot: missing/);
    assert.match(missingCloseout, /No milestone-closeout\.json snapshot exists for B-cli-ms/);
    assert.match(missingCloseout, /Next action:/);

    const missingCloseoutJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      root,
      '--storyId',
      storyId,
      '--json',
    ], { cwd: root, encoding: 'utf8' }));
    assert.equal(missingCloseoutJson.schemaVersion, 'proof-or-stop.milestone_closeout_missing.v1');
    assert.equal(missingCloseoutJson.snapshotPresent, false);
    assert.match(missingCloseoutJson.diagnostic, /No milestone-closeout\.json snapshot exists/);

    const cliReport = buildMilestoneStatusReport({
      story: cliStory,
      checklist: cliChecklist,
      milestoneLedger: cliLedger,
    });
    const cliSnapshot = buildMilestoneCloseoutSnapshot({
      report: cliReport,
      bindings: { headHash: 'head-cli', materialHash: 'material-cli', storyFilesHash: 'story-cli' },
      generatedAt: '2026-07-04T14:00:00.000Z',
    });
    writeJson(join(storyDir, 'milestone-closeout.json'), cliSnapshot);

    const closeoutText = execFileSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      root,
      '--storyId',
      storyId,
    ], { cwd: root, encoding: 'utf8' });
    assertCloseoutTextContract(closeoutText);
    assert.match(closeoutText, /Generated: 2026-07-04T14:00:00\.000Z/);
    assert.match(closeoutText, /Bindings: headHash=head-cli materialHash=material-cli storyFilesHash=story-cli/);
    assert.match(closeoutText, /\| M-cli \| completed \(ledger=covered; checklist=complete; evidence=covered; requiredEvidence=covered\) \| CLI report milestone \|/);

    const closeoutJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      root,
      '--storyId',
      storyId,
      '--format=json',
    ], { cwd: root, encoding: 'utf8' }));
    assert.equal(closeoutJson.schemaVersion, 'proof-or-stop.milestone_closeout.v1');
    assert.equal(closeoutJson.sourceReport.digest, milestoneStatusReportDigest(cliReport));
    assert.equal(closeoutJson.rows[0].milestone, 'M-cli');

    const unknownFlag = spawnSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      storyId,
      '--format=json',
      '--surpriseFlag=true',
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(unknownFlag.status, 0, 'CLI parser must reject unknown milestone_status flags');
    const unknownFlagError = JSON.parse(unknownFlag.stdout);
    assert.deepEqual(Object.keys(unknownFlagError).sort(), ['command', 'issues', 'nextCommand', 'ok', 'reasonCode', 'recoverable']);
    assert.deepEqual(unknownFlagError, {
      ok: false, reasonCode: 'argument_validation_failed', recoverable: true,
      command: 'milestone_status', nextCommand: 'proof-or-stop milestone_status --help',
      issues: [{ path: [], code: 'unrecognized_keys', message: 'Unrecognized key: "surpriseFlag"' }],
    }, 'unknown flags must fail before story facts are printed');
    assert.equal(unknownFlag.stderr, '', 'JSON validation errors must remain machine-readable');

    const unknownCloseoutFlag = spawnSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      root,
      '--storyId',
      storyId,
      '--format=json',
      '--surpriseFlag=true',
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(unknownCloseoutFlag.status, 0, 'CLI parser must reject unknown milestone_closeout flags');
    const unknownCloseoutFlagError = JSON.parse(unknownCloseoutFlag.stdout);
    assert.deepEqual(Object.keys(unknownCloseoutFlagError).sort(), ['command', 'issues', 'nextCommand', 'ok', 'reasonCode', 'recoverable']);
    assert.deepEqual(unknownCloseoutFlagError, {
      ok: false, reasonCode: 'argument_validation_failed', recoverable: true,
      command: 'milestone_closeout', nextCommand: 'proof-or-stop milestone_closeout --help',
      issues: [{ path: [], code: 'unrecognized_keys', message: 'Unrecognized key: "surpriseFlag"' }],
    }, 'unknown closeout flags must fail before story facts are printed');
    assert.equal(unknownCloseoutFlag.stderr, '', 'JSON validation errors must remain machine-readable');

    {
      const activeStoryId = 'B-preflight';
      const activeRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-milestone-status-preflight-'));
      try {
        const activeStoryDir = join(activeRoot, '.proof-or-stop', 'story', 'actives', activeStoryId);
        mkdirSync(activeStoryDir, { recursive: true });
        writeJson(join(activeRoot, 'proof-or-stop.config.json'), {
          scanRoot: '.',
          testsDir: 'tests',
          fixturesDir: 'tests/fixtures',
          storyDir: '.proof-or-stop/story/actives',
          requirementsDir: 'docs/requirements',
          storyPrefix: 'B',
          flows: { defaults: {}, patterns: [] },
        });
        execFileSync('git', ['init', '-b', 'main'], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['config', 'user.name', 'Milestone Status Test'], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['config', 'user.email', 'milestone-status@example.com'], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['add', 'proof-or-stop.config.json'], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['checkout', '-b', `story/${activeStoryId}`], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('mkfifo', [join(activeStoryDir, 'index.json')], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });

        const rejectedBeforeActiveRead = spawnSync(process.execPath, [
          cliPath,
          'milestone_status',
          '--root',
          activeRoot,
          '--storyId',
          activeStoryId,
          '--surpriseFlag=true',
        ], { cwd: activeRoot, encoding: 'utf8', timeout: 2000 });
        assert.notEqual(rejectedBeforeActiveRead.error?.code, 'ETIMEDOUT', 'malformed milestone_status args must reject before active-story metadata reads');
        assert.notEqual(rejectedBeforeActiveRead.status, 0, 'malformed milestone_status args must be rejected');
        assert.match(rejectedBeforeActiveRead.stderr, /Argument validation failed[\s\S]*surpriseFlag/);

        const rejectedCloseoutBeforeActiveRead = spawnSync(process.execPath, [
          cliPath,
          'milestone_closeout',
          '--root',
          activeRoot,
          '--storyId',
          activeStoryId,
          '--surpriseFlag=true',
        ], { cwd: activeRoot, encoding: 'utf8', timeout: 2000 });
        assert.notEqual(rejectedCloseoutBeforeActiveRead.error?.code, 'ETIMEDOUT', 'malformed milestone_closeout args must reject before active-story metadata reads');
        assert.notEqual(rejectedCloseoutBeforeActiveRead.status, 0, 'malformed milestone_closeout args must be rejected');
        assert.match(rejectedCloseoutBeforeActiveRead.stderr, /Argument validation failed[\s\S]*surpriseFlag/);
      } finally {
        rmSync(activeRoot, { recursive: true, force: true });
      }
    }

    for (const flag of [
      'runCommands',
      'writeEvidence',
      'advancePhase',
      'launchReviewers',
      'write',
      'apply',
      'execute',
      'run',
      'launch',
      'capture',
      'refresh',
      'authorityDone',
      'productionDone',
    ]) {
      for (const command of ['milestone_status', 'milestone_closeout']) {
        const rejected = spawnSync(process.execPath, [
          cliPath,
          command,
          '--root',
          root,
          '--storyId',
          storyId,
          `--${flag}=true`,
        ], { cwd: root, encoding: 'utf8' });
        assert.notEqual(rejected.status, 0, `CLI parser must reject ${flag} for ${command}`);
        assert.match(rejected.stderr, new RegExp(`Argument validation failed[\\s\\S]*${flag}`));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function case31() {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-milestone-status-done-snapshot-'));
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  try {
    writeTestConfig(root);
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Milestone Status Test']);
    git(['config', 'user.email', 'milestone-status@example.com']);
    git(['add', 'proof-or-stop.config.json']);
    git(['commit', '-m', 'init']);

    const frozenBinding = {
      headHash: 'head-frozen',
      materialHash: 'material-frozen',
    };
    const completeChecklist = (itemId, intentText) => ({
      items: [
        checklistItem(itemId, 'done', [
          evidence(`${itemId}:happy:0`, 'pass', frozenBinding),
        ], intent(intentText)),
      ],
    });
    const staleChecklist = (itemId, intentText) => ({
      items: [
        checklistItem(itemId, 'done', [
          evidence(`${itemId}:happy:0`, 'pass', frozenBinding),
        ], intent(intentText)),
      ],
    });
    const doneMilestone = (id, itemId, claim) => milestone({
      id,
      sourceRequirementId: `REQ-${id}`,
      claim,
      doneMeans: 'DONE milestone_status uses the frozen closeout status report',
      requiredEvidence: ['logic_test'],
      checklistRefs: [itemId],
      verificationIntentRefs: [`${itemId}:happy:0`],
      status: 'done',
    });

    const doneStoryId = 'B-cli-done-snapshot-status';
    const doneStoryDir = join(root, '.proof-or-stop', 'story', 'actives', doneStoryId);
    const doneItemId = 'CHK-DONE-SNAPSHOT';
    const doneLedger = ledger([
      doneMilestone(
        'M-done-snapshot',
        doneItemId,
        'DONE milestone_status reports the frozen closeout row',
      ),
    ], doneStoryId);
    const frozenReport = buildMilestoneStatusReport({
      story: { ...story(doneStoryId), phase: 'TEST' },
      checklist: completeChecklist(doneItemId, 'frozen DONE closeout evidence'),
      milestoneLedger: doneLedger,
      currentEvidenceBinding: frozenBinding,
    });
    assert.deepEqual(frozenReport.groups, { completed: ['M-done-snapshot'], current: [], remaining: [] });
    const frozenSnapshot = buildMilestoneCloseoutSnapshot({
      report: frozenReport,
      bindings: frozenBinding,
      generatedAt: '2026-07-04T15:00:00.000Z',
    });
    mkdirSync(doneStoryDir, { recursive: true });
    writeJson(join(doneStoryDir, 'index.json'), { ...story(doneStoryId), phase: 'DONE' });
    writeJson(join(doneStoryDir, 'checklist.json'), staleChecklist(doneItemId, 'stale live evidence after cleanup'));
    writeJson(join(doneStoryDir, 'milestone-ledger.json'), doneLedger);
    writeJson(join(doneStoryDir, 'milestone-closeout.json'), frozenSnapshot);

    const liveStaleReport = buildMilestoneStatusReport({
      story: { ...story(doneStoryId), phase: 'DONE' },
      checklist: staleChecklist(doneItemId, 'stale live evidence after cleanup'),
      milestoneLedger: doneLedger,
      currentEvidenceBinding: {
        headHash: 'head-current',
        materialHash: 'material-current',
      },
    });
    assert.deepEqual(liveStaleReport.groups, { completed: [], current: ['M-done-snapshot'], remaining: [] });
    assert.match(liveStaleReport.milestones[0].statusDetail, /evidence=stale/);

    const activeStoryId = 'B-cli-active-live-status';
    const activeStoryDir = join(root, '.proof-or-stop', 'story', 'actives', activeStoryId);
    const activeItemId = 'CHK-ACTIVE-SNAPSHOT';
    const activeLedger = ledger([
      doneMilestone(
        'M-active-snapshot',
        activeItemId,
        'Active milestone_status ignores closeout snapshots',
      ),
    ], activeStoryId);
    const activeFrozenReport = buildMilestoneStatusReport({
      story: { ...story(activeStoryId), phase: 'TEST' },
      checklist: completeChecklist(activeItemId, 'active snapshot should be ignored'),
      milestoneLedger: activeLedger,
      currentEvidenceBinding: frozenBinding,
    });
    const activeSnapshot = buildMilestoneCloseoutSnapshot({
      report: activeFrozenReport,
      bindings: frozenBinding,
      generatedAt: '2026-07-04T15:05:00.000Z',
    });
    mkdirSync(activeStoryDir, { recursive: true });
    writeJson(join(activeStoryDir, 'index.json'), { ...story(activeStoryId), phase: 'DEV' });
    writeJson(join(activeStoryDir, 'checklist.json'), staleChecklist(activeItemId, 'stale active live evidence'));
    writeJson(join(activeStoryDir, 'milestone-ledger.json'), activeLedger);
    writeJson(join(activeStoryDir, 'milestone-closeout.json'), activeSnapshot);

    const missingCloseoutStoryId = 'B-cli-done-missing-closeout-status';
    const missingCloseoutStoryDir = join(root, '.proof-or-stop', 'story', 'actives', missingCloseoutStoryId);
    const missingItemId = 'CHK-MISSING-CLOSEOUT';
    const missingLedger = ledger([
      doneMilestone(
        'M-missing-closeout',
        missingItemId,
        'DONE milestone_status without closeout remains live and fail-closed',
      ),
    ], missingCloseoutStoryId);
    mkdirSync(missingCloseoutStoryDir, { recursive: true });
    writeJson(join(missingCloseoutStoryDir, 'index.json'), { ...story(missingCloseoutStoryId), phase: 'DONE' });
    writeJson(join(missingCloseoutStoryDir, 'checklist.json'), staleChecklist(missingItemId, 'stale missing-closeout live evidence'));
    writeJson(join(missingCloseoutStoryDir, 'milestone-ledger.json'), missingLedger);

    git(['add', '.']);
    git(['commit', '-m', 'milestone status snapshot fixtures']);

    // B-7c05: these three text invocations assert full-table rows, so pass --full
    // (bare milestone_status is brief by default).
    const doneText = execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      doneStoryId,
      '--full',
    ], { cwd: root, encoding: 'utf8' });
    assert.match(doneText, new RegExp(`Milestone Status - ${doneStoryId}`));
    assert.match(doneText, /Completed\n\| Milestone \| Purpose \| Status:/);
    assert.match(doneText, /\| M-done-snapshot \| DONE milestone_status reports the frozen closeout row \| ✅ Done \(ledger=done; checklist=complete; evidence=covered; requiredEvidence=covered\) \|/);
    assert.doesNotMatch(doneText, /🔴 Blocked/);
    assert.doesNotMatch(doneText, /stale-evidence/);
    assert.doesNotMatch(doneText, /evidence=stale/);

    const doneJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      doneStoryId,
      '--json',
    ], { cwd: root, encoding: 'utf8' }));
    assert.equal(doneJson.schemaVersion, 'proof-or-stop.milestone_status.v1');
    assert.equal(doneJson.phase, 'DONE');
    assert.deepEqual(doneJson.groups, { completed: ['M-done-snapshot'], current: [], remaining: [] });
    assert.equal(doneJson.milestones[0].status, 'completed');
    assert.equal(doneJson.milestones[0].ledgerStatus, 'done');
    assert.equal(doneJson.milestones[0].evidenceRefs[0].status, 'pass');

    const activeText = execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      activeStoryId,
      '--full',
    ], { cwd: root, encoding: 'utf8' });
    assert.match(activeText, /\| M-active-snapshot \| Active milestone_status ignores closeout snapshots \| 🔴 Blocked \(ledger=done; checklist=complete; evidence=stale; requiredEvidence=missing\) \|/);
    const activeJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      activeStoryId,
      '--json',
    ], { cwd: root, encoding: 'utf8' }));
    assert.deepEqual(activeJson.groups, { completed: [], current: ['M-active-snapshot'], remaining: [] });

    const missingCloseoutText = execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      missingCloseoutStoryId,
      '--full',
    ], { cwd: root, encoding: 'utf8' });
    assert.match(missingCloseoutText, /\| M-missing-closeout \| DONE milestone_status without closeout remains live and fail-closed \| 🔴 Blocked \(ledger=done; checklist=complete; evidence=stale; requiredEvidence=missing\) \|/);
    const missingCloseoutJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      missingCloseoutStoryId,
      '--json',
    ], { cwd: root, encoding: 'utf8' }));
    assert.deepEqual(missingCloseoutJson.groups, { completed: [], current: ['M-missing-closeout'], remaining: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
