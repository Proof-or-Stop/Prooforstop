import { assert, execFileSync, spawnSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, tmpdir, join, fileURLToPath, distRoot, cliPath, buildMilestoneCloseoutSnapshot, buildMilestoneStatusReport, buildMilestoneStatusReportFromCloseoutSnapshot, milestoneStatusReportDigest, renderMilestoneCloseoutSnapshot, renderMilestoneStatusReport, renderChecklistDerivedLedger, EMPTY_STORY_FILES_HASH, currentMaterialHash, signDeliveryCheck, evaluateDoneIntentEquivalence, StoryStore, captureMilestoneCloseoutSnapshotFromStore, createMilestoneStatusHandlers, createStoryAdvanceHandlers, createPlaybookRuntimeMemoryHandlers, satisfyDevMemoryFinishDecisionAndCommit, story, intent, checklistItem, evidence, ledger, writeTestConfig, validStoryBackground, runJsonCommand, runTextCommand, storyDirs, milestone, writeJson, assertTextContract, assertCloseoutTextContract, assertReportShape, assertRowShape, assertEvidenceRefShape } from './support.mjs';

export async function case06() {
  const missingReport = buildMilestoneStatusReport({
    story: story('B-closeout-missing-ledger'),
    checklist: { items: [] },
    milestoneLedger: null,
  });
  assert.throws(
    () => buildMilestoneCloseoutSnapshot({ report: missingReport }),
    /missing milestone ledger.*cannot fabricate success/s,
  );

  const emptyReport = buildMilestoneStatusReport({
    story: story('B-closeout-empty'),
    checklist: { items: [] },
    milestoneLedger: ledger([], 'B-closeout-empty'),
  });
  assert.throws(
    () => buildMilestoneCloseoutSnapshot({ report: emptyReport }),
    /has no rows/,
  );

  const riskyChecklist = {
    items: [
      checklistItem('CHK-RISKY', 'done', [evidence('CHK-RISKY:happy:0')], intent('covered but candidate ledger')),
    ],
  };
  const candidateLedger = ledger([
    milestone({
      id: 'M-risky',
      sourceRequirementId: 'REQ-risky',
      claim: 'Candidate ledgers are risky',
      doneMeans: 'Confirmed ledgers are required',
      requiredEvidence: [],
      checklistRefs: ['CHK-RISKY'],
      verificationIntentRefs: ['CHK-RISKY:happy:0'],
      status: 'done',
    }),
  ], 'B-closeout-risky');
  candidateLedger.state = 'candidate';
  const riskyReport = buildMilestoneStatusReport({
    story: story('B-closeout-risky'),
    checklist: riskyChecklist,
    milestoneLedger: candidateLedger,
  });
  assert.deepEqual(riskyReport.groups.completed, ['M-risky']);
  assert.match(riskyReport.risks.join('\n'), /candidate/);
  assert.throws(
    () => buildMilestoneCloseoutSnapshot({ report: riskyReport }),
    /has risks.*candidate/s,
  );
}

export async function case07() {
  const currentEvidenceBinding = {
    headHash: 'head-current',
    materialHash: 'material-current',
    storyFilesHash: 'story-current',
  };
  const cl = {
    items: [
      checklistItem('CHK-STALE', 'done', [
        evidence('CHK-STALE:happy:0', 'pass', {
          headHash: 'head-old',
          materialHash: 'material-old',
          storyFilesHash: 'story-old',
        }),
      ], intent('fresh evidence required')),
    ],
  };
  const staleLedger = ledger([
    milestone({
      id: 'M-stale',
      sourceRequirementId: 'REQ-stale',
      claim: 'Stale passing evidence must not complete',
      doneMeans: 'Evidence must pass and match the current binding',
      requiredEvidence: [],
      checklistRefs: ['CHK-STALE'],
      verificationIntentRefs: ['CHK-STALE:happy:0'],
      status: 'done',
    }),
  ]);

  const legacyReport = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: staleLedger,
  });
  assert.deepEqual(legacyReport.groups.completed, ['M-stale'], 'without a current binding, legacy pass evidence remains covering');

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: staleLedger,
    currentEvidenceBinding,
  });
  assert.deepEqual(report.groups.completed, []);
  assert.deepEqual(report.groups.current, ['M-stale']);
  assert.deepEqual(report.groups.remaining, []);

  const row = report.milestones.find((candidate) => candidate.id === 'M-stale');
  assert.ok(row);
  assert.equal(row.status, 'current');
  assert.match(row.statusDetail, /evidence=stale/);
  assert.equal(row.subObjectives.find((sub) => sub.id === 'CHK-STALE:happy:0')?.status, 'stale-evidence');
  assert.match(row.risks.join('\n'), /stale passing or permanent waiver evidence/);
  assert.doesNotMatch(row.risks.join('\n'), /stale headHash/);
  assert.match(row.risks.join('\n'), /stale storyFilesHash/);
  assert.doesNotMatch(row.risks.join('\n'), /stale materialHash/);
  assert.match(row.nextAction, /current evidence binding/);

  const text = renderMilestoneStatusReport(report);
  const currentSection = text.slice(text.indexOf('Current'), text.indexOf('\nRemaining'));
  assert.match(currentSection, /\| M-stale \| Stale passing evidence must not complete \|/);
  assert.match(currentSection, /stale-evidence/);
}

export async function case08() {
  const currentEvidenceBinding = {
    headHash: 'head-current',
    materialHash: 'material-current',
    storyFilesHash: 'story-current',
  };
  const cl = {
    items: [
      checklistItem('CHK-HEAD-DRIFT', 'done', [
        evidence('CHK-HEAD-DRIFT:happy:0', 'pass', {
          headHash: 'head-before-metadata-commit',
          materialHash: 'material-current',
          storyFilesHash: 'story-current',
        }),
      ], intent('head-only metadata drift is not stale')),
    ],
  };

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-head-only',
        sourceRequirementId: 'REQ-head-only',
        claim: 'Head-only metadata drift does not block completion',
        doneMeans: 'Evidence with current material and story file hashes remains covering',
        requiredEvidence: [],
        checklistRefs: ['CHK-HEAD-DRIFT'],
        verificationIntentRefs: ['CHK-HEAD-DRIFT:happy:0'],
        status: 'done',
      }),
    ]),
    currentEvidenceBinding,
  });

  assert.deepEqual(report.groups.completed, ['M-head-only']);
  assert.deepEqual(report.groups.current, []);
  const row = report.milestones.find((candidate) => candidate.id === 'M-head-only');
  assert.ok(row);
  assert.equal(row.status, 'completed');
  assert.match(row.statusDetail, /evidence=covered/);
  assert.equal(row.subObjectives.find((sub) => sub.id === 'CHK-HEAD-DRIFT:happy:0')?.status, 'covered');
  assert.doesNotMatch(row.risks.join('\n'), /headHash/);
}

export async function case09() {
  const currentEvidenceBinding = {
    headHash: 'head-current',
    materialHash: 'material-after-metadata-commit',
    storyFilesHash: 'story-current',
  };
  const cl = {
    items: [
      checklistItem('CHK-STORY-FRESH-MATERIAL-DRIFT', 'done', [
        evidence('CHK-STORY-FRESH-MATERIAL-DRIFT:happy:0', 'pass', {
          headHash: 'head-before-metadata-commit',
          materialHash: 'material-before-metadata-commit',
          storyFilesHash: 'story-current',
        }),
      ], intent('story files freshness accepts material-only drift')),
    ],
  };

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-story-fresh-material-drift',
        sourceRequirementId: 'REQ-story-fresh-material-drift',
        claim: 'Material-only drift with matching story files does not block status convergence',
        doneMeans: 'Comparable matching storyFilesHash is blocking-fresh even when materialHash changed',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-STORY-FRESH-MATERIAL-DRIFT'],
        verificationIntentRefs: ['CHK-STORY-FRESH-MATERIAL-DRIFT:happy:0'],
        status: 'done',
      }),
    ]),
    currentEvidenceBinding,
  });

  assert.deepEqual(report.groups.completed, ['M-story-fresh-material-drift']);
  assert.deepEqual(report.groups.current, []);
  assert.deepEqual(report.groups.remaining, []);
  assert.deepEqual(report.risks, []);
  assert.doesNotMatch(report.risks.join('\n'), /stale materialHash/);
  assert.doesNotMatch(report.risks.join('\n'), /stale storyFilesHash/);

  const row = report.milestones.find((candidate) => candidate.id === 'M-story-fresh-material-drift');
  assert.ok(row);
  assert.equal(row.status, 'completed');
  assert.match(row.statusDetail, /evidence=covered/);
  assert.match(row.statusDetail, /requiredEvidence=covered/);
  assert.equal(row.subObjectives.find((sub) => sub.id === 'CHK-STORY-FRESH-MATERIAL-DRIFT:happy:0')?.status, 'covered');
  assert.equal(row.subObjectives.find((sub) => sub.id === 'logic_test')?.status, 'covered');
  assert.deepEqual(row.risks, []);
}

export async function case10() {
  const currentEvidenceBinding = {
    headHash: 'head-current',
    materialHash: 'material-current',
    storyFilesHash: EMPTY_STORY_FILES_HASH,
  };
  const cl = {
    items: [
      checklistItem('CHK-EMPTY-STORY-FILES-HASH', 'done', [
        evidence('CHK-EMPTY-STORY-FILES-HASH:happy:0', 'pass', {
          headHash: 'head-current',
          materialHash: 'material-old',
          storyFilesHash: EMPTY_STORY_FILES_HASH,
        }),
      ], intent('empty story files hash is not an authoritative freshness signal')),
    ],
  };

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-empty-story-files-hash',
        sourceRequirementId: 'REQ-empty-story-files-hash',
        claim: 'Empty story files hash does not hide material drift',
        doneMeans: 'The empty-diff sentinel falls through to strict materialHash freshness',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-EMPTY-STORY-FILES-HASH'],
        verificationIntentRefs: ['CHK-EMPTY-STORY-FILES-HASH:happy:0'],
        status: 'done',
      }),
    ]),
    currentEvidenceBinding,
  });

  assert.deepEqual(report.groups.completed, []);
  assert.deepEqual(report.groups.current, ['M-empty-story-files-hash']);
  assert.deepEqual(report.groups.remaining, []);
  assert.match(report.risks.join('\n'), /stale materialHash/);
  assert.doesNotMatch(report.risks.join('\n'), /stale storyFilesHash/);

  const row = report.milestones.find((candidate) => candidate.id === 'M-empty-story-files-hash');
  assert.ok(row);
  assert.equal(row.status, 'current');
  assert.match(row.statusDetail, /evidence=stale/);
  assert.match(row.statusDetail, /requiredEvidence=missing/);
  assert.equal(row.subObjectives.find((sub) => sub.id === 'CHK-EMPTY-STORY-FILES-HASH:happy:0')?.status, 'stale-evidence');
  assert.equal(row.subObjectives.find((sub) => sub.id === 'logic_test')?.status, 'missing-evidence-kind');
  assert.match(row.risks.join('\n'), /stale materialHash/);
  assert.doesNotMatch(row.risks.join('\n'), /headHash/);
  assert.doesNotMatch(row.risks.join('\n'), /storyFilesHash/);
}

export async function case11() {
  const currentEvidenceBinding = {
    headHash: 'head-current',
    materialHash: 'material-current',
    storyFilesHash: 'story-current',
  };
  const cl = {
    items: [
      checklistItem('CHK-MATERIAL-STALE', 'done', [
        evidence('CHK-MATERIAL-STALE:happy:0', 'pass', {
          headHash: 'head-current',
          materialHash: 'material-old',
        }),
      ], intent('stale material-only evidence must not fall back to head')),
      checklistItem('CHK-STORY-STALE', 'done', [
        evidence('CHK-STORY-STALE:happy:0', 'pass', {
          headHash: 'head-current',
          storyFilesHash: 'story-old',
        }),
      ], intent('stale story-only evidence must not fall back to head')),
      checklistItem('CHK-MATERIAL-FRESH', 'done', [
        evidence('CHK-MATERIAL-FRESH:happy:0', 'pass', {
          headHash: 'head-old',
          materialHash: 'material-current',
        }),
      ], intent('fresh material-only evidence remains covering without storyFilesHash')),
      checklistItem('CHK-STORY-FRESH', 'done', [
        evidence('CHK-STORY-FRESH:happy:0', 'pass', {
          headHash: 'head-old',
          storyFilesHash: 'story-current',
        }),
      ], intent('fresh story-only evidence ignores head drift')),
    ],
  };

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-material-stale',
        sourceRequirementId: 'REQ-material-stale',
        claim: 'Material-only stale evidence must not complete',
        doneMeans: 'Comparable materialHash drift blocks even when storyFilesHash is absent',
        requiredEvidence: [],
        checklistRefs: ['CHK-MATERIAL-STALE'],
        verificationIntentRefs: ['CHK-MATERIAL-STALE:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-story-stale',
        sourceRequirementId: 'REQ-story-stale',
        claim: 'Story-files-only stale evidence must not complete',
        doneMeans: 'Comparable storyFilesHash drift blocks even when materialHash is absent',
        requiredEvidence: [],
        checklistRefs: ['CHK-STORY-STALE'],
        verificationIntentRefs: ['CHK-STORY-STALE:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-material-fresh',
        sourceRequirementId: 'REQ-material-fresh',
        claim: 'Material-only fresh evidence can complete',
        doneMeans: 'Comparable materialHash freshness covers when storyFilesHash is absent',
        requiredEvidence: [],
        checklistRefs: ['CHK-MATERIAL-FRESH'],
        verificationIntentRefs: ['CHK-MATERIAL-FRESH:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-story-fresh',
        sourceRequirementId: 'REQ-story-fresh',
        claim: 'Story-files-only fresh evidence can complete',
        doneMeans: 'Comparable storyFilesHash freshness is checked before head fallback',
        requiredEvidence: [],
        checklistRefs: ['CHK-STORY-FRESH'],
        verificationIntentRefs: ['CHK-STORY-FRESH:happy:0'],
        status: 'done',
      }),
    ]),
    currentEvidenceBinding,
  });

  assert.deepEqual(report.groups.completed, ['M-material-fresh', 'M-story-fresh']);
  assert.deepEqual(report.groups.current, ['M-material-stale']);
  assert.deepEqual(report.groups.remaining, ['M-story-stale']);

  const materialStale = report.milestones.find((candidate) => candidate.id === 'M-material-stale');
  const storyStale = report.milestones.find((candidate) => candidate.id === 'M-story-stale');
  const materialFresh = report.milestones.find((candidate) => candidate.id === 'M-material-fresh');
  const storyFresh = report.milestones.find((candidate) => candidate.id === 'M-story-fresh');
  assert.ok(materialStale);
  assert.ok(storyStale);
  assert.ok(materialFresh);
  assert.ok(storyFresh);

  assert.equal(materialStale.subObjectives.find((sub) => sub.id === 'CHK-MATERIAL-STALE:happy:0')?.status, 'stale-evidence');
  assert.match(materialStale.risks.join('\n'), /stale materialHash/);
  assert.doesNotMatch(materialStale.risks.join('\n'), /headHash/);
  assert.doesNotMatch(materialStale.risks.join('\n'), /storyFilesHash/);

  assert.equal(storyStale.subObjectives.find((sub) => sub.id === 'CHK-STORY-STALE:happy:0')?.status, 'stale-evidence');
  assert.match(storyStale.risks.join('\n'), /stale storyFilesHash/);
  assert.doesNotMatch(storyStale.risks.join('\n'), /headHash/);
  assert.doesNotMatch(storyStale.risks.join('\n'), /materialHash/);

  assert.equal(materialFresh.status, 'completed');
  assert.equal(materialFresh.subObjectives.find((sub) => sub.id === 'CHK-MATERIAL-FRESH:happy:0')?.status, 'covered');
  assert.doesNotMatch(materialFresh.risks.join('\n'), /headHash/);

  assert.equal(storyFresh.status, 'completed');
  assert.equal(storyFresh.subObjectives.find((sub) => sub.id === 'CHK-STORY-FRESH:happy:0')?.status, 'covered');
  assert.doesNotMatch(storyFresh.risks.join('\n'), /headHash/);
}

export async function case12() {
  const currentEvidenceBinding = {
    headHash: 'head-current',
    materialHash: 'material-current',
    storyFilesHash: 'story-current',
  };
  const cl = {
    items: [
      checklistItem('CHK-LEGACY-FRESH', 'done', [
        evidence('CHK-LEGACY-FRESH:happy:0', 'pass', {
          headHash: 'head-current',
        }),
      ], intent('legacy matching head evidence remains covering')),
      checklistItem('CHK-LEGACY-STALE', 'done', [
        evidence('CHK-LEGACY-STALE:happy:0', 'pass', {
          headHash: 'head-old',
        }),
      ], intent('legacy stale head evidence is rejected')),
    ],
  };

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-legacy-fresh',
        sourceRequirementId: 'REQ-legacy-fresh',
        claim: 'Legacy head-only evidence can complete through the fallback',
        doneMeans: 'Evidence lacking material/story hashes must match current head',
        requiredEvidence: [],
        checklistRefs: ['CHK-LEGACY-FRESH'],
        verificationIntentRefs: ['CHK-LEGACY-FRESH:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-legacy-stale',
        sourceRequirementId: 'REQ-legacy-stale',
        claim: 'Legacy stale head-only evidence must not complete',
        doneMeans: 'Evidence lacking material/story hashes falls back to head freshness',
        requiredEvidence: [],
        checklistRefs: ['CHK-LEGACY-STALE'],
        verificationIntentRefs: ['CHK-LEGACY-STALE:happy:0'],
        status: 'done',
      }),
    ]),
    currentEvidenceBinding,
  });

  assert.deepEqual(report.groups.completed, ['M-legacy-fresh']);
  assert.deepEqual(report.groups.current, ['M-legacy-stale']);
  const stale = report.milestones.find((candidate) => candidate.id === 'M-legacy-stale');
  assert.ok(stale);
  assert.equal(stale.subObjectives.find((sub) => sub.id === 'CHK-LEGACY-STALE:happy:0')?.status, 'stale-evidence');
  assert.match(stale.risks.join('\n'), /stale headHash/);
  assert.doesNotMatch(stale.risks.join('\n'), /missing materialHash/);
  assert.doesNotMatch(stale.risks.join('\n'), /missing storyFilesHash/);
}

export async function case13() {
  const cl = {
    items: [
      checklistItem('CHK-NOREF', 'done', [evidence('CHK-NOREF:happy:0')], intent('covered but unlinked')),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-no-checklistRefs',
        sourceRequirementId: 'REQ-no-checklistRefs',
        claim: 'No checklistRefs must not complete',
        doneMeans: 'Normal milestones require at least one valid checklistRef',
        requiredEvidence: [],
        checklistRefs: [],
        verificationIntentRefs: ['CHK-NOREF:happy:0'],
        status: 'done',
      }),
    ]),
  });

  assert.deepEqual(report.groups.completed, []);
  assert.deepEqual(report.groups.current, ['M-no-checklistRefs']);
  const row = report.milestones.find((candidate) => candidate.id === 'M-no-checklistRefs');
  assert.ok(row);
  assert.match(row.statusDetail, /checklist=missing/);
  assert.match(row.risks.join('\n'), /missing-checklistRefs/);
  assert.match(row.nextAction, /valid checklistRef/);
}
