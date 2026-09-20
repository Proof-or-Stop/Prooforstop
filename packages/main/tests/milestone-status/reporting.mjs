import { assert, execFileSync, spawnSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, tmpdir, join, fileURLToPath, distRoot, cliPath, buildMilestoneCloseoutSnapshot, buildMilestoneStatusReport, buildMilestoneStatusReportFromCloseoutSnapshot, milestoneStatusReportDigest, renderMilestoneCloseoutSnapshot, renderMilestoneStatusReport, renderChecklistDerivedLedger, EMPTY_STORY_FILES_HASH, currentMaterialHash, signDeliveryCheck, evaluateDoneIntentEquivalence, StoryStore, captureMilestoneCloseoutSnapshotFromStore, createMilestoneStatusHandlers, createStoryAdvanceHandlers, createPlaybookRuntimeMemoryHandlers, satisfyDevMemoryFinishDecisionAndCommit, story, intent, checklistItem, evidence, ledger, writeTestConfig, validStoryBackground, runJsonCommand, runTextCommand, storyDirs, milestone, writeJson, assertTextContract, assertCloseoutTextContract, assertReportShape, assertRowShape, assertEvidenceRefShape } from './support.mjs';

export async function case01() {
  const markerStoryId = 'B-marker-icons';
  const markerChecklist = {
    items: [
      checklistItem('CHK-MARKER-DONE', 'done', [evidence('CHK-MARKER-DONE:happy:0')], intent('marker completed intent')),
      checklistItem('CHK-MARKER-REVIEW', 'done', [evidence('CHK-MARKER-REVIEW:happy:0')], intent('marker review intent')),
      checklistItem('CHK-MARKER-PLANNED-REVIEW', 'done', [evidence('CHK-MARKER-PLANNED-REVIEW:happy:0')], intent('marker planned review intent')),
      checklistItem('CHK-MARKER-CURRENT', 'in_progress', [], intent('marker current intent')),
      checklistItem('CHK-MARKER-REMAINING', 'pending', [], intent('marker remaining intent')),
      checklistItem('CHK-MARKER-FAILED', 'done', [evidence('CHK-MARKER-FAILED:happy:0', 'fail')], intent('marker failed intent')),
    ],
  };
  const markerLedger = ledger([
    milestone({
      id: 'M-marker-done',
      sourceRequirementId: 'REQ-marker-done',
      claim: 'Marker completed milestone',
      doneMeans: 'Completed rows show the success marker',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-DONE'],
      verificationIntentRefs: ['CHK-MARKER-DONE:happy:0'],
      status: 'done',
    }),
    milestone({
      id: 'M-marker-review',
      sourceRequirementId: 'REQ-marker-review',
      claim: 'Marker pending review milestone',
      doneMeans: 'Covered rows awaiting final ledger acceptance show pending review',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-REVIEW'],
      verificationIntentRefs: ['CHK-MARKER-REVIEW:happy:0'],
      status: 'covered',
    }),
    milestone({
      id: 'M-marker-planned-review',
      sourceRequirementId: 'REQ-marker-planned-review',
      claim: 'Marker planned pending review milestone',
      doneMeans: 'Implementation-complete planned rows awaiting ledger acceptance show pending review',
      requiredEvidence: ['logic_test'],
      checklistRefs: ['CHK-MARKER-PLANNED-REVIEW'],
      verificationIntentRefs: ['CHK-MARKER-PLANNED-REVIEW:happy:0'],
      status: 'planned',
    }),
    milestone({
      id: 'M-marker-current',
      sourceRequirementId: 'REQ-marker-current',
      claim: 'Marker current milestone',
      doneMeans: 'The first incomplete row shows the incomplete marker',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-DONE', 'CHK-MARKER-CURRENT', 'CHK-MARKER-REMAINING'],
      verificationIntentRefs: ['CHK-MARKER-DONE:happy:0'],
      status: 'planned',
    }),
    milestone({
      id: 'M-marker-remaining',
      sourceRequirementId: 'REQ-marker-remaining',
      claim: 'Marker remaining milestone',
      doneMeans: 'Later incomplete rows show the incomplete marker',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-REMAINING'],
      verificationIntentRefs: ['CHK-MARKER-REMAINING:happy:0'],
      status: 'planned',
    }),
    milestone({
      id: 'M-marker-blocked',
      sourceRequirementId: 'REQ-marker-blocked',
      claim: 'Marker blocked milestone',
      doneMeans: 'Missing refs show the blocked marker',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-MISSING'],
      verificationIntentRefs: ['CHK-MARKER-MISSING:happy:0'],
      status: 'planned',
    }),
    milestone({
      id: 'M-marker-failed',
      sourceRequirementId: 'REQ-marker-failed',
      claim: 'Marker failed milestone',
      doneMeans: 'Failing evidence shows the failed marker',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-FAILED'],
      verificationIntentRefs: ['CHK-MARKER-FAILED:happy:0'],
      status: 'done',
    }),
  ], markerStoryId);
  const markerReport = buildMilestoneStatusReport({
    story: story(markerStoryId),
    checklist: markerChecklist,
    milestoneLedger: markerLedger,
  });
  const markerText = renderMilestoneStatusReport(markerReport);
  assert.match(markerText, /\| M-marker-done \| Marker completed milestone \| ✅ Done \(ledger=done;/);
  assert.match(markerText, /\| M-marker-review \| Marker pending review milestone \| 🟡 Pending Review \(ledger=covered;/);
  assert.match(markerText, /\| M-marker-planned-review \| Marker planned pending review milestone \| 🟡 Pending Review \(ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered\)/);
  assert.match(markerText, /\| M-marker-current \| Marker current milestone \| ⏳ In Progress \(ledger=planned;/);
  assert.match(markerText, /\| M-marker-remaining \| Marker remaining milestone \| ⬜ Not Started \(ledger=planned;/);
  assert.match(markerText, /\| M-marker-blocked \| Marker blocked milestone \| 🔴 Blocked \(ledger=planned;/);
  assert.match(markerText, /\| M-marker-failed \| Marker failed milestone \| ❌ Failed \(ledger=done;/);
  assert.match(markerText, /✅ Done CHK-MARKER-DONE \[done\] CHK-MARKER-DONE title/);
  assert.match(markerText, /⏳ In Progress CHK-MARKER-CURRENT \[in_progress\] CHK-MARKER-CURRENT title/);
  assert.match(markerText, /⬜ Not Started CHK-MARKER-REMAINING \[pending\] CHK-MARKER-REMAINING title/);
  assert.match(markerText, /🔴 Blocked CHK-MARKER-MISSING \[missing\] CHK-MARKER-MISSING/);
  assert.match(markerText, /✅ Done CHK-MARKER-DONE:happy:0 \[covered\]/);
  assert.match(markerText, /✅ Done CHK-MARKER-DONE:happy:0 \[pass\/logic_test\]/);
  assert.match(markerText, /❌ Failed CHK-MARKER-FAILED:happy:0 \[fail\/logic_test\]/);

  const missingText = renderMilestoneStatusReport(buildMilestoneStatusReport({
    story: story('B-marker-missing-ledger'),
    checklist: { items: [] },
    milestoneLedger: null,
  }));
  assert.match(missingText, /\| ledger \| milestone ledger required \| 🔴 Blocked \(ledger=missing\) \|/);
  assert.match(missingText, /\| none \| none \| none \| none \| none \| none \| none \|/);
  assert.doesNotMatch(missingText, /\| none \| none \| [✅⏳🟡⬜🔴❌] none \|/, 'placeholder none rows stay unmarked');

  // Checklist-derived ledger (no milestone ledger set): groups by checklist status.
  const derivedText = renderChecklistDerivedLedger('B-derived', {
    items: [
      { id: 'CHK-A', title: 'alpha', status: 'done', startTime: null, endTime: null },
      { id: 'CHK-B', title: 'beta', status: 'in_progress', startTime: null, endTime: null },
      { id: 'CHK-C', title: 'gamma', status: 'pending', startTime: null, endTime: null },
    ],
  }, 'DEV');
  assert.match(derivedText, /^Checklist-derived ledger \(no milestone ledger set\) - B-derived/);
  assert.doesNotMatch(derivedText, /Milestone Status -/, 'derived ledger must not fabricate a milestone table');
  assert.match(derivedText, /Progress: 1 done \/ 1 in progress \/ 1 not started \(3 total\)/);
  assert.match(derivedText, /✅ CHK-A — alpha/);
  assert.match(derivedText, /⏳ CHK-B — beta/);
  assert.match(derivedText, /⬜ CHK-C — gamma/);
  // Empty checklist (e.g. IDEA) still renders a stub, never throws.
  const emptyDerived = renderChecklistDerivedLedger('B-empty', { items: [] }, 'IDEA');
  assert.match(emptyDerived, /Progress: 0 done \/ 0 in progress \/ 0 not started \(0 total\)/);
  assert.match(emptyDerived, /\(no checklist items\)/);

  const cliMarkerStoryId = 'B-cli-marker-icons';
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-milestone-status-icons-'));
  try {
    const storyDir = join(root, '.proof-or-stop', 'story', 'actives', cliMarkerStoryId);
    mkdirSync(storyDir, { recursive: true });
    writeTestConfig(root);
    // This CLI presentation fixture adds checklist scope, so keep it in PLAN.
    writeJson(join(storyDir, 'index.json'), { ...story(cliMarkerStoryId), phase: 'PLAN' });
    writeJson(join(storyDir, 'checklist.json'), markerChecklist);
    const milestoneLedgerPath = join(storyDir, 'milestone-ledger.json');
    writeJson(milestoneLedgerPath, ledger(markerLedger.milestones, cliMarkerStoryId));

    // B-7c05: bare milestone_status is BRIEF by default; this block asserts the
    // full 7-column table markers, so request the full rendering explicitly.
    const cliText = execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      cliMarkerStoryId,
      '--full',
    ], { cwd: root, encoding: 'utf8' });
    assert.match(cliText, /\| M-marker-done \| Marker completed milestone \| ✅ Done \(ledger=done;/);
    assert.match(cliText, /\| M-marker-review \| Marker pending review milestone \| 🟡 Pending Review \(ledger=covered;/);
    assert.match(cliText, /\| M-marker-planned-review \| Marker planned pending review milestone \| 🟡 Pending Review \(ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered\)/);
    assert.match(cliText, /\| M-marker-current \| Marker current milestone \| ⏳ In Progress \(ledger=planned;/);
    assert.match(cliText, /\| M-marker-remaining \| Marker remaining milestone \| ⬜ Not Started \(ledger=planned;/);
    assert.match(cliText, /\| M-marker-blocked \| Marker blocked milestone \| 🔴 Blocked \(ledger=planned;/);
    assert.match(cliText, /\| M-marker-failed \| Marker failed milestone \| ❌ Failed \(ledger=done;/);
    assert.match(cliText, /✅ Done CHK-MARKER-DONE \[done\] CHK-MARKER-DONE title/);
    assert.match(cliText, /⏳ In Progress CHK-MARKER-CURRENT \[in_progress\] CHK-MARKER-CURRENT title/);
    assert.match(cliText, /⬜ Not Started CHK-MARKER-REMAINING \[pending\] CHK-MARKER-REMAINING title/);
    assert.match(cliText, /🔴 Blocked CHK-MARKER-MISSING \[missing\] CHK-MARKER-MISSING/);
    assert.match(cliText, /❌ Failed CHK-MARKER-FAILED:happy:0 \[fail\/logic_test\]/);

    // B-7c05: the post-mutation milestone suffix is BRIEF by default; per-call
    // flags do not flow through checklist_update's schema, so restore the full
    // table via the PROOF_OR_STOP_BRIEF_OUTPUT=0 env hatch for these table assertions.
    const autoAppendText = execFileSync(process.execPath, [
      cliPath,
      'checklist_update',
      '--root',
      root,
      '--storyId',
      cliMarkerStoryId,
      '--itemId',
      'CHK-MARKER-CURRENT',
      '--status',
      'pending',
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, PROOF_OR_STOP_BRIEF_OUTPUT: '0' } });
    assert.match(autoAppendText, /Milestone Status - B-cli-marker-icons/);
    assert.match(autoAppendText, /\| M-marker-done \| Marker completed milestone \| ✅ Done \(ledger=done;/);
    assert.match(autoAppendText, /\| M-marker-review \| Marker pending review milestone \| 🟡 Pending Review \(ledger=covered;/);
    assert.match(autoAppendText, /\| M-marker-planned-review \| Marker planned pending review milestone \| 🟡 Pending Review \(ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered\)/);
    assert.match(autoAppendText, /\| M-marker-current \| Marker current milestone \| ⏳ In Progress \(ledger=planned;/);
    assert.match(autoAppendText, /\| M-marker-remaining \| Marker remaining milestone \| ⬜ Not Started \(ledger=planned;/);
    assert.match(autoAppendText, /\| M-marker-blocked \| Marker blocked milestone \| 🔴 Blocked \(ledger=planned;/);
    assert.match(autoAppendText, /\| M-marker-failed \| Marker failed milestone \| ❌ Failed \(ledger=done;/);
    assert.match(autoAppendText, /✅ Done CHK-MARKER-DONE \[done\] CHK-MARKER-DONE title/);
    assert.match(autoAppendText, /⬜ Not Started CHK-MARKER-CURRENT \[pending\] CHK-MARKER-CURRENT title/);
    assert.match(autoAppendText, /⬜ Not Started CHK-MARKER-REMAINING \[pending\] CHK-MARKER-REMAINING title/);
    assert.match(autoAppendText, /❌ Failed CHK-MARKER-FAILED:happy:0 \[fail\/logic_test\]/);

    const ledgerBeforeChecklistAdd = readFileSync(milestoneLedgerPath, 'utf8');
    const checklistAddText = execFileSync(process.execPath, [
      cliPath,
      'checklist_add',
      '--root',
      root,
      '--storyId',
      cliMarkerStoryId,
      '--title',
      'Exercise ledger-backed checklist add UX',
      '--reason',
      'Exercise the PLAN-time ledger advisory without changing milestone coverage.',
      '--context',
      'Adding a checklist row to a ledger-backed story should show status and advisory text without changing milestone-ledger.json.',
    ], { cwd: root, encoding: 'utf8' });
    assert.match(checklistAddText, /Checklist item CHK-001 added to B-cli-marker-icons/);
    assert.ok(
      checklistAddText.includes('Advisory: milestone ledger exists for B-cli-marker-icons; if this new checklist item (CHK-001) changes milestone coverage, update/sync the ledger with `proof-or-stop milestone_ledger_add` or an explicit ledger update.'),
      'ledger-backed checklist_add output includes the milestone ledger advisory',
    );
    assert.match(checklistAddText, /Milestone Status - B-cli-marker-icons/);
    assert.equal(
      readFileSync(milestoneLedgerPath, 'utf8'),
      ledgerBeforeChecklistAdd,
      'checklist_add must not mutate milestone-ledger.json',
    );

    const noLedgerStoryId = 'B-cli-marker-no-ledger';
    const noLedgerStoryDir = join(root, '.proof-or-stop', 'story', 'actives', noLedgerStoryId);
    mkdirSync(noLedgerStoryDir, { recursive: true });
    writeJson(join(noLedgerStoryDir, 'index.json'), story(noLedgerStoryId));
    writeJson(join(noLedgerStoryDir, 'checklist.json'), {
      items: [
        checklistItem('CHK-MARKER-NO-LEDGER', 'pending'),
      ],
    });
    const noLedgerStdout = execFileSync(process.execPath, [
      cliPath,
      'checklist_update',
      '--root',
      root,
      '--storyId',
      noLedgerStoryId,
      '--itemId',
      'CHK-MARKER-NO-LEDGER',
      '--status',
      'in_progress',
    ], { cwd: root, encoding: 'utf8' });
    assert.match(noLedgerStdout, /Checklist CHK-MARKER-NO-LEDGER:/);
    // A missing-ledger story must NOT fabricate a milestone status table...
    assert.equal(
      noLedgerStdout.includes(`Milestone Status - ${noLedgerStoryId}`),
      false,
      'missing-ledger story mutations must not fabricate a milestone status table',
    );
    // ...but the mutation MUST still always show a status view: the
    // checklist-derived ledger, distinctly labelled and grouping items by status.
    assert.match(
      noLedgerStdout,
      new RegExp(`Checklist-derived ledger \\(no milestone ledger set\\) - ${noLedgerStoryId}`),
      'missing-ledger story mutations must still show a checklist-derived ledger',
    );
    assert.match(noLedgerStdout, /⏳ CHK-MARKER-NO-LEDGER —/);

    // Round-1 review (Codex host-2 + Claude quality F-001): a CORRUPT artifact must
    // surface a visible failure, never be masked as an empty story. A corrupt
    // milestone-ledger.json makes readMilestoneLedger throw; the error must reach the
    // visible ⚠ block, and the exit code must stay 0 (the mutation already committed).
    const corruptStoryId = 'B-cli-marker-corrupt';
    const corruptStoryDir = join(root, '.proof-or-stop', 'story', 'actives', corruptStoryId);
    mkdirSync(corruptStoryDir, { recursive: true });
    writeJson(join(corruptStoryDir, 'index.json'), story(corruptStoryId));
    writeJson(join(corruptStoryDir, 'checklist.json'), {
      items: [checklistItem('CHK-CORRUPT', 'pending')],
    });
    writeFileSync(join(corruptStoryDir, 'milestone-ledger.json'), 'THIS IS NOT JSON {{{');
    const corruptStdout = execFileSync(process.execPath, [
      cliPath,
      'checklist_update',
      '--root',
      root,
      '--storyId',
      corruptStoryId,
      '--itemId',
      'CHK-CORRUPT',
      '--status',
      'in_progress',
    ], { cwd: root, encoding: 'utf8' });
    assert.match(corruptStdout, /Checklist CHK-CORRUPT:/, 'the mutation itself still succeeds');
    assert.match(
      corruptStdout,
      new RegExp(`⚠ Milestone Ledger: render FAILED for ${corruptStoryId}`),
      'a corrupt milestone ledger must surface a visible render-failure block, not be swallowed',
    );
    assert.doesNotMatch(
      corruptStdout,
      new RegExp(`Checklist-derived ledger \\(no milestone ledger set\\) - ${corruptStoryId}`),
      'corruption must not be masked as a clean no-ledger checklist-derived render',
    );

    const jsonStoryId = 'B-cli-marker-json';
    const jsonStoryDir = join(root, '.proof-or-stop', 'story', 'actives', jsonStoryId);
    mkdirSync(jsonStoryDir, { recursive: true });
    writeJson(join(jsonStoryDir, 'index.json'), story(jsonStoryId));
    const jsonStdout = execFileSync(process.execPath, [
      cliPath,
      'milestone_ledger_add',
      '--root',
      root,
      '--storyId',
      jsonStoryId,
      '--id',
      'M-json',
      '--sourceRequirementId',
      'REQ-json',
      '--claim',
      'JSON stdout remains parseable',
      '--doneMeans',
      'The command writes only JSON when --json is set',
      '--status',
      'planned',
      '--json',
    ], { cwd: root, encoding: 'utf8' });
    const jsonLedger = JSON.parse(jsonStdout);
    assert.equal(jsonLedger.storyId, jsonStoryId);
    assert.equal(jsonLedger.milestones.at(-1).id, 'M-json');
    assert.equal(
      jsonStdout.includes(`Milestone Status - ${jsonStoryId}`),
      false,
      'machine JSON stdout must not be contaminated with a milestone table',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function case03() {
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: { items: [] },
    milestoneLedger: null,
  });

  assert.equal(report.schemaVersion, 'proof-or-stop.milestone_status.v1');
  assertReportShape(report);
  assert.equal(report.storyId, 'B-7ba7');
  assert.equal(report.phase, 'DEV');
  assert.equal(report.ledger.present, false);
  assert.deepEqual(report.mode, {
    readOnly: true,
    runCommands: false,
    writeEvidence: false,
    advancePhase: false,
    launchReviewers: false,
  });
  assert.deepEqual(report.groups, { completed: [], current: [], remaining: [] });
  assert.match(report.risks.join('\n'), /Missing milestone ledger/);
  assert.match(report.nextActions.join('\n'), /proof-or-stop milestone_ledger_set --storyId=B-7ba7/);

  const text = renderMilestoneStatusReport(report);
  assertTextContract(text);
  assert.match(text, /Ledger: missing/);
  assert.doesNotMatch(text, /all ledger rows are completed/i, 'missing ledger must not pretend progress is complete');
}

export async function case04() {
  const cl = {
    items: [
      checklistItem('CHK-001', 'done', [evidence('CHK-001:happy:0')], intent('completed intent')),
      checklistItem('CHK-002', 'done', [evidence('CHK-002:happy:0', 'fail')], intent('failing intent')),
      checklistItem('CHK-003', 'done'),
      checklistItem('CHK-004', 'done'),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M1',
        sourceRequirementId: 'REQ-1',
        claim: 'Completed with scoped verification evidence',
        doneMeans: 'Checklist done and verification evidence passes',
        checklistRefs: ['CHK-001'],
        verificationIntentRefs: ['CHK-001:happy:0'],
        status: 'covered',
      }),
      milestone({
        id: 'M2',
        sourceRequirementId: 'REQ-2',
        claim: 'Ledger done but verification failed',
        doneMeans: 'Failing verification must not complete the milestone',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-002'],
        verificationIntentRefs: ['CHK-002:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M3',
        sourceRequirementId: 'REQ-3',
        claim: 'Empty verification refs do not count',
        doneMeans: 'Normal milestones need mapped verification refs',
        requiredEvidence: [],
        checklistRefs: ['CHK-003'],
        verificationIntentRefs: [],
        status: 'done',
      }),
      milestone({
        id: 'M4',
        sourceRequirementId: 'REQ-4',
        claim: 'Not applicable milestone',
        doneMeans: 'Explicitly not applicable',
        requiredEvidence: [],
        checklistRefs: [],
        verificationIntentRefs: [],
        status: 'not_applicable',
      }),
    ]),
  });

  assert.equal(report.schemaVersion, 'proof-or-stop.milestone_status.v1');
  assertReportShape(report);
  assert.deepEqual(report.groups.completed, ['M1', 'M4']);
  assert.deepEqual(report.groups.current, ['M2']);
  assert.deepEqual(report.groups.remaining, ['M3']);

  const m1 = report.milestones.find((row) => row.id === 'M1');
  const m2 = report.milestones.find((row) => row.id === 'M2');
  const m3 = report.milestones.find((row) => row.id === 'M3');
  assert.ok(m1);
  assert.ok(m2);
  assert.ok(m3);
  assertRowShape(m1);
  assertRowShape(m2);
  assertRowShape(m3);
  assert.deepEqual(m1.requiredEvidence, [], 'missing requiredEvidence field falls back to an empty array');
  assert.equal(m1.subObjectives.some((sub) => sub.kind === 'requiredEvidence'), false);
  assert.equal(m1.subObjectives[0].kind, 'checklist');
  assert.equal(m1.subObjectives[1].kind, 'verificationIntent');
  assert.equal(m1.evidenceRefs[0].intentRef, 'CHK-001:happy:0');
  assert.equal(m1.evidenceRefs[0].status, 'pass');
  assertEvidenceRefShape(m1.evidenceRefs[0]);

  assert.equal(m2.status, 'current');
  assert.equal(m2.ledgerStatus, 'done');
  assert.equal(m2.evidenceRefs[0].status, 'fail');
  assert.match(m2.statusDetail, /evidence=not-passing/);
  assert.match(m2.risks.join('\n'), /no passing evidence or permanent non-failing waiver on owning checklist item CHK-002/);
  assert.match(m2.risks.join('\n'), /Required evidence kind "logic_test" has no fresh covering evidence/);
  assert.match(m2.nextAction, /Re-run or replace verificationEvidence/);
  assert.deepEqual(
    m2.subObjectives.filter((sub) => sub.kind === 'requiredEvidence').map((sub) => [sub.id, sub.status]),
    [['logic_test', 'missing-evidence-kind']],
  );

  assert.equal(m3.status, 'remaining');
  assert.match(m3.risks.join('\n'), /no verificationIntentRefs mapped/);

  const text = renderMilestoneStatusReport(report);
  assertTextContract(text);
  const completedSection = text.slice(text.indexOf('Completed'), text.indexOf('\nCurrent'));
  const currentSection = text.slice(text.indexOf('Current'), text.indexOf('\nRemaining'));
  const remainingSection = text.slice(text.indexOf('Remaining'));
  assert.match(completedSection, /\| M1 \| Completed with scoped verification evidence \|/);
  assert.match(completedSection, /\| M4 \| Not applicable milestone \|/);
  assert.match(currentSection, /\| M2 \| Ledger done but verification failed \|/);
  assert.doesNotMatch(currentSection, /\| M3 \|/);
  assert.match(remainingSection, /\| M3 \| Empty verification refs do not count \|/);
  assert.match(text, /CHK-001:happy:0 \[pass\/logic_test\]/);

  assert.throws(
    () => buildMilestoneCloseoutSnapshot({ report }),
    /incomplete milestone rows: M2=current, M3=remaining/,
    'closeout snapshots must reject incomplete live milestone reports',
  );
}

export async function case25() {
  // The pure builder buildMilestoneCloseoutSnapshot STAYS strict: it still throws
  // on an incomplete report. Only the DONE-time capture wrapper is non-blocking.
  const storyId = 'B-builder-incomplete-strict';
  const strictReport = buildMilestoneStatusReport({
    story: story(storyId),
    checklist: { items: [checklistItem('CHK-INCOMPLETE', 'done', [], intent('missing evidence'))] },
    milestoneLedger: ledger([
      milestone({
        id: 'M-incomplete',
        sourceRequirementId: 'REQ-incomplete',
        claim: 'Incomplete rows block the pure builder',
        doneMeans: 'Missing evidence cannot be frozen as success',
        requiredEvidence: [],
        checklistRefs: ['CHK-INCOMPLETE'],
        verificationIntentRefs: ['CHK-INCOMPLETE:happy:0'],
        status: 'done',
      }),
    ], storyId),
  });
  assert.throws(
    () => buildMilestoneCloseoutSnapshot({ report: strictReport }),
    /incomplete milestone rows: M-incomplete=current/,
    'the pure closeout builder must stay strict and reject an incomplete report',
  );
}

export async function case26() {
  // B-f7b3 CHK-005: the pure builder buildMilestoneCloseoutSnapshot must reject a
  // report whose ONLY defect is STALE milestone evidence. The CHK-010 blocks above
  // cover an incomplete report caused by MISSING evidence; this block isolates the
  // stale-ONLY case (evidence is present and passing, but its binding no longer
  // matches the current head/material/story-files binding). The DONE-time capture
  // wrapper degrades such a report to a non-throwing skip, but the pure builder
  // must stay strict and never freeze stale passing evidence as historical success.
  const staleOnlyBinding = {
    headHash: 'head-current',
    materialHash: 'material-current',
    storyFilesHash: 'story-current',
  };
  const staleOnlyReport = buildMilestoneStatusReport({
    story: story('B-builder-stale-only-strict'),
    checklist: {
      items: [
        checklistItem('CHK-STALE-ONLY', 'done', [
          evidence('CHK-STALE-ONLY:happy:0', 'pass', {
            headHash: 'head-old',
            materialHash: 'material-old',
            storyFilesHash: 'story-old',
          }),
        ], intent('stale-only report is otherwise complete')),
      ],
    },
    milestoneLedger: ledger([
      milestone({
        id: 'M-stale-only',
        sourceRequirementId: 'REQ-stale-only',
        claim: 'Stale-only reports must not be frozen as success',
        doneMeans: 'Passing but stale evidence is the report\'s ONLY defect',
        requiredEvidence: [],
        checklistRefs: ['CHK-STALE-ONLY'],
        verificationIntentRefs: ['CHK-STALE-ONLY:happy:0'],
        status: 'done',
      }),
    ], 'B-builder-stale-only-strict'),
    currentEvidenceBinding: staleOnlyBinding,
  });
  // Precondition: the ONLY reason this row is not completed is stale evidence.
  assert.deepEqual(staleOnlyReport.groups.completed, [], 'stale-only report has no completed rows');
  assert.deepEqual(staleOnlyReport.groups.current, ['M-stale-only'], 'the stale row is the sole defect (demoted to current)');
  const staleOnlyRow = staleOnlyReport.milestones.find((row) => row.id === 'M-stale-only');
  assert.ok(staleOnlyRow);
  assert.match(staleOnlyRow.statusDetail, /evidence=stale/, 'the sole defect is evidence=stale, not missing/failed');
  assert.throws(
    () => buildMilestoneCloseoutSnapshot({ report: staleOnlyReport }),
    /incomplete milestone rows: M-stale-only=current/,
    'the pure closeout builder must reject a report whose only defect is stale milestone evidence',
  );

  // The DONE-time capture wrapper must DEGRADE the same stale-only report to a
  // non-throwing skip and write nothing (the pure builder stays strict; only the
  // wrapper is non-blocking so evaluateDoneIntentEquivalence remains the one gate).
  const staleOnlyWrites = [];
  let staleOnlyCaptureResult;
  assert.doesNotThrow(() => {
    staleOnlyCaptureResult = captureMilestoneCloseoutSnapshotFromStore({
      readMilestoneLedger() {
        return ledger([
          milestone({
            id: 'M-stale-only',
            sourceRequirementId: 'REQ-stale-only',
            claim: 'Stale-only reports must not be frozen as success',
            doneMeans: 'Passing but stale evidence is the report\'s ONLY defect',
            requiredEvidence: [],
            checklistRefs: ['CHK-STALE-ONLY'],
            verificationIntentRefs: ['CHK-STALE-ONLY:happy:0'],
            status: 'done',
          }),
        ], 'B-capture-stale-only');
      },
      readStory() {
        return story('B-capture-stale-only');
      },
      readChecklist() {
        return {
          items: [
            checklistItem('CHK-STALE-ONLY', 'done', [
              evidence('CHK-STALE-ONLY:happy:0', 'pass', {
                headHash: 'head-old',
                materialHash: 'material-old',
                storyFilesHash: 'story-old',
              }),
            ], intent('stale-only report is otherwise complete')),
          ],
        };
      },
      readSummary() {
        return null;
      },
      writeMilestoneCloseout() {
        staleOnlyWrites.push('write');
      },
    }, 'B-capture-stale-only', { currentEvidenceBinding: staleOnlyBinding });
  }, 'DONE-time capture must not throw on a stale-only report');
  assert.equal(staleOnlyCaptureResult.status, 'skipped', 'stale-only capture must degrade to a skipped result');
  assert.equal(staleOnlyCaptureResult.reason, 'closeout_snapshot_unbuildable', 'stale-only capture reports closeout_snapshot_unbuildable');
  assert.match(staleOnlyCaptureResult.message, /incomplete milestone rows: M-stale-only=current/, 'skip message carries the stale-only builder rejection reason');
  assert.deepEqual(staleOnlyWrites, [], 'stale-only capture must not write a closeout');
}
