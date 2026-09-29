import { assert, execFileSync, spawnSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, tmpdir, join, fileURLToPath, distRoot, cliPath, buildMilestoneCloseoutSnapshot, buildMilestoneStatusReport, buildMilestoneStatusReportFromCloseoutSnapshot, milestoneStatusReportDigest, renderMilestoneCloseoutSnapshot, renderMilestoneStatusReport, renderChecklistDerivedLedger, EMPTY_STORY_FILES_HASH, currentMaterialHash, signDeliveryCheck, evaluateDoneIntentEquivalence, StoryStore, captureMilestoneCloseoutSnapshotFromStore, createMilestoneStatusHandlers, createStoryAdvanceHandlers, createPlaybookRuntimeMemoryHandlers, satisfyDevMemoryFinishDecisionAndCommit, story, intent, checklistItem, evidence, ledger, writeTestConfig, validStoryBackground, runJsonCommand, runTextCommand, storyDirs, milestone, writeJson, assertTextContract, assertCloseoutTextContract, assertReportShape, assertRowShape, assertEvidenceRefShape } from './support.mjs';

export async function case14() {
  const cl = {
    items: [
      checklistItem('CHK-A', 'done', [], intent('owner intent', 'misplaced-intent')),
      checklistItem('CHK-B', 'done', [evidence('misplaced-intent')]),
      checklistItem('CHK-C', 'done', [evidence('duplicate-intent')], intent('first duplicate', 'duplicate-intent')),
      checklistItem('CHK-D', 'done', [evidence('duplicate-intent')], intent('second duplicate', 'duplicate-intent')),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-misplaced',
        sourceRequirementId: 'REQ-misplaced',
        claim: 'Misplaced evidence is not scoped evidence',
        doneMeans: 'Evidence must be on the owning checklist item',
        requiredEvidence: [],
        checklistRefs: ['CHK-A'],
        verificationIntentRefs: ['misplaced-intent'],
        status: 'done',
      }),
      milestone({
        id: 'M-duplicate',
        sourceRequirementId: 'REQ-duplicate',
        claim: 'Duplicate custom intent ids are ambiguous',
        doneMeans: 'Ambiguous intent ids must not complete a milestone',
        requiredEvidence: [],
        checklistRefs: ['CHK-C'],
        verificationIntentRefs: ['duplicate-intent'],
        status: 'done',
      }),
    ]),
  });

  assert.deepEqual(report.groups.completed, []);
  assert.deepEqual(report.groups.current, ['M-misplaced']);
  assert.deepEqual(report.groups.remaining, ['M-duplicate']);

  const misplaced = report.milestones.find((row) => row.id === 'M-misplaced');
  const duplicate = report.milestones.find((row) => row.id === 'M-duplicate');
  assert.ok(misplaced);
  assert.ok(duplicate);
  assert.equal(misplaced.evidenceRefs.length, 0, 'evidence on another checklist item must not be attached as scoped evidence');
  assert.match(misplaced.risks.join('\n'), /no evidence on owning checklist item CHK-A/);
  assert.equal(duplicate.evidenceRefs.length, 0, 'ambiguous duplicate intent ids must not pick an arbitrary evidence owner');
  assert.match(duplicate.risks.join('\n'), /ambiguous across 2 checklist items/);
  assert.equal(
    duplicate.subObjectives.find((sub) => sub.id === 'duplicate-intent')?.status,
    'ambiguous-intent',
  );
}

export async function case15() {
  const cl = {
    items: [
      checklistItem('CHK-REQ-LOGIC', 'done', [
        evidence('CHK-REQ-LOGIC:happy:0', 'pass', { kind: 'logic_test' }),
      ], intent('wrong kind is still scoped intent coverage')),
      checklistItem('CHK-REQ-BROWSER', 'done', [
        evidence('CHK-REQ-BROWSER:happy:0', 'pass', { kind: 'browser_test' }),
      ], intent('required browser evidence is present')),
      checklistItem('CHK-REQ-CUSTOM', 'done', [
        evidence('CHK-REQ-CUSTOM:happy:0', 'pass', { kind: 'logic_test' }),
      ], intent('unsupported required evidence label must be fixed')),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-required-missing',
        sourceRequirementId: 'REQ-required-missing',
        claim: 'Required evidence kind must be present',
        doneMeans: 'A browser_test requirement cannot be completed by logic_test evidence',
        requiredEvidence: ['browser_test'],
        checklistRefs: ['CHK-REQ-LOGIC'],
        verificationIntentRefs: ['CHK-REQ-LOGIC:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-required-covered',
        sourceRequirementId: 'REQ-required-covered',
        claim: 'Required evidence kind can complete',
        doneMeans: 'A fresh browser_test evidence item satisfies the required kind',
        requiredEvidence: ['browser_test'],
        checklistRefs: ['CHK-REQ-BROWSER'],
        verificationIntentRefs: ['CHK-REQ-BROWSER:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-required-custom-label',
        sourceRequirementId: 'REQ-required-custom-label',
        claim: 'Custom requiredEvidence labels remain mapping hints',
        doneMeans: 'Historical non-kind labels do not block when mapped verification refs are covered',
        requiredEvidence: ['cli_smoke'],
        checklistRefs: ['CHK-REQ-CUSTOM'],
        verificationIntentRefs: ['CHK-REQ-CUSTOM:happy:0'],
        status: 'done',
      }),
    ]),
  });

  assert.deepEqual(report.groups.completed, ['M-required-covered', 'M-required-custom-label']);
  assert.deepEqual(report.groups.current, ['M-required-missing']);
  const missing = report.milestones.find((row) => row.id === 'M-required-missing');
  assert.ok(missing);
  assert.equal(missing.subObjectives.find((sub) => sub.id === 'CHK-REQ-LOGIC:happy:0')?.status, 'covered');
  assert.equal(missing.subObjectives.find((sub) => sub.id === 'browser_test')?.status, 'missing-evidence-kind');
  assert.match(missing.statusDetail, /requiredEvidence=missing/);
  assert.match(missing.risks.join('\n'), /Required evidence kind "browser_test" has no fresh covering evidence/);

  const covered = report.milestones.find((row) => row.id === 'M-required-covered');
  assert.ok(covered);
  assert.equal(covered.subObjectives.find((sub) => sub.id === 'browser_test')?.status, 'covered');
  assert.match(covered.statusDetail, /requiredEvidence=covered/);

  const custom = report.milestones.find((row) => row.id === 'M-required-custom-label');
  assert.ok(custom);
  assert.equal(custom.subObjectives.find((sub) => sub.id === 'cli_smoke')?.status, 'mapped');
  assert.match(custom.statusDetail, /requiredEvidence=covered/);
}

export async function case16() {
  const cl = {
    items: [
      checklistItem('CHK-WAIVE-PERM', 'done', [
        evidence('CHK-WAIVE-PERM:happy:0', 'pass', { kind: 'waiver', waiverType: 'permanent' }),
      ], intent('permanent waiver may cover')),
      checklistItem('CHK-WAIVE-DEFER', 'done', [
        evidence('CHK-WAIVE-DEFER:happy:0', 'pass', { kind: 'waiver', waiverType: 'deferred_gate_evidence' }),
      ], intent('deferred waiver must not cover')),
      checklistItem('CHK-WAIVE-FAIL', 'done', [
        evidence('CHK-WAIVE-FAIL:happy:0', 'fail', { kind: 'waiver', waiverType: 'permanent' }),
      ], intent('failed waiver must not cover')),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-waiver-permanent',
        sourceRequirementId: 'REQ-waiver-permanent',
        claim: 'Permanent waiver can cover',
        doneMeans: 'Permanent non-failing waiver is explicit coverage',
        requiredEvidence: [],
        checklistRefs: ['CHK-WAIVE-PERM'],
        verificationIntentRefs: ['CHK-WAIVE-PERM:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-waiver-deferred',
        sourceRequirementId: 'REQ-waiver-deferred',
        claim: 'Deferred waiver cannot cover',
        doneMeans: 'Deferred gate evidence must be replaced',
        requiredEvidence: [],
        checklistRefs: ['CHK-WAIVE-DEFER'],
        verificationIntentRefs: ['CHK-WAIVE-DEFER:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-waiver-failed',
        sourceRequirementId: 'REQ-waiver-failed',
        claim: 'Failed waiver cannot cover',
        doneMeans: 'Failed waiver evidence must not complete',
        requiredEvidence: [],
        checklistRefs: ['CHK-WAIVE-FAIL'],
        verificationIntentRefs: ['CHK-WAIVE-FAIL:happy:0'],
        status: 'done',
      }),
    ]),
  });

  assert.deepEqual(report.groups.completed, ['M-waiver-permanent']);
  assert.deepEqual(report.groups.current, ['M-waiver-deferred']);
  assert.deepEqual(report.groups.remaining, ['M-waiver-failed']);
  const deferred = report.milestones.find((row) => row.id === 'M-waiver-deferred');
  const failed = report.milestones.find((row) => row.id === 'M-waiver-failed');
  assert.ok(deferred);
  assert.ok(failed);
  assert.equal(deferred.evidenceRefs[0].status, 'waived');
  assert.equal(deferred.subObjectives.find((sub) => sub.id === 'CHK-WAIVE-DEFER:happy:0')?.status, 'not-passing');
  assert.match(deferred.risks.join('\n'), /no passing evidence or permanent non-failing waiver/);
  assert.equal(failed.evidenceRefs[0].status, 'fail');
  assert.equal(failed.subObjectives.find((sub) => sub.id === 'CHK-WAIVE-FAIL:happy:0')?.status, 'not-passing');
  assert.match(failed.statusDetail, /evidence=not-passing/);
}

export async function case27() {
  // B-f7b3 CHK-004: a CONFIRMED milestone ledger that is empty OR whose rows are
  // all not_applicable (without a valid decision) must NOT vacuously satisfy the
  // DONE milestone requirement. Assert directly against the pure
  // evaluateDoneIntentEquivalence gate (imported from dist/core/proofstory.js),
  // isolating the coverage semantics from the CLI collision dance.
  const structuralStory = (storyId) => ({
    ...story(storyId),
    phase: 'TEST',
    priority: 'medium',
    // Structural multi-deliverable signal ("all milestones") keeps hasMilestonePath
    // true even when the ledger is empty, so the empty-ledger guard is exercised
    // rather than the story silently dropping onto the lightweight path.
    description: 'Deliver all milestones for the accepted intent.',
  });
  const doneEquivalenceInput = (storyId, checklist, milestoneLedger, overrides = {}) => ({
    story: structuralStory(storyId),
    checklist,
    originalIntentSnapshot: null,
    milestoneLedger,
    slicePlan: null,
    parentLedgerRollup: null,
    proofStoryContract: null,
    intentCollision: null,
    scopeContract: null,
    scopeShrinkageDecision: null,
    redEvidence: null,
    spikeEvidence: null,
    summary: null,
    ...overrides,
  });
  const notApplicableDecision = {
    reason: 'This milestone is out of scope for the accepted intent.',
    decidedBy: 'milestone-status-test',
    decidedAt: '2026-07-06T00:00:00.000Z',
  };

  // Negative control 1: empty confirmed ledger must fail (not vacuously pass).
  const emptyLedger = ledger([], 'B-empty-confirmed-ledger');
  const emptyReport = evaluateDoneIntentEquivalence(
    doneEquivalenceInput('B-empty-confirmed-ledger', { items: [] }, emptyLedger),
    'enforce',
  );
  assert.equal(emptyReport.equivalenceMode, 'strict_milestone', 'a structural-milestone story stays on the strict milestone path');
  assert.equal(emptyReport.status, 'fail', 'an empty confirmed ledger must not vacuously pass DONE equivalence');
  assert.equal(emptyReport.blocking, true, 'the empty-ledger gap blocks under enforce');
  const emptyGap = emptyReport.gaps.find((g) => g.code === 'empty_confirmed_milestone_ledger');
  assert.ok(emptyGap, 'empty confirmed ledger yields an empty_confirmed_milestone_ledger gap');
  assert.equal(emptyGap.severity, 'fail', 'the empty-ledger gap is severity fail');
  assert.match(emptyGap.artifact ?? '', /milestone-ledger\.json/, 'the empty-ledger gap points at milestone-ledger.json');

  // Negative control 2: all-not_applicable confirmed ledger WITHOUT a valid decision
  // must fail — the uncovered loop `continue`s every row, so only the CHK-007
  // not_applicable_missing_decision guard stands between the gate and a vacuous pass.
  const naLedger = ledger([
    milestone({ id: 'M-na-1', checklistRefs: [], verificationIntentRefs: [], status: 'not_applicable' }),
    milestone({ id: 'M-na-2', checklistRefs: [], verificationIntentRefs: [], status: 'not_applicable' }),
  ], 'B-not-applicable-only');
  const naReport = evaluateDoneIntentEquivalence(
    doneEquivalenceInput('B-not-applicable-only', { items: [] }, naLedger),
    'enforce',
  );
  assert.equal(naReport.status, 'fail', 'an all-not_applicable ledger without decisions must not vacuously pass');
  assert.equal(naReport.blocking, true, 'the all-not_applicable ledger blocks under enforce');
  const naGap = naReport.gaps.find((g) => g.code === 'not_applicable_missing_decision');
  assert.ok(naGap, 'all-not_applicable ledger yields a not_applicable_missing_decision gap');
  assert.match(naGap.message, /M-na-1/, 'the gap names every unjustified not_applicable row');
  assert.match(naGap.message, /M-na-2/, 'the gap names every unjustified not_applicable row');

  // Positive control: the guard must NOT over-fire. A confirmed ledger with an
  // applicable, fully-covered milestone (plus a justified not_applicable row) passes.
  const coveredChecklist = {
    items: [
      checklistItem('CHK-COVERED', 'done', [evidence('CHK-COVERED:happy:0')], intent('covered applicable milestone')),
    ],
  };
  const coveredLedger = ledger([
    milestone({
      id: 'M-covered',
      checklistRefs: ['CHK-COVERED'],
      verificationIntentRefs: ['CHK-COVERED:happy:0'],
      status: 'done',
    }),
    milestone({ id: 'M-na-justified', checklistRefs: [], verificationIntentRefs: [], status: 'not_applicable', notApplicableDecision }),
  ], 'B-covered-plus-na');
  const coveredReport = evaluateDoneIntentEquivalence(
    doneEquivalenceInput('B-covered-plus-na', coveredChecklist, coveredLedger),
    'enforce',
  );
  assert.equal(coveredReport.status, 'pass', 'a genuinely-covered ledger with one applicable row still passes');
  assert.deepEqual(coveredReport.uncoveredRequiredMilestoneIds, [], 'the covered applicable row is not reported uncovered');
  assert.equal(
    coveredReport.gaps.some((g) => g.code === 'empty_confirmed_milestone_ledger' || g.code === 'not_applicable_missing_decision'),
    false,
    'the negative-control guards do not over-fire on a genuinely-satisfied ledger',
  );
}

export async function case28() {
  // B-3b05 CHK-001 (reworked for findings F-001/F-003/F-004/F-005): the
  // uncovered_required_milestones gap message carries a per-row diagnosis
  // (real row status + per-row checklist-lag framing) and an evidence-first
  // remediation hint (message-layer ONLY — gap code, severity, pass/fail
  // decision, and gap count are byte-identical to the pre-hint behavior for
  // identical inputs). The PRIMARY remedy names verification_evidence_add,
  // which is phase-legal everywhere the gap surfaces (F-005); the SECONDARY
  // remedy names milestone_ledger_set only for genuine ledger lag, with both
  // the FULL-REPLACE and PLAN-phase-only caveats spelled out (F-001).
  // A lagging row's framing is computed per row, never suppressed by a
  // non-lagging sibling (F-004), and the message never hardcodes
  // "remain planned" for a row whose persisted status differs (F-003).
  const structuralStory = (storyId) => ({
    ...story(storyId),
    phase: 'TEST',
    priority: 'medium',
    description: 'Deliver all milestones for the accepted intent.',
  });
  const doneEquivalenceInput = (storyId, checklist, milestoneLedger, overrides = {}) => ({
    story: structuralStory(storyId),
    checklist,
    originalIntentSnapshot: null,
    milestoneLedger,
    slicePlan: null,
    parentLedgerRollup: null,
    proofStoryContract: null,
    intentCollision: null,
    scopeContract: null,
    scopeShrinkageDecision: null,
    redEvidence: null,
    spikeEvidence: null,
    summary: null,
    ...overrides,
  });
  const notApplicableDecision = {
    reason: 'This milestone is out of scope for the accepted intent.',
    decidedBy: 'milestone-status-test',
    decidedAt: '2026-07-06T00:00:00.000Z',
  };

  // Scenario 1 (desync, the B-f458 case): checklist items done, ledger rows
  // still planned with NO covering verification evidence. Hint + desync prefix.
  const desyncChecklist = {
    items: [
      checklistItem('CHK-DS-1', 'done', [], intent('desync row one')),
      checklistItem('CHK-DS-2', 'done', [], intent('desync row two')),
    ],
  };
  const desyncLedger = ledger([
    milestone({ id: 'M-ds-1', checklistRefs: ['CHK-DS-1'], verificationIntentRefs: ['CHK-DS-1:happy:0'], status: 'planned' }),
    milestone({ id: 'M-ds-2', checklistRefs: ['CHK-DS-2'], verificationIntentRefs: ['CHK-DS-2:happy:0'], status: 'planned' }),
  ], 'B-hint-desync');
  const desyncInput = doneEquivalenceInput('B-hint-desync', desyncChecklist, desyncLedger);
  const desyncReport = evaluateDoneIntentEquivalence(desyncInput, 'enforce');
  const desyncGap = desyncReport.gaps.find((g) => g.code === 'uncovered_required_milestones');
  assert.ok(desyncGap, 'the desync fixture still yields an uncovered_required_milestones gap');
  // Per-row diagnosis (F-003/F-004): each row prints its REAL status and its
  // own checklist-lag framing.
  assert.match(
    desyncGap.message,
    /M-ds-1 \[status=planned; checklistRefs all done — row lags delivered checklist coverage; missing passing evidence for CHK-DS-1:happy:0\]/,
    'row M-ds-1 gets a per-row diagnosis with real status, lag framing, and its uncovered refs',
  );
  assert.match(
    desyncGap.message,
    /M-ds-2 \[status=planned; checklistRefs all done — row lags delivered checklist coverage; missing passing evidence for CHK-DS-2:happy:0\]/,
    'row M-ds-2 gets its own per-row diagnosis',
  );
  assert.doesNotMatch(desyncGap.message, /remain planned/, 'the hardcoded "remain planned" claim is gone (F-003)');
  // Primary remedy (F-005): evidence-first, names the phase-legal command with
  // the story id and the actual uncovered refs, and points at --help.
  assert.match(desyncGap.message, /verification_evidence_add/, 'the primary remedy names verification_evidence_add');
  assert.match(desyncGap.message, /verification_evidence_batch_add/, 'the primary remedy offers the batch variant');
  assert.match(desyncGap.message, /proof-or-stop verification_evidence_add --help/, 'the primary remedy points at the command help');
  assert.match(desyncGap.message, /allowed in every phase/, 'the primary remedy states it is phase-legal everywhere the gap surfaces');
  assert.match(desyncGap.message, /CHK-DS-1:happy:0, CHK-DS-2:happy:0/, 'the primary remedy names the actual uncovered intent refs');
  assert.match(desyncGap.message, /on story B-hint-desync/, 'the primary remedy names THIS story');
  assert.ok(
    desyncGap.message.indexOf('verification_evidence_add') < desyncGap.message.indexOf('milestone_ledger_set'),
    'the phase-legal evidence command LEADS; the PLAN-only ledger command follows (F-005)',
  );
  // Secondary remedy (F-001): genuine ledger lag exists, so milestone_ledger_set
  // is named — with BOTH caveats and a --help pointer, and with NO fake-JSON
  // partial-update template.
  assert.match(desyncGap.message, /milestone_ledger_set/, 'genuine ledger lag still surfaces the ledger repair command');
  assert.match(desyncGap.message, /proof-or-stop milestone_ledger_set --help/, 'the secondary remedy points at the command help');
  assert.match(desyncGap.message, /FULL-REPLACES the ledger \(re-submit the complete milestone list/, 'the full-replace caveat is explicit (F-001)');
  assert.match(desyncGap.message, /PLAN-phase-only \(return the story to PLAN first\)/, 'the PLAN-phase-only caveat is explicit (F-005)');
  assert.doesNotMatch(desyncGap.message, /"milestones":\[\.\.\./, 'no invalid-JSON partial-update template survives (F-001)');
  assert.match(desyncGap.message, /M-ds-1, M-ds-2/, 'the gap still names the affected milestone ids');

  // Scenario 2 (non-lagging uncovered): the referenced checklist item is NOT
  // done, so checklist coverage does not exist — evidence-first remedy present,
  // lag framing absent, and NO milestone_ledger_set pointer (nothing about this
  // row is a ledger problem; refs are bound, evidence is simply missing).
  const plainChecklist = {
    items: [
      checklistItem('CHK-PLAIN', 'in_progress', [], intent('plain uncovered row')),
    ],
  };
  const plainLedger = ledger([
    milestone({ id: 'M-plain', checklistRefs: ['CHK-PLAIN'], verificationIntentRefs: ['CHK-PLAIN:happy:0'], status: 'planned' }),
  ], 'B-hint-plain');
  const plainReport = evaluateDoneIntentEquivalence(
    doneEquivalenceInput('B-hint-plain', plainChecklist, plainLedger),
    'enforce',
  );
  const plainGap = plainReport.gaps.find((g) => g.code === 'uncovered_required_milestones');
  assert.ok(plainGap, 'the non-lagging fixture still yields an uncovered_required_milestones gap');
  assert.match(
    plainGap.message,
    /M-plain \[status=planned; checklistRefs not all done; missing passing evidence for CHK-PLAIN:happy:0\]/,
    'a non-lagging uncovered row gets an accurate per-row diagnosis without the lag framing',
  );
  assert.match(plainGap.message, /verification_evidence_add/, 'a plain uncovered milestone still gets the evidence-first remedy');
  assert.doesNotMatch(plainGap.message, /row lags delivered checklist coverage/, 'a non-lagging uncovered milestone must NOT claim ledger lag');
  assert.doesNotMatch(plainGap.message, /milestone_ledger_set/, 'no ledger-repair pointer when no row lags and all rows have bound refs');

  // Scenario 2b (F-003 regression): a row already persisted as status=done but
  // WITHOUT covering evidence — the message must reflect the real status, not
  // claim the row is planned; the lag framing applies (checklistRefs all done)
  // and the evidence-first remedy still leads.
  const doneStatusChecklist = {
    items: [
      checklistItem('CHK-DONE-NOEV', 'done', [], intent('done-status row without evidence')),
    ],
  };
  const doneStatusLedger = ledger([
    milestone({ id: 'M-done-noev', checklistRefs: ['CHK-DONE-NOEV'], verificationIntentRefs: ['CHK-DONE-NOEV:happy:0'], status: 'done' }),
  ], 'B-hint-done-status');
  const doneStatusReport = evaluateDoneIntentEquivalence(
    doneEquivalenceInput('B-hint-done-status', doneStatusChecklist, doneStatusLedger),
    'enforce',
  );
  const doneStatusGap = doneStatusReport.gaps.find((g) => g.code === 'uncovered_required_milestones');
  assert.ok(doneStatusGap, 'a done-status row without evidence is still uncovered (status plays no role in coverage)');
  assert.match(
    doneStatusGap.message,
    /M-done-noev \[status=done; checklistRefs all done — row lags delivered checklist coverage; missing passing evidence for CHK-DONE-NOEV:happy:0\]/,
    'the diagnosis prints the REAL persisted status (done), not a hardcoded planned claim',
  );
  assert.doesNotMatch(doneStatusGap.message, /remain planned/, 'a done-status row is never described as planned (F-003)');
  assert.match(doneStatusGap.message, /verification_evidence_add/, 'the evidence-first remedy leads for the done-status row too');

  // Scenario 2c (F-004 regression): a MIXED uncovered set — one genuinely
  // lagging row plus one non-lagging row in the SAME gap. The lag framing must
  // appear for the lagging row only; the non-lagging sibling must not suppress
  // it (per-row computation, no .every() across rows).
  const mixedChecklist = {
    items: [
      checklistItem('CHK-MIX-DONE', 'done', [], intent('mixed lagging row')),
      checklistItem('CHK-MIX-WIP', 'in_progress', [], intent('mixed fresh row')),
    ],
  };
  const mixedLedger = ledger([
    milestone({ id: 'M-mix-lag', checklistRefs: ['CHK-MIX-DONE'], verificationIntentRefs: ['CHK-MIX-DONE:happy:0'], status: 'planned' }),
    milestone({ id: 'M-mix-fresh', checklistRefs: ['CHK-MIX-WIP'], verificationIntentRefs: ['CHK-MIX-WIP:happy:0'], status: 'planned' }),
  ], 'B-hint-mixed');
  const mixedReport = evaluateDoneIntentEquivalence(
    doneEquivalenceInput('B-hint-mixed', mixedChecklist, mixedLedger),
    'enforce',
  );
  const mixedGap = mixedReport.gaps.find((g) => g.code === 'uncovered_required_milestones');
  assert.ok(mixedGap, 'the mixed fixture yields a single uncovered_required_milestones gap');
  const mixLagDiag = mixedGap.message.match(/M-mix-lag \[[^\]]*\]/)?.[0];
  const mixFreshDiag = mixedGap.message.match(/M-mix-fresh \[[^\]]*\]/)?.[0];
  assert.ok(mixLagDiag, 'the lagging row has a per-row diagnosis');
  assert.ok(mixFreshDiag, 'the non-lagging row has a per-row diagnosis');
  assert.match(mixLagDiag, /row lags delivered checklist coverage/, 'the genuinely-lagging row keeps its lag framing in a mixed set (F-004)');
  assert.doesNotMatch(mixFreshDiag, /row lags delivered checklist coverage/, 'the non-lagging row does NOT get the lag framing');
  assert.match(mixedGap.message, /milestone_ledger_set/, 'the secondary ledger remedy appears because at least one row genuinely lags');
  assert.match(mixedGap.message, /CHK-MIX-DONE:happy:0, CHK-MIX-WIP:happy:0/, 'the primary remedy aggregates uncovered refs across all rows');

  // F-005 mechanical phase-legality check: the PRIMARY remedy command printed
  // by the hint must not be phase-gated out of the phases where this gap
  // surfaces (REVIEW/TEST/DONE via story_advance DONE / done_prepare /
  // milestone_status). Assert against the exported command-policy map, not
  // prose. milestone_ledger_set is asserted PLAN-only — which is exactly why
  // the hint text demotes it to a secondary remedy with a return-to-PLAN caveat.
  const { COMMAND_POLICIES } = await import(join(distRoot, 'core/command-policy.js'));
  const gapSurfacePhases = ['REVIEW', 'TEST', 'DONE'];
  const phasesCover = (allowedPhases) =>
    allowedPhases === 'all' || gapSurfacePhases.every((phase) => (allowedPhases ?? []).includes(phase));
  assert.ok(
    phasesCover(COMMAND_POLICIES.verification_evidence_add.allowedPhases),
    'verification_evidence_add (the printed primary remedy) is allowed in REVIEW/TEST/DONE per command-policy',
  );
  assert.ok(
    phasesCover(COMMAND_POLICIES.verification_evidence_batch_add.allowedPhases),
    'verification_evidence_batch_add (the printed batch variant) is allowed in REVIEW/TEST/DONE per command-policy',
  );
  assert.equal(
    phasesCover(COMMAND_POLICIES.milestone_ledger_set.allowedPhases),
    false,
    'milestone_ledger_set stays PLAN-gated — confirming it must not be the primary printed remedy (F-005)',
  );

  // Scenario 3 (quiet rows): a justified not_applicable row plus an
  // accepted-shrinkage row produce NO hint noise — no uncovered gap exists, and
  // no gap message anywhere in the report mentions the repair command.
  const quietLedger = ledger([
    milestone({ id: 'M-na-quiet', checklistRefs: [], verificationIntentRefs: [], status: 'not_applicable', notApplicableDecision }),
    milestone({ id: 'M-shrunk', checklistRefs: ['CHK-SHRUNK'], verificationIntentRefs: ['CHK-SHRUNK:happy:0'], status: 'planned' }),
    milestone({
      id: 'M-quiet-covered',
      checklistRefs: ['CHK-QUIET'],
      verificationIntentRefs: ['CHK-QUIET:happy:0'],
      status: 'done',
    }),
  ], 'B-hint-quiet');
  const quietChecklist = {
    items: [
      checklistItem('CHK-QUIET', 'done', [evidence('CHK-QUIET:happy:0')], intent('quiet covered milestone')),
    ],
  };
  const quietReport = evaluateDoneIntentEquivalence(
    doneEquivalenceInput('B-hint-quiet', quietChecklist, quietLedger, {
      scopeShrinkageDecision: {
        decision: 'confirmed',
        userConfirmed: true,
        removedMilestoneIds: ['M-shrunk'],
      },
    }),
    'enforce',
  );
  assert.equal(
    quietReport.gaps.some((g) => g.code === 'uncovered_required_milestones'),
    false,
    'not_applicable + accepted-shrinkage rows do not land in the uncovered set',
  );
  assert.equal(
    quietReport.gaps.some((g) => /milestone_ledger_set/.test(g.message)),
    false,
    'no gap message mentions the ledger repair command when nothing is uncovered (no hint noise)',
  );
  assert.equal(
    quietReport.gaps.some((g) => /verification_evidence_add/.test(g.message)),
    false,
    'no gap message mentions the evidence remedy when nothing is uncovered (no hint noise)',
  );

  // Adversarial (message-layer only): for identical inputs the gap ids,
  // severities, messages, pass/fail decision, and gap count are byte-identical
  // across runs; and the desync vs non-desync fixtures differ ONLY in message
  // text — same gap code set, same severities, same gap count, same decision.
  const desyncReportRerun = evaluateDoneIntentEquivalence(desyncInput, 'enforce');
  assert.deepEqual(
    desyncReportRerun.gaps,
    desyncReport.gaps,
    'identical inputs produce byte-identical gap sets (ids, severities, messages) across runs',
  );
  assert.deepEqual(
    desyncReport.gaps.map((g) => [g.code, g.severity]),
    [['uncovered_required_milestones', 'fail']],
    'the desync fixture yields exactly the pre-hint gap id/severity set',
  );
  assert.deepEqual(
    plainReport.gaps.map((g) => [g.code, g.severity]),
    [['uncovered_required_milestones', 'fail']],
    'the non-desync fixture yields the same gap id/severity set — only the message differs',
  );
  assert.deepEqual(desyncReport.uncoveredRequiredMilestoneIds, ['M-ds-1', 'M-ds-2'], 'uncovered id reporting is unchanged');
  assert.equal(desyncReport.status, 'fail', 'pass/fail decision is unchanged by the hint');
  assert.equal(desyncReport.blocking, true, 'enforce-mode blocking is unchanged by the hint');
  assert.equal(plainReport.status, 'fail', 'pass/fail decision is unchanged for the non-desync fixture');
}
