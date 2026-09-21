import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';


import { DEFAULT_STORY_RELEVANCE_READERS, type StoryRelevanceInputArgs } from '../../core/validation-relevance-input.js';
import { captureEvidenceHashSnapshot, changedFileStatusesBetweenRenameAware, isMaterialExcludedPath, isStoryMetadataPath } from '../../core/evidence-freshness.js';



import { resolveValidationTierPlan } from '../../core/validation-tier-planner.js';

import { VALIDATION_PLAN_STATUS_LINES, buildValidationPlanReport, renderValidationPlanText, resolveValidationPlanRequest } from '../../handlers/validation-plan.js';













import { beginSection, testCase, collect, checklistItem, statusReader, fixtureHashSnapshot, FIXTURE_HEAD_SNAPSHOT, seedOf, throwingStatusReader, GIT_USAGE_DUMP, unavailableChangedFiles, temporaryRoots, LONG_GIT_USAGE_DUMP, planInput } from "./support.js";
export function runChangeInputs(): void {


beginSection('CHK-003 Story input collector cases');


// ---------------------------------------------------------------------------
// (17) POSITIVE — every input kind in the spec's table is collected, and every
//      seed records where it came from.
// ---------------------------------------------------------------------------
testCase('the collector gathers every Story input kind with per-seed provenance', () => {
  const input = collect({
    story: {
      storyId: 'B-a745',
      phase: 'DEV',
      riskSignals: [{ category: 'guard', matched: 'guard' }],
    },
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          files: { modify: ['src/core/machine-x.ts'], create: ['src/core/new-x.ts'], test: ['src/tasks/x-smoke.ts'] },
          verificationIntent: {
            happy: [{ desc: 'the planner explains its selection', type: 'cli', priority: 'must' }],
            edge: [],
            adversarial: [],
          },
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm test', result: 'pass', note: 'fixture evidence' },
          ],
        }),
      ],
    },
    readers: {
      changedFileStatuses: statusReader({ 'src/core/touched.ts': 'M' }),
      hashSnapshot: fixtureHashSnapshot,
    },
  });

  assert.equal(input.storyId, 'B-a745');
  assert.equal(input.phase, 'DEV');
  assert.equal(input.hashes.status, 'available');
  assert.equal(input.hashes.status === 'available' && input.hashes.head.headHash, FIXTURE_HEAD_SNAPSHOT.headHash);
  assert.equal(input.hashes.status === 'available' && input.hashes.head.materialHash, FIXTURE_HEAD_SNAPSHOT.materialHash);
  assert.equal(input.hashes.status === 'available' && input.hashes.head.storyFilesHash, FIXTURE_HEAD_SNAPSHOT.storyFilesHash);
  assert.equal(input.changedFiles.status, 'available');

  assert.deepEqual(seedOf(input, 'path', 'src/core/touched.ts')?.provenance, ['changed-file']);
  assert.deepEqual(seedOf(input, 'path', 'src/core/machine-x.ts')?.provenance, ['checklist-modify']);
  assert.deepEqual(seedOf(input, 'path', 'src/core/new-x.ts')?.provenance, ['checklist-create']);
  assert.deepEqual(seedOf(input, 'path', 'src/tasks/x-smoke.ts')?.provenance, ['checklist-test']);
  assert.deepEqual(seedOf(input, 'command', 'unit-suite')?.provenance, ['evidence-pin']);
  assert.deepEqual(seedOf(input, 'risk-signal', 'guard')?.provenance, ['risk-signal']);
  for (const seed of input.seeds) {
    assert.ok(seed.provenance.length > 0, `seed ${seed.kind}:${seed.value} must record its provenance`);
  }

  assert.equal(input.pinnedCommands.length, 1);
  assert.equal(input.pinnedCommands[0].commandId, 'unit-suite');
  assert.equal(input.pinnedCommands[0].itemId, 'CHK-001');
  assert.equal(input.executionInventory.sourceKind, 'configured');
  assert.deepEqual(input.executionInventory.commandIds, ['unit-suite', 'lint-suite']);
  assert.ok(input.executionInventory.commandSetDigest.length === 64);
  assert.equal(input.escalations.length, 0);
});


testCase('the collector defaults to the SHARED rename-aware reader and the shared hash snapshot', () => {
  // The injectable readers exist for the failure fixture below; the DEFAULTS must
  // still be the canonical shared readers, so the collector never grows its own
  // git access path alongside `core/evidence-freshness.ts`.
  assert.equal(
    DEFAULT_STORY_RELEVANCE_READERS.changedFileStatuses,
    changedFileStatusesBetweenRenameAware,
    'changed paths must come from the shared rename-aware reader',
  );
  assert.equal(
    DEFAULT_STORY_RELEVANCE_READERS.hashSnapshot,
    captureEvidenceHashSnapshot,
    'hashes must come from the shared evidence hash snapshot reader',
  );
});


// ---------------------------------------------------------------------------
// (18) DELETE + RENAME — a deleted path stays a seed and BOTH sides of a rename
//      stay seeds. The spec states both rules explicitly.
// ---------------------------------------------------------------------------
testCase('a deleted path remains a seed and a rename contributes both old and new paths', () => {
  const input = collect({
    readers: {
      changedFileStatuses: statusReader({
        'src/core/removed.ts': 'D',
        'src/core/old-name.ts': 'R100',
        'src/core/new-name.ts': 'R100',
      }),
      hashSnapshot: fixtureHashSnapshot,
    },
  });
  const deleted = seedOf(input, 'path', 'src/core/removed.ts');
  assert.ok(deleted, 'a deleted file must remain a seed');
  assert.equal(deleted!.changeStatus, 'D');
  assert.equal(deleted!.deleted, true);
  assert.ok(seedOf(input, 'path', 'src/core/old-name.ts'), 'the rename source must remain a seed');
  assert.ok(seedOf(input, 'path', 'src/core/new-name.ts'), 'the rename destination must remain a seed');
});


// ---------------------------------------------------------------------------
// (19) EXCLUSION uses the CANONICAL classifier, never a local allowlist.
// ---------------------------------------------------------------------------
testCase('story metadata and registered runtime artifacts are excluded by the canonical classifier', () => {
  const metadataPath = '.proof-or-stop/story/actives/B-a745/index.json';
  const runtimeArtifactPath = '.proof-or-stop/activity.jsonl';
  const materialPath = 'src/core/machine-x.ts';
  // Guard the fixture itself against drifting away from the canonical rule.
  assert.equal(isStoryMetadataPath(metadataPath), true);
  assert.equal(isMaterialExcludedPath(runtimeArtifactPath), true);
  assert.equal(isMaterialExcludedPath(materialPath), false);

  const input = collect({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          files: { modify: [metadataPath], create: [], test: [] },
        }),
      ],
    },
    readers: {
      changedFileStatuses: statusReader({ [runtimeArtifactPath]: 'M', [materialPath]: 'M' }),
      hashSnapshot: fixtureHashSnapshot,
    },
  });

  assert.equal(seedOf(input, 'path', metadataPath), undefined, 'story metadata is not a material seed');
  assert.equal(seedOf(input, 'path', runtimeArtifactPath), undefined, 'a registered runtime artifact is not a material seed');
  assert.ok(seedOf(input, 'path', materialPath), 'real material must still seed');
  const excluded = input.excludedPaths.map((entry) => entry.path).sort();
  assert.deepEqual(excluded, [runtimeArtifactPath, metadataPath].sort());
  assert.equal(input.excludedPaths.find((entry) => entry.path === metadataPath)?.reason, 'story-metadata');
  assert.equal(input.excludedPaths.find((entry) => entry.path === runtimeArtifactPath)?.reason, 'runtime-artifact');
});


// ---------------------------------------------------------------------------
// (20) READ FAILURE (load-bearing) — a failure to read changed files is
//      `changed_files_unavailable`, NEVER an empty array. The second half of the
//      case is what makes a `catch { return [] }` implementation FAIL: an
//      honestly empty diff must stay `available` with no escalation, so the two
//      states can never be conflated.
// ---------------------------------------------------------------------------
testCase('a changed-file read failure is changed_files_unavailable, never an empty seed set', () => {
  const failed = collect({
    readers: { changedFileStatuses: throwingStatusReader, hashSnapshot: fixtureHashSnapshot },
  });
  assert.equal(failed.changedFiles.status, 'changed_files_unavailable');
  assert.notEqual(failed.changedFiles.status, 'available', 'a read failure must never be reported as a clean diff');
  assert.match(
    failed.changedFiles.status === 'changed_files_unavailable' ? failed.changedFiles.error : '',
    /bad revision/,
    'the underlying reader error must be preserved',
  );
  const escalation = failed.escalations.find((entry) => entry.code === 'changed_files_unavailable');
  assert.ok(escalation, 'a read failure must escalate');
  assert.ok((escalation!.detail ?? '').length > 0, 'the escalation must carry a human-readable detail');

  const empty = collect({
    readers: { changedFileStatuses: statusReader({}), hashSnapshot: fixtureHashSnapshot },
  });
  assert.equal(empty.changedFiles.status, 'available', 'an honestly empty diff is available, not unavailable');
  assert.deepEqual(
    empty.escalations.filter((entry) => entry.code === 'changed_files_unavailable'),
    [],
    'an empty diff must not escalate',
  );
  assert.notEqual(
    failed.selectionDigest,
    empty.selectionDigest,
    'an unreadable diff and an empty diff must not produce the same planning input',
  );
});


testCase('an unreadable changed-file set escalates with a bounded classification, not a git usage dump', () => {
  const failed = collect({
    readers: {
      changedFileStatuses: () => {
        throw new Error(GIT_USAGE_DUMP);
      },
      hashSnapshot: fixtureHashSnapshot,
    },
  });
  assert.equal(failed.changedFiles.status, 'changed_files_unavailable');

  const escalation = failed.escalations.find((entry) => entry.code === 'changed_files_unavailable');
  assert.ok(escalation, 'a read failure must still escalate');
  const detail = escalation!.detail;

  assert.equal(detail.includes('\n'), false, `the operator-facing detail must be ONE line, got:\n${detail}`);
  assert.ok(detail.length <= 300, `the detail must stay readable, got ${detail.length} characters`);
  for (const leak of ['usage: git diff', '--diff-filter', '--output-indicator-new', '--numstat', '--find-renames']) {
    assert.equal(detail.includes(leak), false, `the raw git usage text leaked into the detail: ${leak}`);
  }
  assert.match(detail, /not a git repository/i, 'the detail must CLASSIFY the failure in plain language');
  assert.match(detail, /NOT the same as an empty diff|nothing is known/i, 'the detail must keep saying what the failure means');

  // The raw error is preserved for diagnosis — bounding the detail must not
  // destroy the underlying evidence.
  const changed = unavailableChangedFiles(failed);
  assert.ok(
    changed.error.includes('usage: git diff'),
    'the raw reader error must still be preserved on the structured result for diagnosis',
  );

  // The classification is a structured fact, not something re-derived from prose.
  assert.equal(changed.reason, 'not-a-git-repository');
  assert.equal(changed.summary.includes('\n'), false, 'the structured summary must itself be one line');
});


testCase('every changed-file failure classification stays one bounded sentence', () => {
  const cases: Array<{ error: unknown; reason: string; match: RegExp }> = [
    { error: new Error(GIT_USAGE_DUMP), reason: 'not-a-git-repository', match: /not a git repository/i },
    {
      error: new Error("Command failed: git diff --name-status -M main..HEAD\nfatal: bad revision 'main..HEAD'"),
      reason: 'unknown-revision',
      match: /revision/i,
    },
    {
      error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
      reason: 'git-unavailable',
      match: /git executable/i,
    },
    { error: new Error(`boom ${'x'.repeat(4000)}`), reason: 'unknown', match: /boom/ },
    { error: 'a bare string failure', reason: 'unknown', match: /bare string/ },
  ];
  for (const entry of cases) {
    const failed = collect({
      readers: {
        changedFileStatuses: () => {
          throw entry.error;
        },
        hashSnapshot: fixtureHashSnapshot,
      },
    });
    const changed = unavailableChangedFiles(failed);
    assert.equal(changed.reason, entry.reason, `misclassified: ${String(entry.error)}`);
    assert.equal(changed.summary.includes('\n'), false, 'the summary must be one line');
    assert.ok(changed.summary.length <= 200, `the summary must be bounded, got ${changed.summary.length}`);
    assert.match(changed.summary, entry.match);
    const detail = failed.escalations.find((item) => item.code === 'changed_files_unavailable')!.detail;
    assert.equal(detail.includes('\n'), false, 'the detail must be one line');
    assert.ok(detail.length <= 300, `the detail must be bounded, got ${detail.length}`);
  }

  // A reader that breaks its contract without throwing is classified too.
  const nonObject = collect({
    readers: { changedFileStatuses: (() => 'nope') as never, hashSnapshot: fixtureHashSnapshot },
  });
  assert.equal(unavailableChangedFiles(nonObject).reason, 'reader-contract-violation');
});


testCase('the REAL reader outside a git repository yields a bounded detail end to end', () => {
  const outsideRepo = mkdtempSync(join(tmpdir(), 'proof-or-stop-not-a-repo-'));
  temporaryRoots.push(outsideRepo);
  const failed = collect({
    projectRoot: outsideRepo,
    gitCwd: outsideRepo,
    readers: { changedFileStatuses: DEFAULT_STORY_RELEVANCE_READERS.changedFileStatuses, hashSnapshot: fixtureHashSnapshot },
  });
  assert.equal(
    failed.changedFiles.status,
    'changed_files_unavailable',
    'the real reader must fail outside a repository rather than report a clean diff',
  );
  const detail = failed.escalations.find((entry) => entry.code === 'changed_files_unavailable')!.detail;
  assert.equal(detail.includes('\n'), false, `the real-world detail must be ONE line, got:\n${detail}`);
  assert.ok(detail.length <= 300, `the real-world detail must stay readable, got ${detail.length} characters`);
  assert.equal(detail.includes('usage: git diff'), false, 'the real git usage dump must never reach the operator');
});


testCase('the planner renders a bounded changed_files_unavailable detail, never the raw git usage dump', () => {
  assert.ok(LONG_GIT_USAGE_DUMP.split('\n').length >= 40, 'the fixture must be a realistic multi-screen dump');
  const input = planInput({
    readers: {
      changedFileStatuses: () => {
        throw new Error(LONG_GIT_USAGE_DUMP);
      },
      hashSnapshot: fixtureHashSnapshot,
    },
  });
  const changed = unavailableChangedFiles(input);
  assert.equal(changed.reason, 'not-a-git-repository');
  assert.ok(changed.error.includes('--word-diff-regex'), 'the raw error must remain on the structured object for diagnosis');

  const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
  assert.equal(result.status, 'plan');
  const reason = result.escalationReasons.find((entry) => entry.code === 'changed_files_unavailable');
  assert.ok(reason, 'the planner must still escalate the unreadable changed-file set');
  const detail = reason!.detail;
  assert.equal(detail.includes('\n'), false, `the planner detail must be ONE line, got:\n${detail}`);
  assert.ok(detail.length <= 300, `the planner detail must stay readable, got ${detail.length} characters`);
  assert.ok(detail.includes(changed.summary), `the detail must carry the bounded summary "${changed.summary}", got: ${detail}`);
  assert.match(detail, /not-a-git-repository/, 'the detail must carry the machine classification');
  for (const line of LONG_GIT_USAGE_DUMP.split('\n').map((entry) => entry.trim()).filter((entry) => entry.length > 12)) {
    assert.equal(detail.includes(line), false, `a raw git usage line leaked into the planner detail: ${line}`);
  }

  // End to end through the renderer: the escalation stays one `detail:` line and
  // the status discriminator is still a line of its own.
  const request = resolveValidationPlanRequest({ storyId: 'B-a745', tier: 'fast' });
  const rendered = renderValidationPlanText(
    buildValidationPlanReport({ request, storyPhase: 'DEV', input, result }),
    true,
  );
  const lines = rendered.split('\n');
  assert.ok(lines.includes(VALIDATION_PLAN_STATUS_LINES.plan), 'the status line must remain a line of its own');
  const detailLines = lines.filter((line) => line.startsWith('    detail: '));
  assert.ok(detailLines.length >= result.escalationReasons.length, 'every escalation renders exactly one detail line');
  for (const line of detailLines) {
    assert.ok(line.length <= 320, `a rendered detail line is not one bounded line: ${line.length} characters`);
  }
  assert.equal(rendered.includes('usage: git diff'), false, 'the git usage dump must never reach the rendered output');
  assert.equal(rendered.includes('--word-diff-regex'), false, 'the git usage dump must never reach the rendered output');
});


testCase('a hash snapshot failure is classified, not silently dropped', () => {
  const input = collect({
    readers: {
      changedFileStatuses: statusReader({}),
      hashSnapshot: () => {
        throw new Error('fatal: not a git repository');
      },
    },
  });
  assert.equal(input.hashes.status, 'hash_snapshot_unavailable');
  assert.ok(input.escalations.some((entry) => entry.code === 'hash_snapshot_unavailable'));
});


// ---------------------------------------------------------------------------
// (20d) EVERY OTHER FAILURE PROSE IS BOUNDED (B-a745 F-016, second and third
//       sites). The same rule as the changed-file detail applies to the hash
//       snapshot escalation and to the duration-history read failure that the
//       report's `basis` line renders: raw error on the structured object only,
//       one bounded line in the prose.
// ---------------------------------------------------------------------------
testCase('a hash snapshot failure escalates with a bounded one-line detail, never the raw dump', () => {
  const input = planInput({
    readers: {
      changedFileStatuses: statusReader({}),
      hashSnapshot: () => {
        throw new Error(LONG_GIT_USAGE_DUMP);
      },
    },
  });
  assert.equal(input.hashes.status, 'hash_snapshot_unavailable');
  assert.ok(
    input.hashes.status === 'hash_snapshot_unavailable' && input.hashes.error.includes('--word-diff-regex'),
    'the raw error must remain on the structured hashes object for diagnosis',
  );
  const escalation = input.escalations.find((entry) => entry.code === 'hash_snapshot_unavailable');
  assert.ok(escalation, 'a hash snapshot failure must still escalate');
  const detail = escalation!.detail;
  assert.equal(detail.includes('\n'), false, `the hash snapshot detail must be ONE line, got:\n${detail}`);
  assert.ok(detail.length <= 300, `the hash snapshot detail must be bounded, got ${detail.length} characters`);
  assert.match(detail, /not a git repository/i, 'the detail must CLASSIFY the failure in plain language');
  for (const line of LONG_GIT_USAGE_DUMP.split('\n').map((entry) => entry.trim()).filter((entry) => entry.length > 12)) {
    assert.equal(detail.includes(line), false, `a raw git usage line leaked into the hash snapshot detail: ${line}`);
  }

  const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
  const request = resolveValidationPlanRequest({ storyId: 'B-a745', tier: 'fast' });
  const rendered = renderValidationPlanText(
    buildValidationPlanReport({ request, storyPhase: 'DEV', input, result }),
    true,
  );
  assert.ok(rendered.split('\n').includes(VALIDATION_PLAN_STATUS_LINES[result.status]), 'the status line must remain a line of its own');
  assert.equal(rendered.includes('usage: git diff'), false, 'the git usage dump must never reach the rendered output');
});


testCase('a duration-history read failure renders a bounded one-line basis, never the raw dump', () => {
  const dump = ['Error: ENOENT: no such file or directory, open \'/repo/.proof-or-stop/validation/receipts.json\'']
    .concat(Array.from({ length: 40 }, (_, index) => `    at frame${index} (/repo/node_modules/some-module/index.js:${index + 1}:1)`))
    .join('\n');
  const input = planInput({
    durationHistory: {
      read: () => {
        throw new Error(dump);
      },
    },
  });
  assert.equal(input.durationHistory.status, 'unavailable');
  assert.ok(
    (input.durationHistory.readError ?? '').includes('at frame39'),
    'the raw read error must remain on the structured duration history for diagnosis',
  );
  const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
  assert.equal(result.status, 'plan');
  const request = resolveValidationPlanRequest({ storyId: 'B-a745', tier: 'fast' });
  const report = buildValidationPlanReport({ request, storyPhase: 'DEV', input, result });
  const basis = report.durationEstimate.basis;
  assert.equal(basis.includes('\n'), false, `the duration basis must be ONE line, got:\n${basis}`);
  assert.ok(basis.length <= 300, `the duration basis must be bounded, got ${basis.length} characters`);
  assert.match(basis, /ENOENT|could not be read/i, 'the basis must still say what went wrong');
  assert.equal(basis.includes('at frame'), false, 'a stack frame leaked into the duration basis');

  const rendered = renderValidationPlanText(report, true);
  const lines = rendered.split('\n');
  assert.ok(lines.includes(VALIDATION_PLAN_STATUS_LINES.plan), 'the status line must remain a line of its own');
  const basisLines = lines.filter((line) => line.startsWith('  basis: '));
  assert.equal(basisLines.length, 1, 'exactly one basis line must be rendered');
  assert.ok(basisLines[0].length <= 320, `the rendered basis line is not one bounded line: ${basisLines[0].length}`);
  assert.equal(rendered.includes('at frame'), false, 'a stack frame leaked into the rendered output');
});


testCase('a malformed evidence pin is reported as one bounded unclassified-input line', () => {
  const input = planInput({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            {
              intentRef: 'CHK-001:happy:0',
              kind: 'integration_test',
              // A non-string commandId beside a real command string: the pin is
              // present, and the resolver's runtime re-validation rejects it.
              commandId: 42 as never,
              command: 'npm test',
              result: 'pass',
              note: 'fixture evidence with a malformed commandId',
            },
          ],
        }),
      ],
    },
  });
  const malformed = input.unclassifiedInputs.find((entry) => entry.kind === 'evidence-pin' && /malformed pin/.test(entry.detail));
  assert.ok(malformed, 'a non-string commandId must be reported as a malformed pin');
  assert.equal(malformed!.detail.includes('\n'), false, 'the malformed-pin detail must be one line');
  assert.ok(malformed!.detail.length <= 300, `the malformed-pin detail must be bounded, got ${malformed!.detail.length}`);
});


// ---------------------------------------------------------------------------
// (21) DURATION HISTORY — collected from prior signed validation artifacts.
//      Absent history is UNKNOWN-duration, never zero.
// ---------------------------------------------------------------------------
testCase('duration history is collected and an absent history reports unknown-duration, never zero', () => {
  const input = collect({
    durationHistory: {
      artifacts: [
        {
          storyId: 'B-a745',
          status: 'PASS',
          receipts: [
            { label: 'unit', command: 'npm', args: ['test'], durationMs: 4000 },
            { label: 'unit', command: 'npm', args: ['test'], durationMs: 6000 },
          ],
        },
      ],
    },
  });
  assert.equal(input.durationHistory.status, 'collected');
  const unit = input.durationHistory.estimates.find((entry) => entry.commandId === 'unit-suite');
  assert.ok(unit, 'the matched command must carry an estimate');
  assert.equal(unit!.status, 'known');
  assert.equal(unit!.sampleCount, 2);
  assert.equal(typeof unit!.estimateMs, 'number');
  assert.ok((unit!.basis ?? '').length > 0, 'an estimate must name its basis');

  const lint = input.durationHistory.estimates.find((entry) => entry.commandId === 'lint-suite');
  assert.ok(lint, 'a command with no history must still be reported');
  assert.equal(lint!.status, 'unknown-duration');
  assert.equal(lint!.sampleCount, 0);
  assert.equal(lint!.estimateMs, undefined, 'no history must never be reported as a duration');
  assert.equal(
    Object.prototype.hasOwnProperty.call(lint!, 'estimateMs'),
    false,
    'an unknown duration must not even carry the key, so no reader can coerce it to 0',
  );

  const none = collect();
  for (const estimate of none.durationHistory.estimates) {
    assert.equal(estimate.status, 'unknown-duration');
    assert.equal(estimate.sampleCount, 0);
  }
});


// ---------------------------------------------------------------------------
// (22) ADVERSARIAL — duration history is ESTIMATE-ONLY: mutating it can never
//      change what would be selected.
// ---------------------------------------------------------------------------
testCase('mutating duration history leaves the selected set and the selection digest unchanged', () => {
  const seedsArgs: Partial<StoryRelevanceInputArgs> = {
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          files: { modify: ['src/core/machine-x.ts'], create: [], test: [] },
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm test', result: 'pass', note: 'fixture evidence' },
          ],
        }),
      ],
    },
    readers: {
      changedFileStatuses: statusReader({ 'src/core/touched.ts': 'M' }),
      hashSnapshot: fixtureHashSnapshot,
    },
  };
  const withoutHistory = collect(seedsArgs);
  const withHistory = collect({
    ...seedsArgs,
    durationHistory: {
      artifacts: [
        {
          storyId: 'B-a745',
          status: 'PASS',
          receipts: [
            { label: 'unit', command: 'npm', args: ['test'], durationMs: 999_999 },
            { label: 'lint', command: 'npm', args: ['run', 'lint'], durationMs: 1 },
          ],
        },
      ],
    },
  });

  assert.deepEqual(withHistory.seeds, withoutHistory.seeds, 'duration data must not change the seed set');
  assert.deepEqual(
    withHistory.pinnedCommands,
    withoutHistory.pinnedCommands,
    'duration data must not change pinned commands',
  );
  assert.deepEqual(
    withHistory.executionInventory.commandIds,
    withoutHistory.executionInventory.commandIds,
    'duration data must not change the execution inventory',
  );
  assert.equal(
    withHistory.selectionDigest,
    withoutHistory.selectionDigest,
    'the selection digest must be computed WITHOUT duration history, so an estimate can never widen or narrow selection',
  );
  assert.notDeepEqual(
    withHistory.durationHistory.estimates,
    withoutHistory.durationHistory.estimates,
    'the fixture must actually vary the duration data it claims cannot matter',
  );
});


// ---------------------------------------------------------------------------
// (23) ADVERSARIAL — verification intent is REASON CONTEXT only: on its own it
//      produces no command-to-seed edge. The spec: "never parsed as the only
//      machine mapping".
// ---------------------------------------------------------------------------
testCase('verification intent is carried as reason context and produces no command-to-seed edge', () => {
  const intentOnly = collect({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationIntent: {
            happy: [{ desc: 'npm test passes for the unit suite', type: 'cli', priority: 'must' }],
            edge: [{ desc: 'lint-suite still runs when config is absent', type: 'cli', priority: 'must' }],
            adversarial: [],
          },
        }),
      ],
    },
  });
  assert.equal(intentOnly.verificationIntentContext.length, 2, 'intent must be carried for the explain output');
  assert.equal(intentOnly.verificationIntentContext[0].itemId, 'CHK-001');
  assert.equal(intentOnly.verificationIntentContext[0].lane, 'happy');
  assert.match(intentOnly.verificationIntentContext[0].desc, /unit suite/);
  assert.deepEqual(
    intentOnly.commandSeedEdges,
    [],
    'intent text naming a command must NOT create a command-to-seed edge on its own',
  );
  assert.deepEqual(intentOnly.pinnedCommands, [], 'intent is not a pin');
  assert.deepEqual(
    intentOnly.seeds.filter((seed) => seed.kind === 'command'),
    [],
    'intent must not seed a command',
  );

  const withoutIntent = collect({
    checklist: { items: [checklistItem({ id: 'CHK-001' })] },
  });
  assert.equal(
    intentOnly.selectionDigest,
    withoutIntent.selectionDigest,
    'intent must be outside the selection digest: it is reason context, never a machine mapping',
  );

  // Every edge that DOES exist must be attributable to a machine pin.
  const pinned = collect({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm test', result: 'pass', note: 'fixture evidence' },
          ],
        }),
      ],
    },
  });
  assert.equal(pinned.commandSeedEdges.length, 1);
  assert.equal(pinned.commandSeedEdges[0].origin, 'evidence-pin');
  assert.equal(pinned.commandSeedEdges[0].commandId, 'unit-suite');
  for (const edge of pinned.commandSeedEdges) {
    assert.equal(edge.origin, 'evidence-pin', 'the ONLY command-to-seed edge origin is a machine-resolved pin');
  }
});


testCase('an unresolvable evidence pin is classified by what it claimed, not silently dropped', () => {
  const legacy = collect({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm run gone', result: 'pass', note: 'fixture evidence' },
          ],
        }),
      ],
    },
  });
  assert.deepEqual(legacy.pinnedCommands, []);
  assert.ok(legacy.escalations.some((entry) => entry.code === 'pinned_command_non_inventory'));
  assert.ok(!legacy.escalations.some((entry) => entry.code === 'pinned_command_missing'));
  assert.ok(legacy.unclassifiedInputs.some((entry) => entry.kind === 'evidence-pin'));
  assert.deepEqual(legacy.commandSeedEdges, [], 'a non-inventory pin may never seed a command');

  const declared = collect({
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            {
              intentRef: 'CHK-001:happy:0',
              kind: 'integration_test',
              commandId: 'gone-suite',
              command: 'npm run gone',
              result: 'pass',
              note: 'fixture evidence',
            },
          ],
        }),
      ],
    },
  });
  assert.deepEqual(declared.pinnedCommands, []);
  assert.ok(declared.escalations.some((entry) => entry.code === 'pinned_command_missing'));
  assert.deepEqual(declared.commandSeedEdges, []);
});


// ---------------------------------------------------------------------------
// (24) Handler encoding convention: the collector re-validates its own inputs,
//      because a schema is only the first line of defence.
// ---------------------------------------------------------------------------
testCase('the collector re-validates a schema-bypassing caller input', () => {
  assert.throws(
    () => collect({ story: { storyId: '   ', phase: 'DEV' } }),
    /storyId/,
    'an empty storyId must be rejected at the collector entry',
  );
  assert.throws(
    () => collect({ routine: { sourceKind: 'nonsense' as never, commands: [] } }),
    /sourceKind/,
    'an unknown routine source kind must be rejected at the collector entry',
  );
});
}
